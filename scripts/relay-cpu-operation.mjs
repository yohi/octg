const LIVE_STATES = new Set(["authorized", "attempted", "uncertain"]);
const TERMINAL_STATES = new Set(["settled", "released", "reconciled_consumed", "reconciled_unused"]);

export function isTerminalFixture(inspection) {
  return inspection?.kind === "fixture" && inspection.cpuGateFixture === true
    && TERMINAL_STATES.has(inspection.state) && inspection.activeLease === false
    && (inspection.state === "settled" && inspection.requestState === "settled"
      || inspection.state === "released" && inspection.requestState === "released"
      || inspection.state === "reconciled_consumed" && ["reconciled", "settled"].includes(inspection.requestState)
      || inspection.state === "reconciled_unused" && inspection.requestState === "released");
}

function operationInput(owner) {
  if (!["MINI", "STANDARD"].includes(owner.pool) || typeof owner.requestId !== "string" || !owner.requestId) {
    throw new TypeError("CPU-gate operation identity missing");
  }
  return { version: 1, pool: owner.pool, requestId: owner.requestId };
}

/** Recover by ID, never by retrying admission or inventing a replacement grant. */
export async function recoverFixture({ pool, requestId, adapters }) {
  try {
    const input = operationInput({ pool, requestId });
    const fence = await adapters.setupFence(input);
    if (fence?.version !== 1 || !["fenced", "fixture"].includes(fence.kind)) return { kind: "blocked" };
    let body = await adapters.inspectOperation(input);
    if (body?.version === 1 && body.kind === "absent" && fence.kind === "fenced") return { kind: "closed" };
    if (body?.version !== 1 || body.kind !== "fixture" || body.inspection?.cpuGateFixture !== true) return { kind: "blocked" };
    if (!isTerminalFixture(body.inspection)) {
      if (!LIVE_STATES.has(body.inspection.state)) return { kind: "blocked" };
      const reconciled = await adapters.reconcileUnused(input);
      if (reconciled?.version !== 1 || reconciled.kind !== "reconciled_unused") return { kind: "blocked" };
      body = await adapters.inspectOperation(input);
      if (body?.inspection?.state !== "reconciled_unused" || body.inspection.actualTokens !== null) return { kind: "blocked" };
    }
    return isTerminalFixture(body?.inspection) ? { kind: "closed" } : { kind: "blocked" };
  } catch {
    return { kind: "blocked" };
  }
}

export async function runFixtureLifecycle({ pool, requestId, adapters }) {
  const input = operationInput({ pool, requestId });
  let setup;
  try { setup = await adapters.setup(input); } catch { /* Admission acknowledgement is ambiguous. */ }
  if (setup?.version === 1 && setup.requestId === requestId && setup.pool === pool
    && typeof setup.grantToken === "string" && setup.grantToken.length > 0
    && typeof setup.grantId === "string" && typeof setup.leaseGeneration === "string" && setup.leaseGeneration.length > 0
    && /^\d{4}-\d{2}-\d{2}$/.test(setup.admissionUtcDay)) {
    return { kind: "ready", fixture: { ...setup, grantCredential: setup.grantToken } };
  }
  // A denial may still follow a singleton claim. Keep it recoverable by ID.
  return recoverFixture({ ...input, adapters });
}

/** Close only this operation; a concurrently claimed different owner is untouched. */
export async function closeOwnedOperation({ operation, adapters, requireSlot = false }) {
  try {
    if (requireSlot) {
      const envelope = await adapters.readSharedSlot();
      const slot = envelope?.version === 1 ? envelope.slot : undefined;
      if (!slot || !["idle", "held", "closing"].includes(slot.kind)) return { kind: "blocked" };
      if (slot.kind !== "idle") {
        if (slot.owner?.pool !== operation.pool || slot.owner?.requestId !== operation.requestId
          || !Number.isSafeInteger(slot.generation) || slot.generation < 1
          || (operation.generation != null && operation.generation !== slot.generation)) return { kind: "blocked" };
        operation.generation = slot.generation;
        const recovered = await recoverSharedOperation({ journal: [operation], adapters });
        return recovered.kind === "idle" ? { kind: "closed" } : { kind: "blocked" };
      }
    }
    const target = await recoverFixture({ ...operation, adapters });
    if (target.kind !== "closed") return { kind: "blocked" };
    operation.state = "closed";
    return { kind: "closed" };
  } catch { return { kind: "blocked" }; }
}

export async function recoverSharedOperation({ journal, loadJournal, adapters }) {
  try {
    // The shared authority must be read before any local journal is consulted.
    const envelope = await adapters.readSharedSlot();
    const slot = envelope?.version === 1 ? envelope.slot : undefined;
    if (!slot || !["idle", "held", "closing"].includes(slot.kind)) return { kind: "blocked", reason: "slot-unavailable" };
    const operations = loadJournal ? await loadJournal() : journal ?? [];
    if (!Array.isArray(operations)) return { kind: "blocked", reason: "journal-invalid" };
    let owner;
    if (slot.kind !== "idle") {
      owner = slot.owner;
      if (!owner || !Number.isSafeInteger(slot.generation) || slot.generation < 1) return { kind: "blocked", reason: "slot-invalid" };
      const local = operations.find((entry) => entry.pool === owner.pool && entry.requestId === owner.requestId);
      if (local?.generation != null && local.generation !== slot.generation) return { kind: "blocked", reason: "journal-generation-mismatch" };
      if (local) local.generation = slot.generation;
      const proof = await recoverFixture({ ...owner, adapters });
      if (proof.kind !== "closed") return { kind: "blocked", reason: "owner-not-terminal" };
      const closed = await adapters.closeOperation({ ...operationInput(owner), generation: slot.generation });
      if (closed?.version !== 1 || closed.kind !== "closed") return { kind: "blocked", reason: "close-not-proven" };
      const idle = await adapters.readSharedSlot();
      if (idle?.version !== 1 || idle.slot?.kind !== "idle") return { kind: "blocked", reason: "slot-not-idle" };
      if (local) local.state = "closed";
    }
    for (const entry of operations) {
      if (entry.state === "closed") continue;
      const proof = await recoverFixture({ ...entry, adapters });
      if (proof.kind !== "closed") return { kind: "blocked", reason: "journal-operation-not-terminal" };
      entry.state = "closed";
    }
    return { kind: "idle", ...(owner ? { owner: { ...owner, generation: slot.generation } } : {}), operations };
  } catch {
    return { kind: "blocked", reason: "recovery-unavailable" };
  }
}
