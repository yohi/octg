# Task A2 report — Entrypoint regression coverage

## Pre-edit coverage map

| Route / guard | Existing coverage before edits | Status |
|---|---|---|
| `quota` route | `relay-cpu-gate.test.ts`: authenticated quota snapshot and overflowing/invalid-day path coverage in related request tests | Covered |
| `slot` route | `relay-cpu-gate.test.ts`: slot lifecycle, environment-invalid 503, and DO assertions | Covered |
| `setup` route | `relay-cpu-gate.test.ts`: successful setup, compensation, collision, busy, and unavailable paths | Covered |
| `setup-fence` route | `relay-cpu-gate.test.ts`: recovery fence and delayed-admission tests | Covered |
| `decision-context` route | `relay-cpu-gate.test.ts`: signed decision context and no admission | Covered |
| `operation-inspection` route | `relay-cpu-gate.test.ts`: inspection before/after fence and invalid ID | Covered |
| `reconcile-unused` route | `relay-cpu-gate.test.ts`: live, absent, terminal, and non-fixture operations | Covered |
| `close-operation` route | `relay-cpu-gate.test.ts`: stale/current generation close and invalid runtime environment | Covered |
| Disabled control → 404 before DO lookup | Missing control token and service-equal control token tested; invalid token and ingress-equal token absent | Missing: disabled invalid/ingress-equal control cases with no `idFromName` call |
| Enabled control, absent bearer → 401 before DO lookup | `relay-cpu-gate.test.ts`: absent bearer test asserts status 401 and no `idFromName` | Covered |
| Enabled control, wrong bearer → 401 before DO lookup | Existing test uses service bearer and asserts status 401 and no `idFromName` | Covered |
| `quota` / `slot` wrong method → 405, `Allow: GET` | No test found | Missing: method assertions for both GET-only endpoints |
| `setup` wrong method → 405, `Allow: POST` | No test found | Missing: method and `Allow` assertion |
| Internal returned error carries worker version | `relay-version-headers.test.ts`: unauthenticated `slot` and `setup` requests assert version header on outer responses; no authenticated returned-error route test | Missing: assert header on internal returned 4xx/503 |
| Public `POST /v1/responses` version-header behavior | Existing `relay-client.test.ts`: real Worker relay route response asserts the `X-OCTG-Worker-Version` value | Covered (verified by a focused rerun below) |

This map was recorded before modifying tests. The existing `relay-client.test.ts` assertion corrected the initial uncertainty about public Responses coverage; no test was needed there. No production code changes were made.

## Files changed

- `apps/gateway-worker/test/relay-cpu-gate.test.ts`
  - Assert missing, invalid, and ingress-equal disabled-control cases return 404 without `idFromName`.
  - Assert wrong presented bearer and absent bearer return 401 without `idFromName` (existing assertions retained).
  - Assert POST to `quota`/`slot` returns 405 with `Allow: GET`, and GET to `setup` returns 405 with `Allow: POST`; each asserts no DO identity lookup.
- `apps/gateway-worker/test/relay-version-headers.test.ts`
  - Assert a quota handler's returned 400 carries a nonempty Worker version header. This is an internal returned response, not an `index.ts` catch-generated 500.
- `.superpowers/sdd/2026-10-27-octg-drift-remediation-master-plan/task-A2-report.md`
  - This coverage map and run report.

## Verification output

`npm run test --workspace @octg/gateway-worker -- test/relay-cpu-gate.test.ts test/relay-version-headers.test.ts`

```text
Test Files  3 passed (3)
Tests       38 passed (38)
Duration    3.64s
```

`npm run test --workspace @octg/gateway-worker -- test/relay-client.test.ts`

```text
Test Files  1 passed (1)
Tests       24 passed (24)
Duration    3.01s
```

`npm run typecheck`

```text
Deno task check: deno check src/main.ts test/*.test.ts
@octg/gateway-worker: tsc -p tsconfig.json
@octg/quota-controller: tsc -p tsconfig.json
@octg/tokenizer-controller: tsc -p tsconfig.json
@octg/shared: tsc -p tsconfig.json
Exit status: 0
```

## Concerns

- No observed test failure contradicted SPEC §19.7; production code was not changed.
- The focused test command reports 3 passing test files, although only the two requested paths were supplied (the Vitest setup also included its configured setup file as a test file).
- Version-header assertion covers a returned 400; the existing `relay-version-headers.test.ts` checks that outer-routed internal unauthorized errors carry a version header. The outer `index.ts` catch-generated 500 is intentionally not asserted.
- Public `/v1/responses` version-header regression was confirmed by the existing integration assertion in `relay-client.test.ts` (24 tests rerun and passed).
- No assertions rely on Workerd stream pull/cancel transport behavior; denial is established via status and zero `idFromName` calls. No credential/body logging assertions were added because there is no relevant observable log contract in these tests.
