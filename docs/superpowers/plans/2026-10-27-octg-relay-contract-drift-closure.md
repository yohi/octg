# OCTG Relay v1 / CPU-gate Contract Drift Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the confirmed active `SPEC.md` ↔ internal HTTP implementation contract drift (`NEG-001`) without changing any public or production runtime behavior.

**Architecture:** Treat `/internal/relay/v1/cpu-gate/*` as a separately scoped, authenticated CPU-gate *control-plane extension*, not an unannounced addition to the closed Deno Relay v1 callback wire contract. Preserve the existing interfaces; add an explicit normative exception/contract and executable documentation-to-code checks. Do not treat this documentation correction as Stage 1/Stage 2 CPU acceptance.

**Tech Stack:** Markdown, Node.js >=22 (`node:test`), TypeScript 5.6, Vitest/Cloudflare Workers tests.

**Spec:** `SPEC.md` §1 and §19; `docs/superpowers/specs/2026-10-05-worker-free-cpu-headroom-redesign.md` §§Stage 2 CPU-gate control, Production/Preview isolation, Completion criteria. **Fixed audit baseline:** `0ac76d5727018ee47e01935022d59581039a87d2` (2026-10-27 JST). This plan does not supersede the existing `2026-10-05-worker-free-cpu-headroom-redesign.md` plan.

## Global Constraints

- `SPEC.md` is authoritative for active OCTG behavior; `docs/superpowers/` may contain approved but not yet enabled rollout targets. A merged plan is not proof of an accepted CPU gate.
- Treat the CPU-gate route inventory as a **closed eight-route contract**. The independent frozen expected routes, source `ROUTES` constant, and exact SPEC §19.7 route list must all match, including route names/methods and duplicate checks. Do not derive the frozen inventory from either source being compared.
- Scope `X-OCTG-Worker-Version` attribution to an internal relay handler's **returned `Response`**, including intentionally returned error Responses (4xx, 500, 503). The outer `index.ts` exception catcher can synthesize a 500 **without** passing through internal response attribution. Do not assert coverage for that uncaught exception path or silently expand runtime guarantees in a documentation-sync change.
- Preserve Relay v1 callback/ingress path, method, content type, header and envelope rules (including `POST` only for *the v1 ingress/callback protocol*). Do **not** relabel CPU-gate `GET` control routes as Relay v1 callbacks.
- Preserve all public `/v1/responses`, `/v1/chat/completions`, quota and model behavior, existing error mapping and prior compat guarantees; no client-facing header changes.
- Preserve `QuotaController` as sole quota/grant authority; D1 is not quota authority. No production/Preview cross-resource access.
- CPU-gate control bearer `OCTG_RELAY_CPU_GATE_AUTH_TOKEN` is distinct from service and ingress bearers. Absent, malformed or equal-to-service/ingress bearer => control route 404; wrong supplied bearer while enabled => 401 before body or DO lookup.
- Preserve current route inventory: `quota`, `slot`, `setup`, `setup-fence`, `decision-context`, `operation-inspection`, `reconcile-unused`, `close-operation` under `/internal/relay/v1/cpu-gate/`.
- Control request body maximum `8,192` bytes; `quota` and `slot` GET, remaining routes POST. Avoid logging credentials/payloads; version metadata identifies only **stateless Worker** version, not DO version.
- No Cloudflare remote API, deployment, secret mutation, CI rerun, PR/merge or Human Owner decision is authorized by writing or executing this plan alone.

## Review Focus

1. Absent/invalid/equal-to-service-or-ingress gate secret must yield 404 *without application-level body read/cancel or DO lookup*. Enabled control with missing/wrong bearer must yield 401 with the same no-body/no-DO property. Preserve status and `idFromName` assertions. Test owner: Task 2.
2. Valid control secret with wrong supplied bearer must yield 401 *before DO lookup*. Test owner: Task 2.
3. `GET` CPU-gate `quota|slot` must never relax the `POST`-only **Relay v1 callback** contract. Test owner: Task 1.
4. `X-OCTG-Worker-Version` is guaranteed on **returned** internal handler Responses, including explicitly returned error Responses, but not on an exception translated into an outer `index.ts` catch-generated 500. Never confuse it with DO code-version proof or a public response header. Test owner: Tasks 1–2.
5. No authority is inferred from PR merge, checked task box or CI SUCCESS: Stage 1/2 gate proof remains separate. Test owner: Task 3.

---

## File and Interface Map

| File | Role |
| --- | --- |
| `SPEC.md` | Current normative Relay v1 wire contract plus explicit separately scoped CPU-gate control-plane extension and version attribution |
| `scripts/documentation-contract.test.mjs` | Machine-checkable documentation contract/regression cases |
| `apps/gateway-worker/test/relay-cpu-gate.test.ts` | Existing entrypoint authorization, route and method regression tests; add only missing cases |
| `apps/gateway-worker/test/relay-version-headers.test.ts` | Existing stateless Worker version-identity tests; extend only if a documented negative case lacks coverage |
| `docs/operations.md` | Operator scope/rollout limitation reference; concise pointer only |
| `apps/gateway-worker/src/index.ts`, `relay-cpu-gate.ts`, `relay-auth.ts`, `version-metadata.ts` | Reference implementation; no change planned |

### Task 1: Make the CPU-gate extension explicit in the active normative SPEC

**Files:** Modify `SPEC.md` around §19.1–19.6; modify `scripts/documentation-contract.test.mjs`.

**Interfaces:** Consumes active normative §19 and CPU-gate route set from `apps/gateway-worker/src/relay-cpu-gate.ts`. Produces a separate section, named `### 19.7 Internal CPU-gate control-plane extension`, without widening the closed Deno Relay v1 wire envelope.

- [ ] **Step 1: Write RED documentation tests.** Add a `node:test` test named `SPEC distinguishes closed relay v1 callbacks from CPU-gate control routes`. Define **one independent immutable expected inventory** in the test: `quota`, `slot`, `setup`, `setup-fence`, `decision-context`, `operation-inspection`, `reconcile-unused`, `close-operation` (fully qualified under `/internal/relay/v1/cpu-gate/`; `quota`/`slot` GET, the other six POST). Parse the literal `ROUTES` tuple from `apps/gateway-worker/src/relay-cpu-gate.ts` and parse **only the exact route table/list in `SPEC.md` §19.7**, not incidental mentions across the document. Fail on missing source/spec sections, duplicates, extra routes, missing routes, wrong methods or parse ambiguity. Assert **three-way equality**: frozen expected inventory == source `ROUTES` == SPEC §19.7 routes (with methods independently checked against the frozen mapping). The test's expected inventory must not be generated from source or SPEC: even an identically wrong addition to both must fail without an explicitly reviewed test-contract change. Also assert SPEC: (a) separates closed callbacks/control plane; (b) specifies distinct bearer, 404/401 ordering, 8,192-byte body limit, no direct DO storage mutation and stateless-only version attribution; (c) preserves POST-only Relay v1 callbacks; and (d) limits `X-OCTG-Worker-Version` to handler-returned internal Responses, including returned error statuses, **not** outer catch-generated 500 errors. Keep existing documentation contract tests unchanged.
- [ ] **Step 2: Verify RED.** Run `node --test scripts/documentation-contract.test.mjs`. Expected: new SPEC-extension assertion fails against baseline; pre-existing tests retain status.
- [ ] **Step 3: Write the minimal SPEC update.** Clarify §19's prohibition of unannounced Relay v1 wire fields/headers/routes; an explicitly specified CPU-gate control plane is not a Deno ingress or lifecycle callback. Add `§19.7` with the exact eight full paths/methods as a uniquely parsable, bounded route table, control bearer behavior, body/error rules, requestId/fixture-scoped mutation, fail-closed semantics, and an explicit non-claim for Stage 1/2 readiness. Define `X-OCTG-Worker-Version` as the internal stateless Worker attribution header (`local` in non-deployed tests), **added by the `index.ts` wrapper when a relay handler returns a Response, including its 4xx/500/503 error responses**. The outer `index.ts` `catch` currently generates a separate generic 500 without that wrapper; SPEC must neither claim the header there nor treat it as evidence for DO code version or CPU PASS. Broader exception-path attribution requires a separately scoped code/spec decision; no public API or legacy callback change is authorized here.
- [ ] **Step 4: Verify GREEN.** Run `node --test scripts/documentation-contract.test.mjs`. Expected: all checks pass, including new parity assertions.
- [ ] **Step 5: Commit boundary (execution-time only).** `git add SPEC.md scripts/documentation-contract.test.mjs && git commit -m "docs: synchronize relay cpu control-plane contract"`. A new reviewer must confirm that the revision is a contract sync, not tacit Security/Stage Gate approval.

### Task 2: Anchor the extension to actual Worker routing and denial behavior

**Files:** Modify `apps/gateway-worker/test/relay-cpu-gate.test.ts` and/or `apps/gateway-worker/test/relay-version-headers.test.ts` **only if** the named assertions do not already exist; `apps/gateway-worker/src/index.ts`, `relay-auth.ts`, `relay-cpu-gate.ts`, `version-metadata.ts` are review-only unless a specific failing test proves code drift.

**Interfaces:** Consumes §19.7 from Task 1. Produces tests for the real `SELF.fetch` Worker entrypoint covering control routes and unchanged callbacks.

- [ ] **Step 1: Write a coverage map before editing.** Map each eight-route method and auth guard to current tests. Record `covered` or a concrete missing test name; don't add duplicate tests.
- [ ] **Step 2: Add missing failing cases (if any).** Preserve the existing `SELF.fetch` status and DO-call assertions: disabled control (missing/invalid/equal to service or ingress bearer) -> 404; enabled control with absent/wrong presented bearer -> 401; for every negative case, `env.QUOTA_CONTROLLER.idFromName` is not called. Add POST request fixtures with **instrumented `ReadableStream` bodies** for each denial path and record observed stream `pull`/`cancel` counts. To prove **application-level** no-read/no-cancel before auth, instrument `Request.body.getReader()` and the returned reader's `read()`/`cancel()` at a directly invoked `handleRelayCpuGate` boundary where those calls can be reliably attributed; require zero for both on denied requests and preserve existing `SELF.fetch` integration status/DO checks. A producer-side `pull()` or `cancel()` caused by `Request` construction, structured cloning or `SELF.fetch` transport is **not** automatically a handler `read()`/`cancel()`; add an integration count assertion only if a small local harness check establishes that these counters reflect handler reads/cancels rather than transport behavior, otherwise record that limitation and keep the direct-handler zero-call proof. Retain `quota|slot` wrong-method 405 `Allow: GET`, `setup` wrong-method 405 `Allow: POST`, and no public `/v1/responses` version-header regression. Verify nonempty `X-OCTG-Worker-Version` on internal **returned** 4xx/500/503 Responses (using an existing deterministic returned-error fixture where feasible); do **not** require it on an uncaught exception reaching the outer `index.ts` catch-generated 500. Do not log credentials or body bytes.
- [ ] **Step 3: Verify RED only for newly asserted unimplemented behavior.** Run `npm run test --workspace @octg/gateway-worker -- test/relay-cpu-gate.test.ts test/relay-version-headers.test.ts`; for already implemented guard ordering and response attribution, passing regression tests are expected. Do not introduce an artificial runtime failure, or equate Workerd stream transport behavior with a handler-level violation. If stream-counter attribution cannot be made reliable, document the harness limit, retain `SELF.fetch` coverage, and use the direct-handler read/cancel proof as the negative test.
- [ ] **Step 4: Implement the minimal fix only if a concrete test contradicts current §19.7.** Keep semantics, response codes, observability and quota authority unchanged; if expected behavior differs from live code, stop for a separately reviewed spec-versus-code decision before editing production behavior.
- [ ] **Step 5: Verify GREEN.** Run `npm test` and `npm run typecheck`. Expected: zero failures; distinguish successful local tests from real-host behavior.
- [ ] **Step 6: Commit boundary (execution-time only).** Commit only changed tests and any separately authorized minimal implementation correction; no speculative refactor.

### Task 3: Reconcile documentation and perform independent handoff

**Files:** Modify `docs/operations.md` only if the current Stage 1 subsection lacks a pointer to §19.7; otherwise this task produces review evidence but no source diff. No new authority document.

**Interfaces:** Consumes Task 1 SPEC and Task 2 test evidence. Produces a traceability mapping `SPEC §19.7 -> Worker route/auth -> QuotaController RPC -> tests`, with a separate Stage 1/2 `NOT VERIFIED` section.

- [ ] **Step 1: Add a concise operator note** distinguishing control route deployment from activation, Stage 1 measurement PASS, Stage 2 bridge, and `#121` issue closure. Link existing `docs/superpowers/plans/2026-10-05-worker-free-cpu-headroom-redesign.md` Tasks 6/9–12; do not duplicate their runbook.
- [ ] **Step 2: Check all tests and source in one source revision.** Run `node --test scripts/documentation-contract.test.mjs`, `npm run typecheck`, `npm test`, `npm run test:preview-workflow`, `npm run test:deno-deploy-workflow`, `git diff --check`. Expected: all zero-failure locally; record exact HEAD and commands/results without claiming tests were run when planning.
- [ ] **Step 3: Independent R1 review.** Reviewer verifies original `NEG-001` against the **new** fixed HEAD, the closed v1/extension boundary, public header non-regression, and whole-change scope. `NEG-001` may close only on evidence; runtime Stage 1/2 stays open.
- [ ] **Step 4: Commit/handoff boundary (execution-time only).** Commit any operations documentation change; hand off source SHA, test logs, and explicit `STAGE1_PENDING / STAGE2_PENDING` to the separate CPU rollout plan.

## Self-Review / Completion Conditions

- Contract difference is reconciled against the same fixed HEAD, with no runtime behavior change unless separately justified; each of the eight routes and failure ordering has a code/test/spec mapping.
- No introduced new Deno callback fields, public route, public version header, quota writer or implicit CPU-Gate approval.
- The audit finding's closure is a *documentation and contract* decision. Do **not** close Issue #121 or claim CPU p99/max evidence from this task.
- Expected final state: `NEG-001 REVIEWABLE_FOR_CLOSURE / ISSUE_121_GATE_UNVERIFIED`. Human Owner retains adoption authority.
