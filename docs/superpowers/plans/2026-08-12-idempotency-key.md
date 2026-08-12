# Idempotency-Key 冪等性実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gateway A からの retry による reservation / upstream call / settlement の重複を防ぎ、`Idempotency-Key` を Gateway A → Worker → Gateway B まで変更せず転送する。

**Architecture:** Worker が `Idempotency-Key` を読み取り、Durable Object で key 単位の重複排除を行い、upstream 時に同じ key を Gateway B へ転送する。key がない場合は従来通り新規リクエストとして処理する。

**Tech Stack:** TypeScript / Cloudflare Workers / Durable Objects / D1 / Vitest + Miniflare

## Global Constraints

- `as any`, `@ts-ignore`, `@ts-expect-error` を使用しない
- 空の catch ブロックを使用しない
- テストを削除して pass させない
- 型検査を抑制しない
- 既存の `requestId` ベースの重複排除は維持する

---

## Task 1: RequestEntry に idempotencyKey を追加

**Files:**
- Modify: `packages/shared/src/types.ts`

**Interfaces:**
- Consumes: `RequestEntry` 型
- Produces: `idempotencyKey?: string` フィールドを持つ `RequestEntry`

- [ ] **Step 1: Write the change**

```typescript
export interface RequestEntry {
  state: RequestState;
  tokens: number;
  upperBoundTokens: number;
  reservedTokens: number;
  idempotencyKey?: string;
  requestedDisposition?: ReconcileDisposition;
  actualTokens?: number;
  results: RequestRpcResults;
  createdAt: string;
  updatedAt: string;
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat: add idempotencyKey to RequestEntry"
```

---

## Task 2: QuotaController RPC に idempotencyKey を追加

**Files:**
- Modify: `durable-objects/quota-controller/src/quota-controller.ts`
- Modify: `durable-objects/quota-controller/src/store.ts`

**Interfaces:**
- Consumes: `RequestEntry` 型
- Produces: `reserve(requestId, tokens, upperBoundTokens, idempotencyKey?)` インターフェース

- [ ] **Step 1: Write the failing test**

In `durable-objects/quota-controller/test/...` (create if missing) write a test that calls `reserve("req-1", 100, 100, "idem-key-1")` twice and asserts both return the same `remaining`.

```typescript
it("returns same reserve result for duplicate idempotency key", async () => {
  const first = await controller.reserve("req-1", 100, 100, "idem-1");
  const second = await controller.reserve("req-2", 100, 100, "idem-1");
  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  expect(second.remaining).toBe(first.remaining);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- durable-objects/quota-controller
```

Expected: FAIL - TypeScript signature mismatch

- [ ] **Step 3: Update RPC signatures**

Update `quota-controller.ts`:

```typescript
async reserve(
  requestId: string,
  tokens: number,
  upperBoundTokens: number,
  idempotencyKey?: string,
): Promise<ReserveResult>
```

And store the `idempotencyKey` in `RequestEntry`.

Add `idempotencyKey` map storage helpers in `store.ts`:

```typescript
export const IDEMPOTENCY_PREFIX = "idem:";

export async function getIdempotencyRequestId(
  storage: QuotaStorage,
  idempotencyKey: string,
): Promise<string | undefined> {
  return storage.get<string>(`${IDEMPOTENCY_PREFIX}${idempotencyKey}`);
}

export async function putIdempotencyRequestId(
  storage: QuotaStorage,
  idempotencyKey: string,
  requestId: string,
): Promise<void> {
  await storage.put(`${IDEMPOTENCY_PREFIX}${idempotencyKey}`, requestId);
}
```

- [ ] **Step 4: Implement dedupe in reserve**

In `quota-controller.ts` `reserve()`:

1. If `idempotencyKey` is provided:
   - Look up existing `requestId` via `idempotencyKey` map
   - If found, load that entry and return its `results.reserve`
   - If parameters mismatch, throw TypeError
2. Otherwise use existing `requestId` based dedupe
3. After successful new reservation, store `idempotencyKey -> requestId` mapping

- [ ] **Step 5: Run tests**

```bash
npm test -- durable-objects/quota-controller
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add durable-objects/quota-controller/src packages/shared/src/types.ts
git commit -m "feat: add idempotencyKey dedupe to QuotaController reserve"
```

---

## Task 3: Worker から Idempotency-Key を読み取り、QuotaController へ渡す

**Files:**
- Modify: `apps/gateway-worker/src/proxy.ts`

**Interfaces:**
- Consumes: `Request.headers`, `QuotaController.reserve`
- Produces: `idempotencyKey` を含む reserve 呼び出し

- [ ] **Step 1: Write the failing test**

In `apps/gateway-worker/test/proxy.test.ts`:

```typescript
it("reads Idempotency-Key header and forwards it to QuotaController", async () => {
  let reserveCalls = 0;
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({
    usage: { total_tokens: 10 },
  }), { status: 200 }));

  const response = await SELF.fetch("https://octg.test/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TEST_CLIENT_KEY}`,
      "idempotency-key": "idem-test-1",
    },
    body: JSON.stringify({ model: "gpt-5", messages: [{ role: "user", content: "hi" }] }),
  });
  expect(response.status).toBe(200);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- apps/gateway-worker/test/proxy.test.ts
```

Expected: FAIL - test passes immediately since no assertion on reserve behavior

Adjust the test to actually fail meaningfully.

- [ ] **Step 3: Read Idempotency-Key header in proxy.ts**

```typescript
const idempotencyKey = request.headers.get("Idempotency-Key") ?? undefined;
```

- [ ] **Step 4: Pass idempotencyKey to reserve**

```typescript
const reserved = await stub.reserve(requestId, reservation, upperBound, idempotencyKey);
```

- [ ] **Step 5: Run tests**

```bash
npm test -- apps/gateway-worker/test/proxy.test.ts
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/gateway-worker/src/proxy.ts apps/gateway-worker/test/proxy.test.ts
git commit -m "feat: read Idempotency-Key in proxy and pass to QuotaController"
```

---

## Task 4: Idempotency-Key を Gateway B へ転送

**Files:**
- Modify: `apps/gateway-worker/src/upstream.ts`
- Modify: `apps/gateway-worker/src/proxy.ts`

**Interfaces:**
- Consumes: `UpstreamMeta` に `idempotencyKey?: string` を追加
- Produces: `Idempotency-Key` ヘッダー付きの upstream request

- [ ] **Step 1: Write the failing test**

In `apps/gateway-worker/test/proxy.test.ts`:

```typescript
it("forwards Idempotency-Key to Gateway B upstream", async () => {
  let upstreamHeaders: Headers | undefined;
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    upstreamHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify({ usage: { total_tokens: 10 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  await SELF.fetch("https://octg.test/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TEST_CLIENT_KEY}`,
      "idempotency-key": "idem-upstream-1",
    },
    body: JSON.stringify({ model: "gpt-5", messages: [{ role: "user", content: "hi" }] }),
  });
  expect(upstreamHeaders?.get("Idempotency-Key")).toBe("idem-upstream-1");
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- apps/gateway-worker/test/proxy.test.ts
```

Expected: FAIL - `Idempotency-Key` header not present

- [ ] **Step 3: Add idempotencyKey to UpstreamMeta**

```typescript
export interface UpstreamMeta {
  client_id: string;
  pool: PoolNameLower;
  eligibility: "COMPLIMENTARY" | "PAID_ONLY";
  route: "free_shared" | "paid_shared";
  request_id: string;
  idempotency_key?: string;
}
```

- [ ] **Step 4: Forward header in callUpstream**

```typescript
if (meta.idempotency_key) {
  headers["Idempotency-Key"] = meta.idempotency_key;
}
```

- [ ] **Step 5: Pass idempotencyKey in proxy.ts**

```typescript
{
  client_id: auth.id,
  pool: toPoolLower(pool),
  eligibility: "COMPLIMENTARY",
  route: "free_shared",
  request_id: requestId,
  idempotency_key: idempotencyKey,
}
```

- [ ] **Step 6: Run tests**

```bash
npm test -- apps/gateway-worker/test/proxy.test.ts
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/gateway-worker/src/upstream.ts apps/gateway-worker/src/proxy.ts apps/gateway-worker/test/proxy.test.ts
git commit -m "feat: forward Idempotency-Key to Gateway B upstream"
```

---

## Task 5: 再送時の重複排除動作を実装

**Files:**
- Modify: `durable-objects/quota-controller/src/quota-controller.ts`
- Modify: `apps/gateway-worker/src/proxy.ts`

**Interfaces:**
- Consumes: 同一 `idempotencyKey` による再送
- Produces: 二重操作防止 + 409 Conflict 応答（ストリーミング時）

- [ ] **Step 1: Write the failing test**

```typescript
it("deduplicates reserve and settle for same idempotency key", async () => {
  const fetchMock = vi.fn();
  let callCount = 0;
  fetchMock.mockImplementation(async () => {
    callCount++;
    return new Response(JSON.stringify({
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);

  const first = await authedWithIdempotency("idem-dedupe-1", { model: "gpt-5", messages: [{ role: "user", content: "hi" }] });
  const second = await authedWithIdempotency("idem-dedupe-1", { model: "gpt-5", messages: [{ role: "user", content: "hi" }] });

  expect(first.status).toBe(200);
  expect(second.status).toBe(409);
  expect(callCount).toBe(1);
  const state = await todayStub().getState();
  expect(state.confirmedTokens).toBe(150);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- apps/gateway-worker/test/proxy.test.ts
```

Expected: FAIL - second request processed as new

- [ ] **Step 3: Detect duplicate in reserve and return conflict**

In `quota-controller.ts` reserve, when `idempotencyKey` maps to an existing entry that is already beyond `reserved`:

- Return a new result type or throw to indicate duplicate

Add to shared types:

```typescript
export type ReserveResult =
  | { readonly ok: true; readonly remaining: number; readonly resetAt: string }
  | { readonly ok: false; readonly reason: "insufficient_quota"; readonly remaining: number; readonly resetAt: string }
  | { readonly ok: false; readonly reason: "duplicate_idempotency_key"; readonly requestId: string; readonly resetAt: string };
```

- [ ] **Step 4: Handle duplicate in proxy.ts**

When reserve returns `duplicate_idempotency_key`:

- For non-streaming requests with stored response body: return stored body
- For streaming or missing stored body: return `409 Conflict`

- [ ] **Step 5: Store response body for non-streaming**

In DO RequestEntry, add `responseBody?: string` and `responseStatus?: number`.
After upstream returns, store the body if non-streaming.

- [ ] **Step 6: Run tests**

```bash
npm test -- apps/gateway-worker/test/proxy.test.ts
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add durable-objects/quota-controller/src apps/gateway-worker/src packages/shared/src/types.ts apps/gateway-worker/test/proxy.test.ts
git commit -m "feat: deduplicate reserve/settle for duplicate Idempotency-Key"
```

---

## Task 6: ドキュメント更新

**Files:**
- Modify: `docs/cloudflare-ai-gateway-custom-provider.md`
- Modify: `SPEC.md`

- [ ] **Step 1: Update custom provider doc**

In the retry section, replace the existing bullet with:

```markdown
- **retry を有効化する場合の冪等契約**: Gateway A が retry する場合、同じ論理リクエストは同一の `Idempotency-Key` ヘッダーを持つ必要があります。OCTG Worker は Gateway A から転送された `Idempotency-Key` を受信し、Durable Object 内で key 単位の重複排除を行います。同一 key に対しては 1 回の `reserve` と 1 回の `settle` のみ実行します。Worker は同じ key を Gateway B への upstream call でも転送します。key が欠落した場合は新規リクエストとして処理されます。key の重複排除スコープは Durable Object 単位（pool × UTC day）です。保持 TTL は Durable Object の既存ライフサイクルに従います。再送時のレスポンスは、非ストリーミングでは保存済みの上流応答を返し、ストリーミングでは `409 Conflict` を返します。
```

- [ ] **Step 2: Update SPEC.md if needed**

Update sections 4.3 / 5.6 to mention `Idempotency-Key` behavior.

- [ ] **Step 3: Run typecheck and tests**

```bash
npm run typecheck
npm test
```

- [ ] **Step 4: Commit**

```bash
git add docs/cloudflare-ai-gateway-custom-provider.md SPEC.md
git commit -m "docs: clarify Idempotency-Key retry idempotency contract"
```

---

## Task 7: Final verification

- [ ] Run full typecheck

```bash
npm run typecheck
```

- [ ] Run full test suite

```bash
npm test
```

- [ ] Review diff

```bash
git diff --stat
```

Expected deliverables:
- `Idempotency-Key` header read in proxy
- Same key forwarded to Gateway B
- QuotaController deduplicates by key
- Tests cover duplicate reserve/settle and upstream forwarding
- Documentation updated
