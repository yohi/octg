# Tokenizer レビュー指摘 3件対応 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 3件のコードレビュー指摘（shared テスト移行計画の明記、TokenizerController RPC 化と RPC-size ceiling の検証、rollback forward-fix 手順の具体化）を設計書・要件書・コードに反映する。

**Architecture:** 設計書 `docs/superpowers/specs/2026-08-17-tokenizer-durable-object-design.md` の既存仕様に従い、`durable-objects/tokenizer-controller` を Durable Object 化し、`apps/gateway-worker/src/proxy.ts` から direct BPE 呼び出しを排除する。ドキュメント指摘は並行して更新する。

**Tech Stack:** TypeScript strict, Cloudflare Workers, Durable Objects, Vitest, `@cloudflare/vitest-pool-workers`, npm workspaces.

## Global Constraints

- TypeScript strict mode; no `as any`, `@ts-ignore`, `@ts-expect-error`.
- TDD: write failing tests before implementation code.
- Follow the existing design doc for RPC contract, types, fail-closed behavior, observability, and migration.
- Do not create new AI agent config files.
- Do not commit or push; user handles git operations.
- Keep changes minimal; avoid unrelated refactoring.
- Use Japanese for user-facing prose; English is OK for code/comments if the project already uses English.

---

## Task 1: 指摘1 — 設計書に shared テスト移行計画と golden fixture 配置を明記

**Files:**
- Modify: `docs/superpowers/specs/2026-08-17-tokenizer-durable-object-design.md` §4.3, §11.1

**Interfaces:**
- No code interfaces. Document-only change.

- [ ] **Step 1: Update §4.3 Shared package**

  After the existing bullet list ending at line 132, append a paragraph:

  ```markdown
  実装計画では、既存 `packages/shared/test/estimate.test.ts` から
  `estimateInputTokens()` および `js-tiktoken` に依存するテストを
  `durable-objects/tokenizer-controller` workspace へ移行する手順を明記する。
  移行後、`packages/shared/test/estimate.test.ts` には
  `safetyMargin()`、`upperBoundOf()`、`decideOutput()` の算術テストのみを残す。
  ```

- [ ] **Step 2: Update §11.1 Tokenizer unit test**

  In the existing paragraph at lines 415-417, replace the vague "保存する" text with:

  ```markdown
  parity は移行前の `estimateInputTokens()` から取得した数値を golden case として、
  `durable-objects/tokenizer-controller/test/fixtures/tokenization-golden.json` に保存する。
  旧 BPE 実装を shared または test helper に残さない。
  ```

- [ ] **Step 3: Verify doc change**

  Read the modified sections and confirm both the migration steps and the fixture path are present.

---

## Task 2: 指摘3 — REQUIREMENTS の rollback forward-fix 手順を具体化

**Files:**
- Modify: `REQUIREMENTS_2026-08-17.md` §24 (lines 1192-1205)
- Create: `docs/runbooks/incident-v2-deployment-failure.md` (if it does not exist)

**Interfaces:**
- No code interfaces. Document-only change.

- [ ] **Step 1: Replace line 1205 vague forward-fix text**

  Replace:

  ```markdown
  v2 デプロイそのものが失敗した場合は forward-fix を行う。手順は別途 incident runbook に記載する。
  ```

  With:

  ```markdown
  v2 デプロイそのものが失敗した場合（例: `v2` migration の適用失敗、`TokenizerController`
  クラスの登録失敗、または v2 互換 revision 自体が正常にデプロイできない場合）、
  rollback 先が存在しないため **forward-fix** を行う。

  forward-fix の手順:

  1. 影響を受けた Worker / Durable Object のエラーログを収集し、失敗カテゴリーを特定する。
  2. 既存の `v1` revision（TokenizerDO 未搭載）が稼働中であることを確認し、
     既存トラフィックへの影響を監視する。必要に応じて `v1` revision への緊急 rollback を検討する。
  3. `v2` migration または `TokenizerController` 実装の修正を行い、
     ローカルおよびステージング環境で `npm test` と `npm run typecheck` が成功することを確認する。
  4. 修正版を **新しい deployment** として再デプロイする。同じ `v2` migration tag を
     書き換えず、必要に応じて `v3` 以降の migration tag として追加修正を適用する。
  5. デプロイ後、canary トラフィックで `TokenizerController` の RPC 呼び出しと
     quota lifecycle が正常であることを検証する。

  詳細な対応フロー、連絡先、escalation 条件は
  `docs/runbooks/incident-v2-deployment-failure.md` を参照する。
  ```

- [ ] **Step 2: Create or reference incident runbook**

  If `docs/runbooks/incident-v2-deployment-failure.md` does not exist, create it with a concise template covering:
  - failure categories (migration failure, class registration failure, binding mismatch)
  - log queries
  - rollback criteria to `v1`
  - forward-fix validation checklist
  - escalation contacts

- [ ] **Step 3: Verify doc change**

  Read `REQUIREMENTS_2026-08-17.md` lines 1192-1220 and confirm the forward-fix steps and runbook reference are present.

---

## Task 3: 指摘2 — TokenizerController Durable Object 実装

**Files:**
- Create: `durable-objects/tokenizer-controller/src/tokenizer-controller.ts`
- Modify: `durable-objects/tokenizer-controller/src/tokenizer.ts` (keep internal helper or inline)
- Modify: `durable-objects/tokenizer-controller/package.json`
- Create: `durable-objects/tokenizer-controller/test/tokenizer-controller.test.ts`
- Create: `durable-objects/tokenizer-controller/test/fixtures/tokenization-golden.json`

**Interfaces:**
- Consumes: `js-tiktoken` `getEncoding`, `Tiktoken`; Cloudflare `DurableObject`, `console.log`.
- Produces:
  - `export interface TokenizeRequest { requestId: string; inputText: string; messageCount: number; opaqueInputBytes: number; }`
  - `export interface TokenizeResult { estimatedInputTokens: number; estimationPath: "exact_bpe" | "conservative_bytes"; }`
  - `export type TokenizerOutcome = { readonly kind: "resolved"; readonly result: TokenizeResult } | { readonly kind: "unavailable" };`
  - `export class TokenizerController extends DurableObject { async estimate(request: unknown): Promise<TokenizerOutcome> }`

- [ ] **Step 1: Write failing tests for TokenizerController**

  Create `durable-objects/tokenizer-controller/test/tokenizer-controller.test.ts` with tests for:
  - exact BPE parity for known inputs (use golden fixture)
  - conservative byte fallback when `getEncoding` throws
  - conservative byte fallback when `encode` throws
  - retry exact BPE on the next request after a transient init failure
  - rejection of invalid request shapes (missing/invalid fields)
  - safe-integer validation of the result
  - no storage/D1 writes
  - no input text logged

- [ ] **Step 2: Create golden fixture**

  Create `durable-objects/tokenizer-controller/test/fixtures/tokenization-golden.json`:

  ```json
  {
    "description": "Golden token counts produced by the pre-migration estimateInputTokens() implementation using o200k_base.",
    "cases": [
      { "inputText": "Hello world", "messageCount": 1, "opaqueInputBytes": 0, "expectedTokens": 9, "estimationPath": "exact_bpe" },
      { "inputText": "abcabcabc", "messageCount": 3, "opaqueInputBytes": 0, "expectedTokens": 17, "estimationPath": "exact_bpe" },
      { "inputText": "visible", "messageCount": 1, "opaqueInputBytes": 28, "expectedTokens": 37, "estimationPath": "exact_bpe" },
      { "inputText": "こんにちは", "messageCount": 1, "opaqueInputBytes": 0, "expectedTokens": 14, "estimationPath": "exact_bpe" }
    ]
  }
  ```

  Adjust `expectedTokens` to actual `o200k_base` counts after running the legacy function.

- [ ] **Step 3: Run tests and confirm they fail**

  ```bash
  npm test -w durable-objects/tokenizer-controller
  ```

  Expected: tests fail because `TokenizerController` does not exist.

- [ ] **Step 4: Implement TokenizerController**

  Create `durable-objects/tokenizer-controller/src/tokenizer-controller.ts`:

  ```ts
  import { DurableObject } from "cloudflare:workers";
  import { getEncoding, type Tiktoken } from "js-tiktoken";

  export interface TokenizeRequest {
    readonly requestId: string;
    readonly inputText: string;
    readonly messageCount: number;
    readonly opaqueInputBytes: number;
  }

  export interface TokenizeResult {
    readonly estimatedInputTokens: number;
    readonly estimationPath: "exact_bpe" | "conservative_bytes";
  }

  export type TokenizerOutcome =
    | { readonly kind: "resolved"; readonly result: TokenizeResult }
    | { readonly kind: "unavailable" };

  export class TokenizerController extends DurableObject {
    private encoding: Tiktoken | undefined;

    async estimate(request: unknown): Promise<TokenizerOutcome> {
      const validated = validateTokenizeRequest(request);
      if (validated === null) return { kind: "unavailable" };

      try {
        const base = this.tokenCount(validated.inputText);
        const estimated = base + validated.opaqueInputBytes + 4 * validated.messageCount + 3;
        if (!Number.isSafeInteger(estimated) || estimated < 0) {
          return { kind: "unavailable" };
        }
        return {
          kind: "resolved",
          result: { estimatedInputTokens: estimated, estimationPath: "exact_bpe" },
        };
      } catch {
        const base = new TextEncoder().encode(validated.inputText).length;
        const estimated = base + validated.opaqueInputBytes + 4 * validated.messageCount + 3;
        if (!Number.isSafeInteger(estimated) || estimated < 0) {
          return { kind: "unavailable" };
        }
        return {
          kind: "resolved",
          result: { estimatedInputTokens: estimated, estimationPath: "conservative_bytes" },
        };
      }
    }

    private tokenCount(text: string): number {
      if (this.encoding === undefined) {
        this.encoding = getEncoding("o200k_base");
      }
      return this.encoding.encode(text).length;
    }
  }

  function validateTokenizeRequest(request: unknown): TokenizeRequest | null {
    if (typeof request !== "object" || request === null) return null;
    const r = request as Record<string, unknown>;
    if (typeof r.requestId !== "string" || r.requestId.length === 0) return null;
    if (typeof r.inputText !== "string") return null;
    if (!Number.isSafeInteger(r.messageCount) || (r.messageCount as number) < 0) return null;
    if (!Number.isSafeInteger(r.opaqueInputBytes) || (r.opaqueInputBytes as number) < 0) return null;
    return r as TokenizeRequest;
  }
  ```

  Add structured `octg.tokenizer_stage` logs as required by the design doc §9.2.

- [ ] **Step 5: Update package exports**

  Modify `durable-objects/tokenizer-controller/package.json`:

  ```json
  "exports": {
    ".": "./src/tokenizer-controller.ts"
  }
  ```

  Keep `js-tiktoken` dependency.

- [ ] **Step 6: Run tests and confirm they pass**

  ```bash
  npm test -w durable-objects/tokenizer-controller
  ```

  Expected: all tokenizer-controller tests pass.

---

## Task 4: 指摘2 — Gateway Worker binding と migration 追加

**Files:**
- Modify: `apps/gateway-worker/src/index.ts`
- Modify: `apps/gateway-worker/wrangler.jsonc`

**Interfaces:**
- Consumes: `TokenizerController` from `@octg/tokenizer-controller`.
- Produces: `Env.TOKENIZER_CONTROLLER` binding; exported `TokenizerController` class; v2 migration.

- [ ] **Step 1: Add TOKENIZER_CONTROLLER to Env**

  In `apps/gateway-worker/src/index.ts`, add to `Env`:

  ```ts
  readonly TOKENIZER_CONTROLLER: DurableObjectNamespace<TokenizerController>;
  ```

  Add import:

  ```ts
  import { TokenizerController } from "@octg/tokenizer-controller";
  ```

  Export the class:

  ```ts
  export { QuotaController, TokenizerController };
  ```

- [ ] **Step 2: Update wrangler.jsonc**

  In `apps/gateway-worker/wrangler.jsonc`, change `durable_objects.bindings` to:

  ```json
  "durable_objects": {
    "bindings": [
      { "name": "QUOTA_CONTROLLER", "class_name": "QuotaController" },
      { "name": "TOKENIZER_CONTROLLER", "class_name": "TokenizerController" }
    ]
  }
  ```

  Append v2 migration:

  ```json
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["QuotaController"] },
    { "tag": "v2", "new_sqlite_classes": ["TokenizerController"] }
  ]
  ```

- [ ] **Step 3: Typecheck**

  ```bash
  npm run typecheck -w apps/gateway-worker
  ```

  Expected: no errors.

---

## Task 5: 指摘2 — Gateway tokenizer client 作成

**Files:**
- Create: `apps/gateway-worker/src/tokenizer.ts`
- Create: `apps/gateway-worker/test/tokenizer.test.ts`

**Interfaces:**
- Consumes: `TokenizerController`, `TokenizeResult` from `@octg/tokenizer-controller`; `Env` from `./index`.
- Produces:
  - `export type TokenizeOutcome = { readonly kind: "resolved"; readonly result: TokenizeResult } | { readonly kind: "unavailable" };`
  - `export async function tokenize(env: Env, request: TokenizeClientRequest): Promise<TokenizeOutcome>`

- [ ] **Step 1: Write failing tests for the tokenizer client**

  Create `apps/gateway-worker/test/tokenizer.test.ts` with tests that mock the Durable Object stub:
  - resolves `tokenizer:primary` stub
  - calls `stub.estimate(request)` once
  - returns resolved result on success
  - returns unavailable on RPC exception
  - returns unavailable on malformed response

- [ ] **Step 2: Run tests and confirm they fail**

  ```bash
  npm test -w apps/gateway-worker -- tokenizer.test.ts
  ```

- [ ] **Step 3: Implement tokenizer client**

  Create `apps/gateway-worker/src/tokenizer.ts`:

  ```ts
  import type { TokenizerController, TokenizeResult } from "@octg/tokenizer-controller";
  import type { Env } from "./index";

  export interface TokenizeClientRequest {
    readonly requestId: string;
    readonly inputText: string;
    readonly messageCount: number;
    readonly opaqueInputBytes: number;
  }

  export type TokenizeOutcome =
    | { readonly kind: "resolved"; readonly result: TokenizeResult }
    | { readonly kind: "unavailable" };

  export async function tokenize(
    env: Env,
    request: TokenizeClientRequest,
  ): Promise<TokenizeOutcome> {
    const stub = env.TOKENIZER_CONTROLLER.get(
      env.TOKENIZER_CONTROLLER.idFromName("tokenizer:primary"),
    );
    try {
      const result = await stub.estimate(request);
      if (
        typeof result !== "object" ||
        result === null ||
        !("estimatedInputTokens" in result) ||
        !("estimationPath" in result) ||
        typeof result.estimatedInputTokens !== "number" ||
        !Number.isSafeInteger(result.estimatedInputTokens) ||
        result.estimatedInputTokens < 0 ||
        (result.estimationPath !== "exact_bpe" && result.estimationPath !== "conservative_bytes")
      ) {
        return { kind: "unavailable" };
      }
      return {
        kind: "resolved",
        result: result as TokenizeResult,
      };
    } catch {
      return { kind: "unavailable" };
    }
  }
  ```

- [ ] **Step 4: Run tests and confirm they pass**

  ```bash
  npm test -w apps/gateway-worker -- tokenizer.test.ts
  ```

---

## Task 6: 指摘2 — proxy.ts から direct BPE 呼び出しを削除

**Files:**
- Modify: `apps/gateway-worker/src/proxy.ts`
- Modify: `apps/gateway-worker/test/proxy-failures.test.ts`
- Modify: `apps/gateway-worker/test/proxy.test.ts`

**Interfaces:**
- Consumes: `tokenize` from `./tokenizer`; removes `estimateInputTokens` import from `@octg/tokenizer-controller`.
- Produces: tokenize stage emits `estimationPath`; unavailable returns 500 with `errInternal`.

- [ ] **Step 1: Write/update failing tests**

  Update `apps/gateway-worker/test/proxy-failures.test.ts` and `apps/gateway-worker/test/proxy.test.ts`:
  - Remove direct import of `estimateInputTokens`.
  - Mock `tokenize` or the DO stub so tokenizer success/failure can be injected.
  - Add tests: tokenizer unavailable → 500, no reserve, no upstream.

- [ ] **Step 2: Run tests and confirm they fail**

  ```bash
  npm test -w apps/gateway-worker -- proxy-failures.test.ts proxy.test.ts
  ```

- [ ] **Step 3: Modify proxy.ts**

  - Remove `import { estimateInputTokens } from "@octg/tokenizer-controller";`.
  - Add `import { tokenize, type TokenizeOutcome } from "./tokenizer";`.
  - Replace the tokenize stage block (lines 372-388) with:

    ```ts
    const tokenizeStartedAt = startResourceStage(env, requestId, "tokenize");
    let tokenizeOutcome: TokenizeOutcome;
    try {
      tokenizeOutcome = await tokenize(env, {
        requestId,
        inputText: requestData.inputText,
        messageCount: requestData.messageCount,
        opaqueInputBytes: requestData.opaqueInputBytes,
      });
    } catch {
      tokenizeOutcome = { kind: "unavailable" };
    }

    if (tokenizeOutcome.kind === "unavailable") {
      finishResourceStage(env, requestId, "tokenize", tokenizeStartedAt, "exception", {
        route: "error:tokenizer_unavailable",
        inputBytes: requestData.inputBytes,
        inputTextBytes: requestData.inputTextBytes,
        opaqueInputBytes: requestData.opaqueInputBytes,
        quotaReserved: false,
        upstreamReached: false,
      });
      return errorResponse(errInternal(requestId));
    }

    const estimatedInput = tokenizeOutcome.result.estimatedInputTokens;
    finishResourceStage(env, requestId, "tokenize", tokenizeStartedAt, "success", {
      inputBytes: requestData.inputBytes,
      inputTextBytes: requestData.inputTextBytes,
      opaqueInputBytes: requestData.opaqueInputBytes,
      estimationPath: tokenizeOutcome.result.estimationPath,
    });
    ```

  - Ensure no code path after tokenizer failure reaches `quota_reserve` or upstream.

- [ ] **Step 4: Run tests and confirm they pass**

  ```bash
  npm test -w apps/gateway-worker -- proxy-failures.test.ts proxy.test.ts
  ```

---

## Task 7: 指摘2 — RPC-size ceiling の根拠と境界テストを追加

**Files:**
- Modify: `apps/gateway-worker/src/proxy.ts` (comments)
- Modify: `apps/gateway-worker/test/proxy-failures.test.ts`
- Modify: `docs/superpowers/specs/2026-08-17-tokenizer-durable-object-design.md` §5.1

**Interfaces:**
- No new code interfaces. Adds invariant documentation and boundary test.

- [ ] **Step 1: Document 65,536-byte overhead rationale**

  In `apps/gateway-worker/src/proxy.ts` lines 56-60, update the comment:

  ```ts
  // Durable Object RPC serialization is limited to 32 MiB. This ceiling reserves
  // 65,536 bytes for JSON framing, field names, and the requestId string so that
  // the serialized TokenizeRequest { requestId, inputText, messageCount, opaqueInputBytes }
  // stays strictly below 32 MiB even when inputText and opaqueInputBytes are each
  // at the resolved maximum. Never increase this ceiling without also defining a
  // stream or chunk protocol.
  const MAX_TOKENIZATION_RPC_INPUT_BYTES = 32 * 1024 * 1024 - 65_536;
  ```

  In `docs/superpowers/specs/2026-08-17-tokenizer-durable-object-design.md` §5.1, replace the blockquote at lines 159-162 with:

  ```markdown
  > `resolveMaxInputBytes()` never returns a value that, combined with the UTF-8
  > byte length of `inputText`, `opaqueInputBytes`, and JSON serialization overhead
  > (65,536 bytes reserved for field names, `requestId`, and framing), exceeds the
  > 32 MiB Durable Object RPC limit. Inputs that would exceed this ceiling are
  > rejected before the tokenizer RPC by the existing body size limit. Allowing
  > larger inputs requires a stream or chunk protocol to be defined.
  ```

- [ ] **Step 2: Add boundary test for serialized RPC request size**

  In `apps/gateway-worker/test/proxy-failures.test.ts`, add tests under `describe("resolveMaxInputBytes")`:

  ```ts
  it("keeps a serialized request with max inputText below 32 MiB", () => {
    const maxInputBytes = resolveMaxInputBytes(String(MAX_TOKENIZATION_RPC_INPUT_BYTES));
    const request = {
      requestId: "req_" + "x".repeat(64),
      inputText: "a".repeat(maxInputBytes),
      messageCount: Number.MAX_SAFE_INTEGER,
      opaqueInputBytes: 0,
    };
    expect(JSON.stringify(request).length).toBeLessThan(32 * 1024 * 1024);
  });

  it("keeps a serialized request with max inputText and opaqueInputBytes below 32 MiB", () => {
    const maxInputBytes = resolveMaxInputBytes(String(MAX_TOKENIZATION_RPC_INPUT_BYTES));
    const request = {
      requestId: "req_" + "x".repeat(64),
      inputText: "a".repeat(maxInputBytes),
      messageCount: Number.MAX_SAFE_INTEGER,
      opaqueInputBytes: maxInputBytes,
    };
    expect(JSON.stringify(request).length).toBeLessThan(32 * 1024 * 1024);
  });
  ```

- [ ] **Step 3: Run tests and confirm they pass**

  ```bash
  npm test -w apps/gateway-worker -- proxy-failures.test.ts
  ```

---

## Task 8: 全検証

- [ ] **Step 1: Typecheck all workspaces**

  ```bash
  npm run typecheck
  ```

  Expected: exit 0.

- [ ] **Step 2: Run all tests**

  ```bash
  npm test
  ```

  Expected: all tests pass.

- [ ] **Step 3: Static dependency isolation check**

  Run:

  ```bash
  grep -R "js-tiktoken\|getEncoding\|encoding\.encode\|estimateInputTokens" apps/gateway-worker/src packages/shared/src packages/shared/test --include="*.ts" || true
  ```

  Expected: no production-code matches in gateway-worker/src or shared/src/test.

---

## Dependency Graph

```text
Task 1 (docs #1) ────────────────────────┐
                                          │
Task 3 (TokenizerController DO) ──► Task 4 (Gateway binding) ──► Task 5 (Gateway client) ──► Task 6 (proxy.ts)
                                          │                                                   │
Task 2 (docs #3) ────────────────────────┘                                                   ▼
                                                                                          Task 7 (RPC ceiling)
                                                                                               │
                                                                                               ▼
                                                                                          Task 8 (verification)
```

Task 1, Task 2, and Task 3 can start in parallel. Task 4 depends on Task 3. Task 5 depends on Task 4. Task 6 depends on Task 5. Task 7 depends on Task 6. Task 8 depends on all previous tasks.
