# Free Plan OpenCode Compaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OpenCode の通常リクエストと Compaction リクエストを OCTG 経由で許可しつつ、Cloudflare Workers Free プランの負荷を pool 単位の同時実行制御で保護する。

**Architecture:** 入力サイズの運用上限を 1 MiB に引き上げ、request body を JSON parse 前に上限付きで読む。Durable Object に pool 単位の in-flight state と acquire/release RPC を追加し、upstream 接続中の要求数を制限する。入力過大は 413、Worker 過負荷は quota 非消費の 429 として分離し、SSE を含む全終了経路で in-flight を解放する。

**Tech Stack:** TypeScript strict, Cloudflare Workers Free plan, Durable Objects, npm workspaces, Vitest, `@cloudflare/vitest-pool-workers`.

## Global Constraints

- authoritative な quota 制御と in-flight 制御は Durable Object が担う。
- Compaction を別 provider や別 gateway へ送らず、通常リクエストと同じ OCTG quota 経路を通す。
- `MAX_INPUT_BYTES` の既定値と `wrangler.jsonc` 設定値は `1_048_576` bytes（1 MiB）にする。
- `MAX_IN_FLIGHT_REQUESTS` の既定値と `wrangler.jsonc` 設定値は pool ごとに `2` にする。
- 入力過大は 413 `request_too_large`、同時実行飽和は 429 `worker_concurrency_exceeded` とする。
- 413 / 429 のいずれも upstream 呼び出し前に返し、拒否された要求は quota token を消費しない。
- `octg_sk_*`、upstream token、request body をコード・ログ・テスト出力へ残さない。
- `npm test`、`npm run typecheck`、`npm run fmt`、`npm run validate` を最終検証する。

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/shared/src/normalize.ts` | 既定 input byte 上限を公開する。 |
| `packages/shared/src/types.ts` | in-flight RPC result と pool view の型を公開する。 |
| `packages/shared/src/errors.ts` | worker concurrency rejection の OpenAI 互換 HTTP error を生成する。 |
| `durable-objects/quota-controller/src/store.ts` | pool ごとの in-flight count を永続化する。 |
| `durable-objects/quota-controller/src/quota-controller.ts` | 原子的 acquire / release RPC を提供する。 |
| `apps/gateway-worker/src/index.ts` | `MAX_IN_FLIGHT_REQUESTS` を Env に公開する。 |
| `apps/gateway-worker/src/proxy.ts` | 上限付き request body 読み取り、in-flight lifecycle、413/429 response を処理する。 |
| `apps/gateway-worker/wrangler.jsonc` | Free plan 用の 1 MiB / 2 request の初期値を設定する。 |
| `apps/gateway-worker/test/*.test.ts` | byte limit、concurrency、SSE cleanup の契約を検証する。 |
| `docs/cloudflare-ai-gateway-custom-provider.md` | OpenCode / Free plan 運用上の 413/429 契約を説明する。 |

### Task 1: 入力サイズ契約を 1 MiB に更新する

**Files:**
- Modify: `packages/shared/src/normalize.ts:3-5`
- Modify: `packages/shared/test/normalize.test.ts`
- Modify: `apps/gateway-worker/wrangler.jsonc:6-13`
- Modify: `apps/gateway-worker/test/proxy-failures.test.ts:22-43`

**Interfaces:**
- Produces: `MAX_NORMALIZED_INPUT_BYTES = 1_048_576`.
- Produces: `resolveMaxInputBytes(undefined) === 1_048_576`.

- [ ] **Step 1: Write the failing default-limit tests**

```ts
expect(MAX_NORMALIZED_INPUT_BYTES).toBe(1_048_576);
expect(resolveMaxInputBytes(undefined)).toBe(1_048_576);
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npm run test -w packages/shared -- --run test/normalize.test.ts && npm run test -w apps/gateway-worker -- --run test/proxy-failures.test.ts`

Expected: FAIL because the current default is `131072`.

- [ ] **Step 3: Update the constants and Worker configuration**

```ts
export const MAX_NORMALIZED_INPUT_BYTES = 1_048_576;
```

```jsonc
"MAX_INPUT_BYTES": "1048576",
"MAX_IN_FLIGHT_REQUESTS": "2"
```

- [ ] **Step 4: Run the focused tests to verify they pass**

Run: `npm run test -w packages/shared -- --run test/normalize.test.ts && npm run test -w apps/gateway-worker -- --run test/proxy-failures.test.ts`

Expected: PASS.

### Task 2: JSON parse 前に request body の byte 上限を適用する

**Files:**
- Modify: `apps/gateway-worker/src/proxy.ts:73-99`
- Modify: `apps/gateway-worker/test/proxy-failures.test.ts`

**Interfaces:**
- Produces: `readJsonBody(request: Request, maxBytes: number): Promise<{ ok: true; body: unknown } | { ok: false; reason: "too_large" | "invalid_json" }>`.
- Consumes: `resolveMaxInputBytes()` and `errInputTooLarge()`.

- [ ] **Step 1: Write failing early-rejection tests**

```ts
const oversized = JSON.stringify({
  model: "gpt-5",
  messages: [{ role: "user", content: "a".repeat(3) }],
});

const response = await SELF.fetch("https://octg.test/v1/chat/completions", {
  method: "POST",
  headers: {
    authorization: `Bearer ${TEST_CLIENT_KEY}`,
    "content-type": "application/json",
    "content-length": String(new TextEncoder().encode(oversized).byteLength),
  },
  body: oversized,
});

expect(response.status).toBe(413);
expect(upstreamCallCount).toBe(0);
expect((await stub().getState()).requestCount).toBe(before.requestCount);
```

Use a temporary `MAX_INPUT_BYTES="2"` test setting as in the existing test. Add a second test with no `content-length` header so the bounded stream reader, not only header preflight, produces the same 413 behavior.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm run test -w apps/gateway-worker -- --run test/proxy-failures.test.ts`

Expected: FAIL because `handleProxy()` calls `request.json()` before checking a byte boundary.

- [ ] **Step 3: Implement bounded reading and parsing**

```ts
async function readJsonBody(request: Request, maxBytes: number): Promise<
  | { ok: true; body: unknown }
  | { ok: false; reason: "too_large" | "invalid_json" }
> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isSafeInteger(contentLength) && contentLength > maxBytes) {
    return { ok: false, reason: "too_large" };
  }

  const reader = request.body?.getReader();
  if (!reader) return { ok: false, reason: "invalid_json" };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { ok: false, reason: "too_large" };
    }
    chunks.push(value);
  }
  try {
    return { ok: true, body: JSON.parse(new TextDecoder().decode(concatChunks(chunks, total))) };
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
}
```

Use a local `concatChunks` helper that allocates exactly `total` bytes. In `handleProxy`, resolve `maxInputBytes` first, call `readJsonBody`, map `too_large` to `errInputTooLarge`, and map invalid JSON to `errInvalidRequest`. Pass the decoded `body` to the existing normalizer and upstream builder.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `npm run test -w apps/gateway-worker -- --run test/proxy-failures.test.ts`

Expected: PASS; oversized payloads do not reach normalizer, quota, or upstream.

### Task 3: Durable Object に pool 単位の in-flight lease を追加する

**Files:**
- Modify: `packages/shared/src/types.ts:28-83`
- Modify: `durable-objects/quota-controller/src/store.ts:4-13`
- Modify: `durable-objects/quota-controller/src/quota-controller.ts:61-158`
- Modify: `apps/gateway-worker/test/quota-controller.test.ts`

**Interfaces:**
- Produces: `AcquireInFlightResult = { ok: true } | { ok: false; reason: "worker_concurrency_exceeded" }`.
- Produces: `QuotaController.acquireInFlight(requestId: string, limit: number): Promise<AcquireInFlightResult>`.
- Produces: `QuotaController.releaseInFlight(requestId: string): Promise<void>`.
- Invariant: acquire is idempotent for the same request ID; release is idempotent; rejected acquire does not mutate in-flight state.

- [ ] **Step 1: Write failing Durable Object tests**

```ts
const controller = stub("STANDARD", "2026-08-30");
expect(await controller.acquireInFlight("req-one", 2)).toEqual({ ok: true });
expect(await controller.acquireInFlight("req-two", 2)).toEqual({ ok: true });
expect(await controller.acquireInFlight("req-three", 2)).toEqual({
  ok: false,
  reason: "worker_concurrency_exceeded",
});

await controller.releaseInFlight("req-one");
expect(await controller.acquireInFlight("req-three", 2)).toEqual({ ok: true });
```

Also assert that repeated acquire of `req-one` does not consume a second slot and that repeated release does not free another request's slot.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm run test -w apps/gateway-worker -- --run test/quota-controller.test.ts`

Expected: FAIL because the RPC methods and state do not exist.

- [ ] **Step 3: Add the authoritative lease state and methods**

Store a `Set<string>`-equivalent serialized array under `IN_FLIGHT_KEY`. Validate `limit` as a positive safe integer. Run both methods in `this.ctx.storage.transaction()`.

```ts
async acquireInFlight(requestId: string, limit: number): Promise<AcquireInFlightResult> {
  return this.ctx.storage.transaction(async (storage) => {
    const active = new Set((await storage.get<string[]>(IN_FLIGHT_KEY)) ?? []);
    if (active.has(requestId)) return { ok: true };
    if (active.size >= limit) return { ok: false, reason: "worker_concurrency_exceeded" };
    active.add(requestId);
    await storage.put(IN_FLIGHT_KEY, [...active]);
    return { ok: true };
  });
}
```

`releaseInFlight` deletes only `requestId` and persists the remaining array. Do not couple lease state to `PoolState`, because request token accounting and connection occupancy have different lifecycles.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `npm run test -w apps/gateway-worker -- --run test/quota-controller.test.ts`

Expected: PASS.

### Task 4: Proxy lifecycle に in-flight lease と 429 契約を統合する

**Files:**
- Modify: `apps/gateway-worker/src/index.ts:14-23`
- Modify: `apps/gateway-worker/src/proxy.ts:73-328`
- Modify: `packages/shared/src/errors.ts:55-98`
- Modify: `apps/gateway-worker/test/proxy-failures.test.ts`
- Modify: `apps/gateway-worker/test/proxy.test.ts`

**Interfaces:**
- Consumes: `stub.acquireInFlight(requestId, resolveMaxInFlightRequests(env.MAX_IN_FLIGHT_REQUESTS))` after successful `reserve` and before `callUpstream`.
- Consumes: `stub.releaseInFlight(requestId)` on every non-streaming success/failure and stream finalize/cancel path.
- Produces: `resolveMaxInFlightRequests(configured?: string): number`, with default `2` and positive-safe-integer validation.
- Produces: `errWorkerConcurrencyExceeded(quota: QuotaSnapshot, requestId: string): OctgHttpError` with HTTP 429, code `worker_concurrency_exceeded`, route `reject:worker_concurrency`.

- [ ] **Step 1: Write failing proxy tests**

```ts
const controller = stub();
expect(await controller.acquireInFlight("occupied-a", 2)).toEqual({ ok: true });
expect(await controller.acquireInFlight("occupied-b", 2)).toEqual({ ok: true });

const before = await controller.getState();
const response = await request();

expect(response.status).toBe(429);
expect(response.headers.get("X-OCTG-Route")).toBe("reject:worker_concurrency");
expect(await response.json()).toMatchObject({
  error: { code: "worker_concurrency_exceeded" },
});
expect(upstreamCallCount).toBe(0);
expect(await controller.getState()).toMatchObject({
  reservedTokens: before.reservedTokens,
  confirmedTokens: before.confirmedTokens,
  uncertainTokens: before.uncertainTokens,
});
```

Add tests that a successful non-streaming response frees its lease and that an SSE stream frees its lease after the body is consumed. After each completion, a previously blocked request must reach the test upstream.

- [ ] **Step 2: Run focused tests to verify they fail**

Run: `npm run test -w apps/gateway-worker -- --run test/proxy-failures.test.ts test/proxy.test.ts`

Expected: FAIL because the proxy does not acquire leases or return worker-concurrency 429.

- [ ] **Step 3: Implement error and lease lifecycle**

```ts
export function resolveMaxInFlightRequests(configured: string | undefined): number {
  const parsed = Number(configured);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 2;
}
```

After `reserve` succeeds, acquire the lease. If acquire fails, call `stub.release(requestId)` to undo the token reservation, mark the database row failed with `billingClass: "none"`, and return `errWorkerConcurrencyExceeded`.

Once acquired, use one idempotent `releaseInFlight` closure. Call it before every return after acquire, including upstream configuration errors, network errors, non-OK upstream responses, non-stream success after settlement/uncertain handling, and JSON parse failures. Extend `proxyStream` to accept the closure and invoke it in `finalize()` after settle / markUncertain completes. `finalize()` is already guarded by `finalized`, so it remains correct for flush and cancel.

- [ ] **Step 4: Run focused tests to verify they pass**

Run: `npm run test -w apps/gateway-worker -- --run test/proxy-failures.test.ts test/proxy.test.ts`

Expected: PASS; 429 does not consume quota, and completed / canceled streams release their leases.

### Task 5: OpenCode / Free plan 運用契約を文書化して全体検証する

**Files:**
- Modify: `docs/cloudflare-ai-gateway-custom-provider.md`
- Modify: `README.md`
- Modify: `SPEC.md`

**Interfaces:**
- Documents: OpenCode Compaction is sent through OCTG and consumes the same OpenAI Free quota as normal requests.
- Documents: 413 means payload exceeds OCTG's 1 MiB operational input cap; 429 `worker_concurrency_exceeded` means the pool's in-flight Free-plan guard is saturated and no quota was consumed.

- [ ] **Step 1: Add documentation assertions by locating the relevant sections**

Use these exact documentation requirements:

```text
- MAX_INPUT_BYTES default: 1,048,576 bytes.
- MAX_IN_FLIGHT_REQUESTS default: 2 per pool.
- OpenCode Compaction uses the same OCTG endpoint and quota path.
- 413 request_too_large is not a quota-consumption event.
- 429 worker_concurrency_exceeded is retryable after an in-flight request completes and is not a quota-consumption event.
```

- [ ] **Step 2: Update the deployment and API contract documentation**

Add the Free-plan operating values to the deployment configuration section of `README.md`, the Custom Provider troubleshooting section, and the `SPEC.md` error table. Preserve the existing statement that Durable Object quota control is authoritative and D1 audit writes are best-effort.

- [ ] **Step 3: Run full validation**

Run: `npm test`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

Run: `npm run fmt`

Expected: PASS.

Run: `npm run validate`

Expected: PASS.

- [ ] **Step 4: Manually exercise the Worker HTTP surface**

Start the Worker and issue three requests with a test client key:

```bash
npm run dev -w apps/gateway-worker
```

1. Send an OpenCode-shaped Responses payload below 1 MiB and verify a successful upstream pass-through.
2. Send a payload above 1 MiB and verify HTTP 413 with `request_too_large`, without an upstream call.
3. Hold two streaming requests open, submit a third, verify HTTP 429 with `worker_concurrency_exceeded`, then close one stream and verify a new request succeeds.

Expected: all paths exhibit their documented response and quota behavior.

## Plan Self-Review

- Spec coverage: Tasks 1-2 implement the 1 MiB input policy and pre-parse safety; Tasks 3-4 implement authoritative pool concurrency and all response lifecycles; Task 5 documents and validates 413/429 and OpenCode Compaction behavior.
- Placeholder scan: no deferred requirements or unnamed APIs remain; all introduced method names and response codes are defined in the corresponding task.
- Type consistency: `AcquireInFlightResult`, `acquireInFlight`, `releaseInFlight`, `resolveMaxInFlightRequests`, and `errWorkerConcurrencyExceeded` are defined before their later proxy use.
