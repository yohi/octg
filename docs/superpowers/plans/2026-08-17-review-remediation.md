# Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover crash-stale upstream concurrency leases, preserve fail-closed quota accounting on streaming cleanup failures, expose a safe operator disposition path for `reserve_unknown`, and remove the verified documentation and regression-test gaps.

**Architecture:** Durable Object in-flight state becomes a versioned collection of leases with an opaque generation and expiry. The Worker passes the generation to release calls and renews an active SSE lease independently of chunk arrival; renewal failure aborts the stream and marks quota uncertain best-effort. Operator reconciliation routes directly to the canonical quota Durable Object using pool/day parameters and only dispositions a `reserve_unknown` entry discovered in that DO snapshot. D1 remains audit metadata, never the quota authority.

**Tech Stack:** TypeScript strict, Cloudflare Workers, Durable Objects with SQLite-backed storage, D1, Vitest, `@cloudflare/vitest-pool-workers`.

## Global Constraints

- The Durable Object remains authoritative for quota and in-flight state; D1 is audit and locator metadata only.
- A stale release must never delete a newer lease for the same request ID.
- An expired lease may be reclaimed only after its TTL; active SSE leases must renew independently of response chunks.
- Settlement, uncertainty marking, and lease cleanup failures must not mask the original failure or trigger an unsafe quota refund.
- `reserve_unknown` must remain excluded from aggregate Usage API inference; `unused` requires explicit operator evidence.
- Do not add a local-only canary correlation ID because it cannot match Worker-generated request IDs.
- Do not add `as any`, `@ts-ignore`, `@ts-expect-error`, or non-null assertions.

---

### Task 1: Versioned in-flight lease state and generation fencing

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `durable-objects/quota-controller/src/store.ts`
- Modify: `durable-objects/quota-controller/src/quota-controller.ts`
- Modify: `apps/gateway-worker/wrangler.jsonc`
- Modify: `apps/gateway-worker/src/index.ts`
- Modify: `apps/gateway-worker/src/proxy.ts`
- Test: `apps/gateway-worker/test/quota-controller.test.ts`

**Interfaces:**
- Produces `InFlightLease`, `AcquireInFlightResult`, `RenewInFlightResult`, and `ReleaseInFlightResult` in `@octg/shared`.
- Produces `QuotaController.acquireInFlight(requestId, limit, ttlMs)`, `renewInFlight(requestId, generation, ttlMs)`, and `releaseInFlight(requestId, generation?)`.
- Uses `IN_FLIGHT_LEASE_TTL_MS` with a default of `120000` and `IN_FLIGHT_LEASE_RENEWAL_MS` with a default of `30000`.

- [ ] **Step 1: Add failing lease lifecycle tests**
  - Assert a successful acquire returns a generation and expiry.
  - Assert a repeated acquire for an unexpired request returns the same generation without consuming another slot.
  - Assert an expired lease is removed during the next acquire and capacity is reusable.
  - Assert a new lease generation is returned after expiry and an old generation cannot renew or release it.
  - Assert renewal extends an active lease but cannot revive an expired lease.
  - Assert legacy persisted string-array entries remain releasable by the old request-ID-only call during the migration window.

- [ ] **Step 2: Run the focused lease tests and confirm the new cases fail**

Run: `npm test -w apps/gateway-worker -- --run test/quota-controller.test.ts`

Expected: the new expiry, generation, renewal, and result-shape assertions fail before implementation.

- [ ] **Step 3: Implement versioned storage and RPC methods**
  - Persist `{ version: 1, leases: [{ requestId, generation, expiresAtMs }] }` under `IN_FLIGHT_KEY`.
- Read the existing `string[]` representation with a finite default grace TTL, persist the normalized versioned state on first access, and keep request-ID-only release compatibility during that grace period.
  - In one transaction, remove expired records before checking the limit or same-request idempotency.
  - Generate generations with `crypto.randomUUID()`.
  - Require matching generation for new release and renewal calls; return a no-op result for missing or stale releases.
  - Validate TTL values as positive safe integers and use the shared default when an old caller omits TTL.

- [ ] **Step 4: Update Worker configuration and proxy lease ownership**
  - Add the two lease timing bindings to `Env` and `wrangler.jsonc`.
  - Resolve invalid configuration to the safe defaults.
  - Store the returned generation in the request-scoped proxy state.
  - Pass the generation to every normal release and outer error cleanup; transfer ownership to `proxyStream` only after stream construction succeeds.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `npm test -w apps/gateway-worker -- --run test/quota-controller.test.ts test/proxy-failures.test.ts && npm run typecheck`

Expected: focused tests and all workspace type checks pass.

---

### Task 2: Streaming renewal and fail-closed finalization

**Files:**
- Modify: `apps/gateway-worker/src/stream.ts`
- Modify: `apps/gateway-worker/src/proxy.ts`
- Test: `apps/gateway-worker/test/stream.test.ts`

**Interfaces:**
- `proxyStream` consumes a generation-bearing lease plus TTL and renewal interval.
- The upstream body is aborted when renewal fails; finalization remains idempotent.

- [ ] **Step 1: Add failing stream tests**
  - Reserve a real request before settlement-failure finalization and assert `markUncertain` is attempted before lease release.
  - Assert a rejected `markUncertain` still releases the generation-matched lease and preserves the original error.
  - Assert an idle stream renews without receiving a chunk, and normal completion stops renewal.
  - Assert renewal failure aborts the stream, marks the request uncertain best-effort, releases the lease, and propagates the renewal error.

- [ ] **Step 2: Run the focused stream tests and confirm the new cases fail**

Run: `npm test -w apps/gateway-worker -- --run test/stream.test.ts`

Expected: the new uncertainty and renewal assertions fail against the current implementation.

- [ ] **Step 3: Implement generation-aware renewal**
  - Start an independent timer after a stream acquires its lease; do not depend on SSE chunks.
  - Call `renewInFlight(requestId, generation, ttlMs)` at the configured interval.
  - Abort the pipe and schedule finalization when renewal fails.
  - Clear the timer on every finalization path.

- [ ] **Step 4: Implement finalization fallback**
  - On settlement or uncertainty-marking exceptions, call `markUncertain(requestId).catch(...)` before generation-matched release.
  - Keep audit completion best-effort.
  - Preserve and rethrow the first meaningful error; cleanup errors must not replace it.

- [ ] **Step 5: Run stream and proxy regression tests**

Run: `npm test -w apps/gateway-worker -- --run test/stream.test.ts test/proxy.test.ts test/proxy-failures.test.ts`

Expected: all stream, proxy success, and proxy failure tests pass.

---

### Task 3: Safe operator disposition for `reserve_unknown`

**Files:**
- Modify: `apps/gateway-worker/src/admin.ts`
- Modify: `apps/gateway-worker/src/reconcile.ts`
- Modify: `durable-objects/quota-controller/src/quota-controller.ts`
- Modify: `durable-objects/quota-controller/src/quota-lifecycle.ts`
- Modify: `apps/gateway-worker/test/admin-api.test.ts`
- Modify: `apps/gateway-worker/test/reconcile.test.ts`
- Add: `db/migrations/0005_add_reconciliation_evidence.sql`

**Interfaces:**
- Keep `POST /admin/reconcile` aggregate behavior unchanged.
- Add `POST /admin/reconcile/{pool}/{utcDay}/{requestId}` with JSON `{ "disposition": "consumed" | "unused", "evidence"?: string }`.
- Only a DO snapshot entry with `state: "uncertain"` and `uncertaintyOrigin: "reserve_unknown"` is eligible.

- [ ] **Step 1: Add failing Admin API tests**
  - Reject malformed pool/day/request/disposition input with 400.
  - Require non-empty bounded evidence for `unused`; allow explicit `consumed` without inferring from aggregate usage.
  - Resolve a seeded `reserve_unknown` entry through the canonical DO and verify quota state changes only once.
  - Reject a missing, already terminal, or non-`reserve_unknown` entry without mutating quota.
  - Verify D1 completion is best-effort and cannot make a successful DO disposition fail.

- [ ] **Step 2: Run the focused Admin tests and confirm the new cases fail**

Run: `npm test -w apps/gateway-worker -- --run test/admin-api.test.ts test/reconcile.test.ts`

Expected: the new route and validation tests fail because the route does not exist.

- [ ] **Step 3: Implement direct DO routing and validation**
  - Validate the canonical pool and UTC day from the path, then obtain the DO with `quotaIdOf(pool, utcDay)`.
  - Read `getReconcileSnapshot()` and require the target `reserve_unknown` entry before invoking `reconcileRequest()`.
  - Map `consumed`/`unused` to the existing DO disposition contract; never call ordinary `release()`.
  - Return an idempotent result for the same disposition and a conflict for an opposite disposition.
  - Update the matching D1 audit row and bounded operator evidence best-effort after DO success; do not use D1 token values for the quota mutation.

- [ ] **Step 4: Run focused reconciliation tests**

Run: `npm test -w apps/gateway-worker -- --run test/admin-api.test.ts test/reconcile.test.ts test/quota-lifecycle.test.ts`

Expected: aggregate reconciliation still leaves `reserve_unknown` open, while the explicit route resolves only the selected DO entry.

---

### Task 4: Documentation and regression-test cleanup

**Files:**
- Modify: `docs/superpowers/plans/2026-08-14-worker-input-limit.md`
- Modify: `docs/superpowers/specs/2026-08-16-worker-resource-limits-remediation-design.md`
- Modify: `apps/gateway-worker/test/quota-controller.test.ts`
- Modify: `scripts/canary-worker-resource-limits.mjs`
- Test: `scripts/canary-worker-resource-limits.test.mjs`

- [ ] **Step 1: Strengthen the idempotency regression test**
  - Acquire request-one twice, release it once, acquire request-two, issue the stale duplicate release for request-one, then assert request-three is rejected at limit one.

- [ ] **Step 2: Mark the old input-limit plan as superseded**
  - Add a notice at the beginning directing implementation to the 2026-08-15 one-MiB plan and explicitly identify the 131072-byte value as historical.

- [ ] **Step 3: Correct the remediation flow contract**
  - Separate safety-gate rejection into 400 `invalid_request` before the unexpected-estimation/reserve catch.
  - Keep unexpected estimation and reserve failures at 500 `internal_error`.

- [ ] **Step 4: Run documentation lint and focused tests**

Run: `npm test -w apps/gateway-worker -- --run test/quota-controller.test.ts` and the repository's configured Markdown validation command if available.

Expected: the strengthened test passes and the documentation no longer contradicts the error table.

---

### Task 5: Full verification, review, and delivery

**Files:**
- No additional files.

- [ ] **Step 1: Run diagnostics on every changed TypeScript file**

Run `lsp_diagnostics` for all changed TypeScript files and resolve every diagnostic introduced by this work.

- [ ] **Step 2: Run the complete verification suite**

Run: `npm test && npm run typecheck`

Expected: all workspace tests and type checks pass.

- [ ] **Step 3: Run the CodeRabbit review again**

Run: `coderabbit review --agent`

Expected: the accepted runtime findings are gone; the canary fallback finding remains intentionally unimplemented and is documented in the delivery summary if still reported.

- [ ] **Step 4: Inspect the final diff and secret boundary**

Run `git status`, `git diff`, and a targeted secret-pattern scan. Confirm only intended files changed and no credentials or payloads are present.

- [ ] **Step 5: Commit and push the feature branch**

Use a Japanese Conventional Commit message:

```bash
git add \
  packages/shared/src/types.ts \
  durable-objects/quota-controller/src/store.ts \
  durable-objects/quota-controller/src/quota-controller.ts \
  apps/gateway-worker/wrangler.jsonc \
  apps/gateway-worker/src/index.ts \
  apps/gateway-worker/src/proxy.ts \
  apps/gateway-worker/src/stream.ts \
  apps/gateway-worker/src/admin.ts \
  apps/gateway-worker/src/reconcile.ts \
  apps/gateway-worker/test/quota-controller.test.ts \
  apps/gateway-worker/test/stream.test.ts \
  apps/gateway-worker/test/admin-api.test.ts \
  apps/gateway-worker/test/reconcile.test.ts \
  db/migrations/0005_add_reconciliation_evidence.sql \
  docs/superpowers/plans/2026-08-14-worker-input-limit.md \
  docs/superpowers/specs/2026-08-16-worker-resource-limits-remediation-design.md \
  docs/superpowers/plans/2026-08-17-review-remediation.md \
  scripts/canary-worker-resource-limits.mjs \
  scripts/canary-worker-resource-limits.test.mjs
git commit -m "fix: レビュー指摘の状態回復と精算経路を修正"
git push
```
