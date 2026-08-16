# Task 1 Report: Versioned in-flight leases

## Scope

- Base commit: `fff51043e67204cca0716278914ee8a23334a9ae`
- Branch: `feature/issue-33-responses-text-compat__base`
- Modified implementation and test files are limited to the eight files listed in the Task 1 brief.
- The pre-existing untracked `docs/superpowers/plans/2026-08-17-review-remediation.md` was not modified.

## Implementation decisions

1. `@octg/shared` now exposes `InFlightLease`, acquire/renew/release result types, and shared defaults of 120,000 ms (lease TTL) and 30,000 ms (renewal interval).
2. Durable Object storage writes `{ version: 1, leases: [...] }`. Each new lease has a UUID generation and millisecond expiry.
3. The existing `string[]` state is read as non-expiring migration leases. Its legacy empty generation permits request-ID-only release; new leases require a matching generation.
4. `acquireInFlight`, `renewInFlight`, and `releaseInFlight` run storage lifecycle logic inside the Durable Object transaction. Acquire removes expired entries before it evaluates idempotency or capacity. Renewal and release also discard expired entries before deciding their result.
5. A stale or absent release returns `{ ok: true, released: false }`. A stale renewal returns `stale_generation`; an expired or absent lease returns `lease_not_found`.
6. Worker TTL bindings are validated as positive safe integers and otherwise use the shared defaults. The proxy retains the acquired lease generation and supplies it to every normal and outer-error cleanup release. Stream ownership moves only after `proxyStream` returns a constructed response.

## Evidence

- Expired leases are pruned transactionally: the `prunes expired leases transactionally before reusing capacity` lifecycle test acquires a one-slot, one-millisecond lease, advances time, and proves a different request acquires the same slot without a release.
- Stale generations cannot modify replacements: the `fences a replacement lease from the expired generation` lifecycle test proves an old generation cannot renew or release the replacement and that the slot remains saturated.
- Legacy string arrays remain releasable: the `releases legacy string-array entries with the request-ID-only compatibility call` test seeds `in_flight` with a legacy array through `runInDurableObject(..., state.storage)` and proves request-ID-only release frees the slot.

## Tests run

### TDD RED

```text
npm test -w apps/gateway-worker -- --run test/quota-controller.test.ts
```

Result before production implementation: 31 tests total, 9 expected failures for missing lease result fields, expiry pruning, generation fencing, renewal, legacy release result, and TTL persistence protection.

```text
npm test -w apps/gateway-worker -- --run test/proxy-failures.test.ts
```

Result before production implementation: 28 tests total, 3 expected failures for missing lease timing resolvers and generation-aware outer cleanup.

### Final verification

```text
npm test -w apps/gateway-worker -- --run test/quota-controller.test.ts test/proxy-failures.test.ts && npm run typecheck
```

Result: 2 test files passed; 59 tests passed; `@octg/gateway-worker`, `@octg/quota-controller`, and `@octg/shared` typechecks passed.

## Concerns

- No blocking concern.
- Task 2 must pass the acquired generation into `proxyStream` and use the renewal interval for stream lifecycle ownership. Task 1 intentionally leaves those timer and stream changes out of scope.
- Test-file LSP output includes the existing `cloudflare:test` deprecation hints for `env` and `SELF`; final workspace typecheck passes.

## Fix round 1

### Implementation decisions

1. `proxyStream` now receives the acquired `InFlightLease` rather than a request ID. It derives the request ID and generation from that lease and passes both to all three stream finalization releases. `handleProxy` transfers the same lease only after `proxyStream` constructs its response.
2. `acquireInFlightLease` and `renewInFlightLease` now load storage first, then capture exactly one transaction-local `nowMs`. The value is shared by expiry calculation and expiry pruning, so an async storage read cannot produce a lease already expired at the pruning instant.
3. The outer cleanup release is routed through `releaseInFlightBestEffort`, which takes a narrow `Pick<QuotaController, "releaseInFlight">` contract. Its test uses a `satisfies` fake and asserts the exact request ID and generation without a type assertion.
4. Stream tests acquire and release generation-bearing leases and assert the new acquire result shape before testing replacement capacity.

### TDD RED

```text
npm test -w apps/gateway-worker -- --run test/quota-controller.test.ts test/stream.test.ts
```

Result before implementation: 2 test files failed; 5 tests failed and 31 passed. The four stream finalization tests could not acquire a replacement lease, and the async-storage boundary test received `expiresAtMs: 1001` instead of the required `1002`.

### Focused GREEN

```text
npm test -w apps/gateway-worker -- --run test/quota-controller.test.ts test/stream.test.ts test/proxy-failures.test.ts
```

Result: 3 test files passed; 64 tests passed.

### Final verification

```text
npm test -w apps/gateway-worker && npm run typecheck
```

Result: 20 gateway-worker test files passed; 170 tests passed. Typechecks passed for `@octg/gateway-worker`, `@octg/quota-controller`, and `@octg/shared`.

### Fix-round concerns

- No blocking concern. The renewal timer remains intentionally unimplemented.
- The reviewed double assertion was removed. Two pre-existing `as unknown as DurableObjectStub<QuotaController>` uses remain in the unrelated fail-closed reserve-outcome tests at `proxy-failures.test.ts:362` and `:392`; this round did not alter them to avoid expanding scope.
