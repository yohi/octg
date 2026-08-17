# Worker 入力サイズ上限 Implementation Plan

> **Superseded:** This historical plan is replaced by `docs/superpowers/plans/2026-08-15-free-plan-opencode-compaction.md`, which defines the current 1 MiB input limit. Do not reintroduce the historical 131072-byte value when implementing new changes.
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 巨大な入力が tokenizer と upstream に到達する前に拒否し、Cloudflare Worker の resource limit エラーを防ぐ。

**Architecture:** Shared の正規化層で UTF-8 byte 数を測定し、Worker は環境変数から解決した上限を予約処理の前に適用する。既存の `request_too_large` HTTP 413 契約を再利用し、Durable Object と upstream には超過リクエストを送らない。

**Tech Stack:** TypeScript strict, Cloudflare Workers, Durable Objects, Vitest, `@cloudflare/vitest-pool-workers`.

## Global Constraints

- authoritative なクォータ制御は Durable Object が担う。
- `octg_sk_*` などの認証素材をログ・コードへ出力しない。
- 監査ログの D1 書き込みは best-effort であり、課金判定に依存させない。
- 既存の npm workspaces、TypeScript strict、Vitest 構成を維持する。

### Task 1: 正規化層の入力サイズ判定

**Files:**
- Modify: `packages/shared/src/normalize.ts`
- Modify: `packages/shared/src/errors.ts`
- Modify: `packages/shared/test/normalize.test.ts`

**Interfaces:**
- Produces `MAX_NORMALIZED_INPUT_BYTES`, `inputBytes`, and `input_too_large` normalization behavior for Worker callers.

- [ ] **Step 1: Write failing tests**
  - Chat の ASCII と multi-byte UTF-8 を byte 数で判定するテストを追加する。
  - Responses の `opaqueInputBytes` を合算して判定するテストを追加する。

- [ ] **Step 2: Run the focused tests and confirm they fail for the missing behavior**

  Run: `npm run test -w packages/shared -- --run test/normalize.test.ts`

  Expected: new assertions fail because normalized requests do not expose or reject input size.

- [ ] **Step 3: Implement the smallest shared behavior**
  - UTF-8 byte 数を計算する。
  - 既定値 131072 bytes を使い、超過時は `{ ok: false, error: "input_too_large" }` を返す。
  - Responses は opaque bytes を含めて判定する。

- [ ] **Step 4: Run the focused tests and confirm they pass**

  Run: `npm run test -w packages/shared -- --run test/normalize.test.ts`

- [ ] **Step 5: Commit**

  Git commit is intentionally omitted because repository instructions require an explicit user request before git operations.

### Task 2: Worker の設定値と HTTP 413 経路

**Files:**
- Modify: `apps/gateway-worker/src/index.ts`
- Modify: `apps/gateway-worker/src/proxy.ts`
- Modify: `apps/gateway-worker/src/errors.ts` if a Worker-specific error helper is required
- Modify: `apps/gateway-worker/test/proxy-failures.test.ts`
- Modify: `apps/gateway-worker/wrangler.jsonc`

**Interfaces:**
- Consumes shared normalization `input_too_large` result.
- Produces HTTP 413 with `request_too_large`, no upstream call, and no quota reservation for oversized requests.

- [ ] **Step 1: Write the failing Worker integration test**
  - Set the test environment limit below a known request size.
  - Stub upstream fetch and assert the response is 413, the error code is `request_too_large`, fetch count is zero, and quota state is unchanged.

- [ ] **Step 2: Run the focused Worker test and confirm it fails**

  Run: `npm run test -w apps/gateway-worker -- --run test/proxy-failures.test.ts`

- [ ] **Step 3: Implement configuration resolution and early rejection**
  - Add optional `MAX_INPUT_BYTES` to `Env` and set `131072` in `wrangler.jsonc`.
  - Parse only positive safe integers, otherwise use the default.
  - Map `input_too_large` to the existing 413 response before model classification, quota lookup, reservation, or upstream call.

- [ ] **Step 4: Run the focused Worker tests and confirm they pass**

  Run: `npm run test -w apps/gateway-worker -- --run test/proxy-failures.test.ts test/proxy.test.ts`

- [ ] **Step 5: Run type checks**

  Run: `npm run typecheck`

### Task 3: Full verification and manual HTTP surface check

**Files:**
- No additional files.

- [ ] **Step 1: Run all tests**

  Run: `npm test`

- [ ] **Step 2: Run diagnostics on every changed TypeScript file**

  Run LSP diagnostics for all changed `.ts` files and resolve all errors.

- [ ] **Step 3: Exercise the Worker surface**

  Start the gateway Worker in local mode, submit one request just below the configured limit and one above it, and verify the first reaches upstream while the second returns HTTP 413 without an upstream call.
