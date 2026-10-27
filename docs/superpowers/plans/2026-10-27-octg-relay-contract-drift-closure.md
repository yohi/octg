# OCTG Relay v1 / CPU-gate Contract Drift Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the confirmed active `SPEC.md` ↔ internal HTTP implementation contract drift (`NEG-001`) without changing any public or production runtime behavior.

**Architecture:** Treat `/internal/relay/v1/cpu-gate/*` as a separately scoped, authenticated CPU-gate *control-plane extension*, not an unannounced addition to the closed Deno Relay v1 callback wire contract. Preserve the existing interfaces; add an explicit normative exception/contract and executable documentation-to-code checks. Do not treat this documentation correction as Stage 1/Stage 2 CPU acceptance.

**Tech Stack:** Markdown, Node.js >=22 (`node:test`), TypeScript 5.6, Vitest/Cloudflare Workers tests.

**Spec:** `SPEC.md` §1 and §19; `docs/superpowers/specs/2026-10-05-worker-free-cpu-headroom-redesign.md` §§Stage 2 CPU-gate control, Production/Preview isolation, Completion criteria. **Fixed audit baseline:** `0ac76d5727018ee47e01935022d59581039a87d2` (2026-10-27 JST). This plan does not supersede the existing `2026-10-05-worker-free-cpu-headroom-redesign.md` plan.

## Global Constraints

- `SPEC.md` is authoritative for active OCTG behavior; `docs/superpowers/` may contain approved but not yet enabled rollout targets. A merged plan is not proof of an accepted CPU gate.
- Preserve Relay v1 callback/ingress path, method, content type, header and envelope rules (including `POST` only for *the v1 ingress/callback protocol*). Do **not** relabel CPU-gate `GET` control routes as Relay v1 callbacks.
- Preserve all public `/v1/responses`, `/v1/chat/completions`, quota and model behavior, existing error mapping and prior compat guarantees; no client-facing header changes.
- Preserve `QuotaController` as sole quota/grant authority; D1 is not quota authority. No production/Preview cross-resource access.
- CPU-gate control bearer `OCTG_RELAY_CPU_GATE_AUTH_TOKEN` is distinct from service and ingress bearers. Absent, malformed or equal-to-service/ingress bearer => control route 404; wrong supplied bearer while enabled => 401 before body or DO lookup.
- Preserve current route inventory: `quota`, `slot`, `setup`, `setup-fence`, `decision-context`, `operation-inspection`, `reconcile-unused`, `close-operation` under `/internal/relay/v1/cpu-gate/`.
- Control request body maximum `8,192` bytes; `quota` and `slot` GET, remaining routes POST. Avoid logging credentials/payloads; version metadata identifies only **stateless Worker** version, not DO version.
- No Cloudflare remote API, deployment, secret mutation, CI rerun, PR/merge or Human Owner decision is authorized by writing or executing this plan alone.

## Review Focus

1. Absent/invalid/equal-to-service gate secret must yield 404 *without reading the request body or querying DO*. Test owner: Task 2.
2. Valid control secret with wrong supplied bearer must yield 401 *before DO lookup*. Test owner: Task 2.
3. `GET` CPU-gate `quota|slot` must never relax the `POST`-only **Relay v1 callback** contract. Test owner: Task 1.
4. `X-OCTG-Worker-Version` on internal rejections must not be confused with DO code-version proof or copied into the public response. Test owner: Tasks 1–2.
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

- [ ] **Step 1: Write RED documentation tests.** Add a `node:test` test named `SPEC distinguishes closed relay v1 callbacks from CPU-gate control routes`. Assert that SPEC: (a) explicitly distinguishes the two contracts; (b) names the exact eight routes; (c) distinguishes GET `quota|slot` from POST mutations; (d) states the CPU-gate bearer, absent/mismatched handling, 8,192-byte body limit, no direct DO storage mutation, stateless-only version attribution; (e) leaves `POST-only` Relay v1 callback requirement unchanged. Derive the route list from `relay-cpu-gate.ts` exact constant or test an explicit frozen inventory to catch accidental drift.
- [ ] **Step 2: Verify RED.** Run `node --test scripts/documentation-contract.test.mjs`. Expected: new SPEC-extension assertion fails against baseline; pre-existing tests retain status.
- [ ] **Step 3: Write the minimal SPEC update.** Clarify §19's prohibition of unannounced Relay v1 wire fields/headers/routes; an explicitly specified CPU-gate control plane is not a Deno ingress or lifecycle callback. Add `§19.7` with exact method/route list, control bearer behavior, body/error rules, requestId/fixture-scoped mutation, version header scope, fail-closed semantics, and an explicit non-claim for Stage 1/2 readiness. Define `X-OCTG-Worker-Version` as an internal attribution header (including `local` in non-deployed tests); it does not assert DO version, CPU PASS, or public API contract changes. Do not broaden legacy compatibility requirements.
- [ ] **Step 4: Verify GREEN.** Run `node --test scripts/documentation-contract.test.mjs`. Expected: all checks pass, including new parity assertions.
- [ ] **Step 5: Commit boundary (execution-time only).** `git add SPEC.md scripts/documentation-contract.test.mjs && git commit -m "docs: synchronize relay cpu control-plane contract"`. A new reviewer must confirm that the revision is a contract sync, not tacit Security/Stage Gate approval.

### Task 2: Anchor the extension to actual Worker routing and denial behavior

**Files:** Modify `apps/gateway-worker/test/relay-cpu-gate.test.ts` and/or `apps/gateway-worker/test/relay-version-headers.test.ts` **only if** the named assertions do not already exist; `apps/gateway-worker/src/index.ts`, `relay-auth.ts`, `relay-cpu-gate.ts`, `version-metadata.ts` are review-only unless a specific failing test proves code drift.

**Interfaces:** Consumes §19.7 from Task 1. Produces tests for the real `SELF.fetch` Worker entrypoint covering control routes and unchanged callbacks.

- [ ] **Step 1: Write a coverage map before editing.** Map each eight-route method and auth guard to current tests. Record `covered` or a concrete missing test name; don't add duplicate tests.
- [ ] **Step 2: Add missing failing cases (if any).** Exact assertions: with gate secret absent/invalid/equal to either service bearer or ingress bearer, `SELF.fetch('/internal/relay/v1/cpu-gate/setup')` returns 404 and `env.QUOTA_CONTROLLER.idFromName` is not called; enabled gate with absent/wrong Authorization returns 401 before DO; `quota|slot` reject POST as 405 `Allow: GET`, `setup` rejects GET as 405 `Allow: POST`; rejected callback and gate routes include a non-empty `X-OCTG-Worker-Version`, while public `/v1/responses` does not gain that internal header. Use intentionally malformed request bodies to prove guard ordering. Do not emit bearer values in assertions/logs.
- [ ] **Step 3: Verify RED only for newly asserted unimplemented behavior.** Run `npm run test --workspace @octg/gateway-worker -- test/relay-cpu-gate.test.ts test/relay-version-headers.test.ts`; for pre-existing behaviors a passing regression test is appropriate and no artificial runtime fault should be introduced.
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
