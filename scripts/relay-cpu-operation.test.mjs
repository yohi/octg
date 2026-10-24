import { strict as assert } from "node:assert";
import { test } from "node:test";
import { runFixtureLifecycle, recoverSharedOperation, isTerminalFixture } from "./relay-cpu-operation.mjs";

const owner = { pool: "MINI", requestId: "req_fixture" };
const terminal = { kind: "fixture", cpuGateFixture: true, state: "reconciled_unused", requestState: "released", actualTokens: null, activeLease: false };
const inspection = (value) => ({ version: 1, kind: "fixture", inspection: value });

test("successful setup returns its grant without fencing or reconciling it", async () => {
  const grant = { version: 1, ...owner, grantToken: "test-grant", grantId: "g", leaseGeneration: "generation-1", admissionUtcDay: "2026-10-24" };
  const result = await runFixtureLifecycle({ ...owner, adapters: {
    setup: async (input) => { assert.deepEqual(input, { version: 1, ...owner }); return grant; },
    setupFence: async () => { assert.fail("successful setup must not be fenced"); },
  } });
  assert.equal(result.kind, "ready");
  assert.equal(result.fixture.grantCredential, "test-grant");
});

test("lost setup ack is fenced once and proven absent without retrying setup", async () => {
  const events = [];
  const result = await runFixtureLifecycle({ ...owner, adapters: {
    setup: async () => { events.push("setup"); throw new Error("lost ack"); },
    setupFence: async () => { events.push("fence"); return { version: 1, ...owner, kind: "fenced" }; },
    inspectOperation: async () => { events.push("inspect"); return { version: 1, kind: "absent" }; },
  } });
  assert.equal(result.kind, "closed");
  assert.deepEqual(events, ["setup", "fence", "inspect"]);
});

test("ambiguous fixture is reconciled and re-inspected, never treated as a usable grant", async () => {
  let reconciled = false;
  const result = await runFixtureLifecycle({ ...owner, adapters: {
    setup: async () => ({ version: 1, error: "setup_state_ambiguous" }),
    setupFence: async () => ({ version: 1, kind: "fixture", inspection: { ...terminal, state: "authorized", activeLease: true } }),
    inspectOperation: async () => inspection(reconciled ? terminal : { ...terminal, state: "authorized", activeLease: true }),
    reconcileUnused: async () => { reconciled = true; return { version: 1, kind: "reconciled_unused" }; },
  } });
  assert.equal(result.kind, "closed");
  assert.equal(reconciled, true);
});

test("non-fixture, failed reconciliation and unproven terminal state block recovery", async () => {
  for (const state of [{ kind: "non_fixture" }, { ...terminal, activeLease: true, state: "authorized" }]) {
    const result = await runFixtureLifecycle({ ...owner, adapters: {
      setup: async () => ({ version: 1, error: "setup_state_ambiguous" }),
      setupFence: async () => ({ version: 1, kind: state.kind, inspection: state }),
      inspectOperation: async () => inspection(state),
      reconcileUnused: async () => ({ version: 1, error: "setup_state_ambiguous" }),
    } });
    assert.equal(result.kind, "blocked");
  }
});

test("singleton recovery queries slot before loading journal and proves idle after close", async () => {
  const events = [];
  let closed = false;
  const result = await recoverSharedOperation({ loadJournal: async () => { events.push("journal"); return []; }, adapters: {
    readSharedSlot: async () => { events.push("slot"); return { version: 1, slot: closed ? { kind: "idle" } : { kind: "held", owner, generation: 3 } }; },
    setupFence: async () => ({ version: 1, kind: "fixture", inspection: terminal }),
    inspectOperation: async () => inspection(terminal),
    closeOperation: async (input) => { assert.deepEqual(input, { version: 1, ...owner, generation: 3 }); closed = true; events.push("close"); return { version: 1, kind: "closed" }; },
  } });
  assert.equal(result.kind, "idle");
  assert.deepEqual(events, ["slot", "journal", "close", "slot"]);
});

test("idle singleton still recovers a journal entry from a crashed runner", async () => {
  const events = [];
  const result = await recoverSharedOperation({ journal: [{ ...owner, state: "setup_pending" }], adapters: {
    readSharedSlot: async () => ({ version: 1, slot: { kind: "idle" } }),
    setupFence: async () => { events.push("fence"); return { version: 1, kind: "fenced" }; },
    inspectOperation: async () => ({ version: 1, kind: "absent" }),
  } });
  assert.equal(result.kind, "idle");
  assert.deepEqual(events, ["fence"]);
});

test("stale journal generation never closes the current owner's slot", async () => {
  const result = await recoverSharedOperation({ journal: [{ ...owner, generation: 2 }], adapters: {
    readSharedSlot: async () => ({ version: 1, slot: { kind: "held", owner, generation: 3 } }),
    closeOperation: async () => { assert.fail("stale owner must not close"); },
  } });
  assert.equal(result.kind, "blocked");
});

test("terminal proof accepts exactly the canonical grant/request state combinations", () => {
  for (const [state, requestState] of [
    ["settled", "settled"], ["released", "released"], ["reconciled_consumed", "reconciled"],
    ["reconciled_consumed", "settled"], ["reconciled_unused", "released"],
  ]) assert.equal(isTerminalFixture({ ...terminal, state, requestState }), true);
  for (const [state, requestState] of [
    ["settled", "released"], ["released", "settled"], ["reconciled_consumed", "released"], ["reconciled_unused", "settled"],
  ]) assert.equal(isTerminalFixture({ ...terminal, state, requestState }), false);
});
