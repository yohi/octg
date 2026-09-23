<!-- markdownlint-disable MD013 MD032 -->

# Free-Worker Deno Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route Deno-prepared Responses requests through Deno to Gateway B while keeping quota authorization and settlement in QuotaController and Cloudflare Workers on the Free plan.

**Architecture:** Worker authenticates and streams each original request once to Deno. Deno normalizes and tokenizes, calls back to Worker for quota admission and one-use DO authorization, then forwards to Gateway B and reports terminal usage through Worker; Worker relays response bytes unchanged. The old `/prepare` route remains available until the relay passes measured canary gates.

**Tech Stack:** Strict TypeScript, Cloudflare Workers and SQLite-backed Durable Objects, Deno Deploy, Vitest, Deno test runner, npm workspaces, GitHub Actions.

**Spec:** [Free-Worker Responses Relay Through Deno](../specs/2026-09-23-free-worker-deno-relay-design.md).

## Global Constraints

- Cloudflare Workers Paid is not an option; the per-HTTP-invocation Free CPU allowance is 10 ms.
- Production `MAX_INPUT_BYTES` remains `1048576`; Preview and Production control planes remain separate.
- QuotaController is the only quota authority; D1 is audit-only and cannot gate admission.
- The public `/v1/responses` contract and the current `/prepare` rollback route remain available.
- No retry of an upstream request after grant activation; ambiguous attempts retain quota conservatively.
- Never log client keys, signing or service secrets, nonces, prompts, request/response bodies or Gateway B credentials.
- Avoid touching the existing untracked `deno.lock` unless ownership is explicitly established.
- Git commits, remote deployment and production mutations require separate explicit authorization; task completion does not authorize them.

---

## File and interface map

| File | Responsibility |
| --- | --- |
| `packages/shared/src/relay.ts` | Wire envelopes, strict parsers and size bounds for context, decision, activation, renewal, terminal report. |
| `packages/shared/src/index.ts` | Export the relay contract. |
| `apps/gateway-worker/src/relay-auth.ts` | Sign and verify contexts; authenticate Deno callbacks without leaking tokens. |
| `apps/gateway-worker/src/relay-callback.ts` | Bounded callback routing and DO/policy orchestration; no client body processing. |
| `apps/gateway-worker/src/relay-client.ts` | One-pass client-body relay and Deno response mapping. |
| `apps/gateway-worker/src/index.ts` | Register callback before public routes; extend `Env` with isolated relay configuration. |
| `apps/gateway-worker/src/proxy.ts` | Opt-in Responses routing before legacy prepare branch; leave Chat and legacy intact. |
| `durable-objects/quota-controller/src/relay-grant.ts` | Transactional, one-use grant and terminal-state logic. |
| `durable-objects/quota-controller/src/quota-controller.ts` | Export grant operations and coordinate with existing reservation and lease. |
| `apps/deno-tokenizer/src/relay.ts` | Bounded input preparation, decision/activation callbacks and Gateway B request. |
| `apps/deno-tokenizer/src/relay-usage.ts` | Bounded SSE/JSON usage extraction without changing client bytes. |
| `apps/deno-tokenizer/src/http.ts`, `src/config.ts`, `src/main.ts` | Versioned endpoint and environment-specific configuration. |
| Existing suites in `apps/gateway-worker/test/`, `apps/deno-tokenizer/test/`, `durable-objects/quota-controller/test/` | Behavior and fault-injection regressions. |
| `.github/workflows/deploy-deno-tokenizer.yml`, `.github/workflows/deploy-production.yml`, `scripts/production-deno-config.mjs` | Same-revision, Deno-first rollout and safe configuration checks. |
| `SPEC.md`, `docs/deno-tokenizer.md`, `docs/operations.md`, `docs/configuration.md` | Normative contract, operational rollout, configuration ownership. |

Fix wire names in Task 1; later tasks consume those names without renaming them. Keep each new TS module focused and below the repository's 250-LOC guidance where feasible. Existing oversized modules should gain only routing glue, not another full state machine.

## Task 1: Define and test the bounded relay contract

**Files:** Create `packages/shared/src/relay.ts`, `packages/shared/test/relay.test.ts`; modify `packages/shared/src/index.ts`.

**Interfaces:** `RelayContextV1 = { version: 1; environment: "production" | "preview"; audience: "octg-deno-relay"; requestId: string; clientId: string; idempotencyKey?: string; nonce: string; issuedAtMs: number; expiresAtMs: number }`. `RelayMetadataV1 = { model: string; estimatedInputTokens: number; maxOutputTokens: number; inputBytes: number; rawBodyBytes: number; isToolUse: boolean; stream: boolean }`. `RelayDecisionV1 = { kind: "reject"; status: number; code: string } | { kind: "allow"; maxOutputTokens: number; generation: string; grantId: string; grantCredential: string; pool: "standard" | "mini"; cacheEnabled: boolean; quota: QuotaSnapshot }`. `RelayTerminalV1 = { kind: "settle"; totalTokens: number; inputTokens?: number; outputTokens?: number } | { kind: "uncertain" } | { kind: "release" }`. Expose `parseRelayContext`, `parseRelayMetadata`, `parseRelayDecision`, `parseRelayTerminal` with signatures `(value: unknown) => RespectiveType | undefined`; reject extra fields, invalid numeric ranges and oversized strings. Use the existing `QuotaSnapshot` export rather than a second quota shape; `grantCredential` is secret and never logged.

- [ ] Add failing tests for each accepted envelope and for version mismatch, extra keys, negative or non-integer usage, oversized metadata, wrong environment and malformed grant. Example: `expect(parseRelayMetadata({ model: "openai/test", estimatedInputTokens: -1 })).toBeUndefined()`.
- [ ] Run `npm test -w packages/shared -- relay.test.ts`; expect the missing parser test to fail.
- [ ] Add discriminated unions and parsers with explicit byte/string bounds, as in `if (!Number.isSafeInteger(raw.estimatedInputTokens) || raw.estimatedInputTokens < 0) return undefined;`. Export the functions in `index.ts`.

  ```ts
  const RELAY_METADATA_KEYS = new Set([
    "model", "estimatedInputTokens", "maxOutputTokens", "inputBytes",
    "rawBodyBytes", "isToolUse", "stream",
  ]);
  export function parseRelayMetadata(value: unknown): RelayMetadataV1 | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;
    if (Object.keys(raw).length !== RELAY_METADATA_KEYS.size ||
        Object.keys(raw).some((key) => !RELAY_METADATA_KEYS.has(key))) return undefined;
    if (typeof raw.model !== "string" || raw.model.length === 0 ||
        new TextEncoder().encode(raw.model).byteLength > 256) return undefined;
    if (typeof raw.estimatedInputTokens !== "number" ||
        !Number.isSafeInteger(raw.estimatedInputTokens) || raw.estimatedInputTokens < 0) return undefined;
    for (const key of ["inputBytes", "rawBodyBytes"] as const) {
      if (typeof raw[key] !== "number" || !Number.isSafeInteger(raw[key]) ||
          (raw[key] as number) < 0 || (raw[key] as number) > 1048576) return undefined;
    }
    if (typeof raw.maxOutputTokens !== "number" ||
        !Number.isSafeInteger(raw.maxOutputTokens) || raw.maxOutputTokens < 0) return undefined;
    if (typeof raw.isToolUse !== "boolean" || typeof raw.stream !== "boolean") return undefined;
    return {
      model: raw.model,
      estimatedInputTokens: raw.estimatedInputTokens,
      maxOutputTokens: raw.maxOutputTokens,
      inputBytes: raw.inputBytes as number,
      rawBodyBytes: raw.rawBodyBytes as number,
      isToolUse: raw.isToolUse,
      stream: raw.stream,
    };
  }
  ```
- [ ] Run `npm test -w packages/shared -- relay.test.ts` and `npm run typecheck -w packages/shared`; expect pass.

## Task 2: Make grants durable, single-use and terminal transitions atomic

**Files:** Create `durable-objects/quota-controller/src/relay-grant.ts`, `durable-objects/quota-controller/test/relay-grant.test.ts`; modify `durable-objects/quota-controller/src/quota-controller.ts`.

**Interfaces:** `type RelayGrant = { grantId: string; generation: string; state: "authorized" | "attempted" | "settled" | "released" | "uncertain"; expiresAtMs: number; terminal?: RelayTerminalV1 }`. `authorizeRelay(requestId, grantId, generation, expiresAtMs): Promise<{ ok: boolean }>` (reserved request and matching live lease required); `activateRelay(requestId, grantId, generation): Promise<{ ok: boolean }>` (one atomic `authorized -> attempted` transition); `finishRelay(requestId, grantId, generation, report: RelayTerminalV1): Promise<{ ok: boolean; state: "settled" | "released" | "uncertain" }>` (idempotent exact-repeat only). Store grant state and terminal report alongside the reservation in DO storage. `release` is valid only while grant is definitely `authorized`; after `attempted`, only `settle` or `uncertain` is accepted. Persist expiry; expired `authorized` grants cannot activate and remain visible until explicitly released or reconciled.

- [ ] Write a failing DO test that reserves, acquires a lease, authorizes a grant, calls `activateRelay` concurrently twice, and asserts exactly one `ok: true`; include wrong generation, missing reservation, expired grant, release-before-activation, post-activation release rejection, duplicate identical terminal and conflicting terminal cases. Example: `expect((await Promise.all([stub.activateRelay(id, grant, gen), stub.activateRelay(id, grant, gen)])).filter(x => x.ok)).toHaveLength(1)`.
- [ ] Run `npm test -w apps/gateway-worker -- relay-grant.test.ts`; the gateway Vitest config includes quota-controller tests. Expect missing methods to fail.
- [ ] Implement storage transactions and call existing `QuotaLifecycle` operations through a state transition that cannot race with grant state. Avoid a separate non-transactional `get -> settle` sequence; refactor the lifecycle to share a storage transaction if necessary. Couple lease-generation validation to the same transaction.

  ```ts
  return this.ctx.storage.transaction(async (storage) => {
    const grant = await storage.get<RelayGrant>(`relay:${requestId}`);
    if (grant?.grantId !== grantId || grant.generation !== generation || grant.state !== "authorized") {
      return { ok: false } as const;
    }
    await storage.put(`relay:${requestId}`, { ...grant, state: "attempted" });
    return { ok: true } as const;
  });
  ```
- [ ] Run `npm test -w apps/gateway-worker -- relay-grant.test.ts` and `npm run typecheck -w durable-objects/quota-controller`; expect pass.

## Task 3: Authenticate relay context and internal callbacks

**Files:** Create `apps/gateway-worker/src/relay-auth.ts`, `apps/gateway-worker/test/relay-auth.test.ts`; modify `apps/gateway-worker/src/index.ts` for optional relay environment bindings.

**Interfaces:** `signRelayContext(context: RelayContextV1, key: string): Promise<string>`; `verifyRelayContext(token: string, key: string, environment: RelayContextV1["environment"], nowMs: number): Promise<RelayContextV1 | undefined>`; `verifyRelayServiceAuth(header: string | null, secret: string): Promise<boolean>`. Use WebCrypto HMAC-SHA256, constant-time comparison for service tokens and a bounded serialized context, separate secrets for context signing and callback service authentication. Configure `OCTG_RELAY_ENVIRONMENT`, `OCTG_RELAY_CONTEXT_KEY`, `OCTG_RELAY_SERVICE_TOKEN`, `DENO_RELAY_ENDPOINT`, `OCTG_RELAY_ENABLED`; absent or partial configuration disables relay and must not affect legacy route. Validate HTTPS fixed endpoint and reject credential-bearing URLs. Mint a distinct grant-bound callback credential at successful decision; unlike the ingress context it remains valid through the configured maximum request duration. After terminal state it only permits the DO to return an identical stored terminal result until expiry, never another transition.

- [ ] Write failing tests for valid production context and wrong audience, expired/future timestamps, wrong signature, preview replay in production, missing/partial config and non-HTTPS endpoints. Verify that a terminal callback can use the grant credential after the ingress context expires and that an identical terminal retry returns the stored result, but renewal or a conflicting report fails. Example: `expect(await verifyRelayContext(previewToken, prodKey, "production", now)).toBeUndefined()`.
- [ ] Run `npm test -w apps/gateway-worker -- relay-auth.test.ts`; expect missing exports.
- [ ] Implement signing/verifying and `resolveRelayConfig(env)` with bounded TTL; ensure errors expose stable categories only. The Worker should not leak an internal token or signature in log fields or response bodies.

  ```ts
  const signature = await crypto.subtle.sign("HMAC", signingKey, encodedContext);
  // Verify signature against the original bytes before parseRelayContext(JSON.parse(...)).
  // Reject an ingress context when expiresAtMs <= nowMs or environment differs.
  ```
- [ ] Run focused test and `npm run typecheck -w apps/gateway-worker`; expect pass.

## Task 4: Add Worker decision, activation, renewal and terminal callbacks

**Files:** Create `apps/gateway-worker/src/relay-callback.ts`, `apps/gateway-worker/test/relay-callback.test.ts`; modify `apps/gateway-worker/src/index.ts`, `apps/gateway-worker/src/policy.ts` only if a reusable policy helper is required.

**Interfaces:** `handleRelayCallback(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>` handles `POST /internal/relay/v1/decision`, `/activation`, `/renewal`, `/terminal`; each request carries authenticated service header and bounded JSON envelopes. Decision verifies the short-lived signed ingress context; subsequent calls verify the separate grant-bound credential and the stored DO grant. Decision uses existing `classifyModel`, `loadRegistry`, `loadPolicy`, `resolveTokenBudget`, `reserveFailClosed`, `acquireInFlight` and `authorizeRelay`, using the UTC day bound when the request ID is first admitted. Activation/renewal/terminal address the same DO and stored grant; no callback accepts arbitrary DO name or supplied upstream URL. Maintain a durable nonce-to-request binding before accepting a second decision callback; exact repeats return a stored decision only before activation, conflicting repeats reject.

- [ ] Write failing tests for callback auth, wrong method/path, oversized JSON, wrong environment, model/tool rejection, quota rejection, unknown reserve, admission rejection, duplicate decision and lost grant ACK; assert no `fetch` to Gateway B before successful activation. Example: `expect(await callback(duplicateDecision)).toMatchObject({ status: 409 })` for a conflicting nonce/metadata.
- [ ] Run `npm test -w apps/gateway-worker -- relay-callback.test.ts`; expect the decision route to return 404.
- [ ] Implement callback endpoints with strict parsers. Reserve first, acquire in-flight, then authorize; on proven pre-activation failure release both. On unknown reserve call `markReserveOutcomeUnknown`. An ambiguous activation is never automatically retried. Terminal invokes `finishRelay`; audit completion remains best effort and cannot change a DO outcome.

  ```ts
  const reserved = await reserveFailClosed(
    (id, tokens, upper, key, client) => stub.reserve(id, tokens, upper, key, client),
    reserveInput,
  );
  if (reserved.kind === "unknown") {
    await stub.markReserveOutcomeUnknown(context.requestId);
    return new Response(null, { status: 503 });
  }
  // On reserved.ok, acquireInFlight -> authorizeRelay; otherwise reject.
  // Never send an allow decision before all three operations have succeeded.
  ```
- [ ] Run focused tests and `npm run typecheck -w apps/gateway-worker`; expect pass.

## Task 5: Build Deno relay and upstream request with explicit activation

**Files:** Create `apps/deno-tokenizer/src/relay.ts`, `apps/deno-tokenizer/test/relay.test.ts`; modify `apps/deno-tokenizer/src/http.ts`, `src/config.ts`, `src/main.ts`. Keep `/prepare` behavior unchanged.

**Interfaces:** `handleRelay(request: Request, config: RelayServiceConfig, encoder: ExactEncoder, fetchImpl: typeof fetch): Promise<Response>` handles `POST /relay/v1/responses`. Define `activateOnce(grantId: string, credential: string): Promise<{ ok: boolean }>` and `forwardToGatewayB(body: Record<string, unknown>, decision: Extract<RelayDecisionV1, { kind: "allow" }>): Promise<Response>` as request-local helpers in `relay.ts`. Config contains Deno's environment-specific callback URL, service auth token, Gateway B base URL ending `/openai`, Gateway B API token and existing `MAX_INPUT_BYTES`. Reject partial config at startup; Deno endpoint unavailable until valid. The signed Worker context is forwarded to callbacks without logging it. Deno builds upstream JSON by calling existing `normalizeResponsesUpstreamBody(parsed)` and replacing `max_output_tokens` with the numeric allowed value; Gateway B headers match `callUpstream` in `apps/gateway-worker/src/upstream.ts`, including `cf-aig-collect-log-payload: false`, `cf-aig-max-attempts: 1`, cache policy, idempotency and metadata set only from verified decision/context. Do not reuse client `Authorization`.

- [ ] Add failing tests: malformed body has no callback, a decision reject has no activation or upstream request, activation lost/denied never calls upstream, a successful activation calls Gateway B exactly once with numeric clamp and fixed URL, `fetch` failure after activation reports uncertain, and failed callback cannot cause fallback. Example: `assertEquals(upstreamCalls, 0)` after an activation timeout.
- [ ] Run `npm test -w apps/deno-tokenizer`; expect the new relay route tests to fail.
- [ ] Implement bounded body preparation using the existing `readBoundedRawBody`, normalizer and encoder, extracting shared helpers from `http.ts` rather than duplicating parser logic. Send bounded metadata, require a valid allow decision, then activate once before forwarding. Treat all ambiguous post-activation outcomes as uncertain.

  ```ts
  const decision = parseRelayDecision(await decisionResponse.json());
  if (decision?.kind !== "allow") return new Response(null, { status: 503 });
  const activation = await activateOnce(decision.grantId, decision.grantCredential);
  if (!activation.ok) return new Response(null, { status: 503 });
  const body = normalizeResponsesUpstreamBody(parsedBody);
  body.max_output_tokens = decision.maxOutputTokens;
  return forwardToGatewayB(body, decision);
  ```
- [ ] Run `npm run typecheck -w apps/deno-tokenizer` and `npm test -w apps/deno-tokenizer`; expect pass.

## Task 6: Move usage extraction and terminal reporting to Deno

**Files:** Create `apps/deno-tokenizer/src/relay-usage.ts`, `apps/deno-tokenizer/test/relay-usage.test.ts`; modify `apps/deno-tokenizer/src/relay.ts`, `apps/deno-tokenizer/test/relay.test.ts`.

**Interfaces:** `relayUpstreamResponse(response: Response, onTerminal: (report: RelayTerminalV1) => Promise<void>): Response`; the client-visible stream bytes and content type are unchanged. Inspect a bounded tail for Responses `response.completed` usage and handle SSE event fragmentation. A non-stream response has a bounded read/parse budget and reports usage before returning; missing or malformed usage reports uncertainty. Renewal uses a timer shorter than the configured lease TTL and is cancelled at terminal; failure to renew aborts upstream and keeps quota uncertain.

- [ ] Add failing tests for SSE usage split across chunks, large non-usage events, no final usage, upstream non-2xx, client disconnect, renewal failure and callback failure. Assert original response bytes are identical, usage reported once, no full-stream buffering, and no quota release after activation.
- [ ] Run `npm test -w apps/deno-tokenizer`; expect new tests to fail.
- [ ] Implement bounded tail inspection and terminal callback in a `finally` path with idempotent completion. Forward the original upstream status and content-type; if failure occurs after headers, abort the stream rather than fabricating a second HTTP response. On terminal callback failure, rely on conservative DO reservation and reconciliation, not Deno background execution guarantees.

  ```ts
  let reported = false;
  const reportOnce = async (report: RelayTerminalV1): Promise<void> => {
    if (reported) return;
    reported = true;
    await onTerminal(report);
  };
  // In the stream's flush/cancel/error paths call reportOnce with parsed
  // usage or uncertain, then clear the lease-renewal timer.
  ```
- [ ] Run `npm run typecheck -w apps/deno-tokenizer` and `npm test -w apps/deno-tokenizer`; expect pass.

## Task 7: Select relay for Responses and relay bytes without Worker parsing

**Files:** Create `apps/gateway-worker/src/relay-client.ts`, `apps/gateway-worker/test/relay-client.test.ts`; modify `apps/gateway-worker/src/proxy.ts`, `apps/gateway-worker/src/index.ts`, `apps/gateway-worker/test/proxy-prepare.test.ts`.

**Interfaces:** `callDenoRelay(request: Request, signedContext: string, config: RelayConfig, fetchImpl?: typeof fetch): Promise<Response>` sends original request body as a stream with internal auth; it must not buffer or clone the body. `relayPublicResponse(relayed: Response, requestId: string, version: WorkerVersionMetadataLike | undefined): Response` validates the bounded Worker-issued quota snapshot in the Deno response header, returns an OCTG public error on missing/malformed metadata, otherwise wraps `relayed.body` with `buildOctgHeaders` and `workerVersionHeaders`. `handleProxy` selects relay only when enabled for Responses; other routes and `proxyStream` remain legacy. It does not parse usage. Pre-header Deno errors map to existing public error responses. After response headers are sent, callback/DO ownership determines settlement.

- [ ] Add failing integration tests for exact 1 MiB with and without Content-Length, malformed lengths, stream and non-stream, Deno timeout, validation reject and 5xx, unchanged Chat route, legacy fallback when disabled, and raw byte equality of SSE payload. Example: `expect(upstreamWorkerCalls).toBe(0)` on relay success and `expect(denoCalls).toBe(1)`.
- [ ] Run `npm test -w apps/gateway-worker -- relay-client.test.ts proxy-prepare.test.ts`; expect relay-disabled tests to pass and new enabled tests to fail.
- [ ] Add route/config selection before the legacy prepare branch, with no legacy retry after an enabled relay fails. Forward only safe response headers. Avoid `proxyStream` in relay route and avoid marking a reservation released on an ingress failure after Deno might have activated.

  ```ts
  if (endpoint === "responses" && relayConfig.kind === "enabled") {
    const signedContext = await signRelayContext(context, relayConfig.contextKey);
    const relayed = await callDenoRelay(request, signedContext, relayConfig);
    return relayPublicResponse(relayed, requestId, env.CF_VERSION_METADATA);
  }
  // The existing prepare and Chat paths remain below this branch.
  ```
- [ ] Run focused tests and `npm run typecheck -w apps/gateway-worker`; expect pass.

## Task 8: Verify crash windows, isolation, config and rollout

**Files:** Modify `apps/gateway-worker/test/relay-callback.test.ts`, `apps/deno-tokenizer/test/relay.test.ts`, `durable-objects/quota-controller/test/relay-grant.test.ts`, `scripts/production-deno-config.mjs`, its test, `scripts/preview-worker-config.test.mjs`, `.github/workflows/deploy-deno-tokenizer.yml`, `.github/workflows/deploy-production.yml`, `SPEC.md`, `docs/configuration.md`, `docs/deno-tokenizer.md`, `docs/operations.md`.

- [ ] Add failing fault-injection tests for Worker termination after reserve, lost activation acknowledgement, duplicate Deno callback, terminal delivery failure, stale lease generation, Deno termination after activation, conflicting terminal reports, and Preview context at Production callback. Expected: one grant causes at most one upstream attempt; neither DO quota nor audit depends on D1 availability.
- [ ] Run focused suites; expect missing crash handling and Preview isolation assertions to fail.
- [ ] Wire isolated Preview and Production endpoints/secrets and make new relay opt-in, with config validation before remote mutation. Keep the same-SHA Deno-before-Worker gate; add a non-secret relay health/contract probe. Preserve existing Deno `/prepare` and Worker rollback path until pending grants can be reconciled.
- [ ] Update `SPEC.md` as the single normative source for the new internal protocol, and human docs for configuration and rollback. Include CPU-by-size/concurrency evidence procedure and Deno capacity checks. Document that a single failed callback leaves quota conservative, not auto-released.
- [ ] Run `npm run typecheck`, `npm test`, `npm run test:deno-deploy-workflow`, `npm run test:preview-workflow`, `git diff --check`, and, if installed, `npx --no-install markdownlint-cli2 SPEC.md docs/configuration.md docs/deno-tokenizer.md docs/operations.md`.

## Canary and release gate

No production change occurs as part of writing or merely executing tests for this plan. After separate deployment authorization, deploy Deno first for the same immutable revision, then enable the Worker relay in Preview. Canary synthetic payloads at 123 KiB, 174 KiB, approximately 700 KiB and 1 MiB in both streaming modes at concurrency 1, 2 and 3. Record sample count, CPU distribution per ingress and callback invocation, `exceededCpu`, Gateway B matches, reservation/settlement/uncertainty counts and Deno capacity without payloads or credentials. Only enable a controlled Production subset after zero CPU failures in the documented sample and correct quota behavior for all injected failures. If the first Worker-to-Deno hop alone breaches 10 ms, halt the rollout and revisit ingress placement. Rollback must retain callbacks while outstanding grants exist; reconcile them before removing old secrets.

## Self-review matrix

- Ingress and contract: Tasks 1, 3, 5, 7.
- Quota one-use authorization and failure windows: Tasks 2, 4, 8.
- Upstream forwarding, stream usage and lease renewal: Tasks 5, 6.
- Free CPU, deployment, environment isolation and rollback: Tasks 7, 8, canary gate.
- External-facing normative contract and operational documentation: Task 8.

The source tree already contains an unrelated untracked `deno.lock`; verify status before edits and leave it unstaged.
