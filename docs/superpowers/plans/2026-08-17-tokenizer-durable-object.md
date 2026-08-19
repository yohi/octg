# Tokenizer Durable Object Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

<!-- markdownlint-disable MD013 MD024 MD032 MD036 -->

**Goal:** `o200k_base` exact BPE を専用の SQLite-backed
`TokenizerController` Durable Object へ移し、Gateway Worker の production
path から BPE を除去しながら、tokenization 成功後だけ既存 quota lifecycle
へ進む fail-closed な処理を実現する。

**Architecture:** `@octg/tokenizer-controller` は request validation、lazy
encoding、exact BPE、捕捉可能な BPE 例外時の conservative byte fallback、
safe-integer 検証、安全な stage logging を所有する。Gateway は固定 ID
`tokenizer:primary` へ 1 回だけ RPC し、response と quota 算術を独立に検証して
から既存の reserve / upstream / settle / markUncertain / release へ進む。変更は
単一 PR にまとめず、基盤から受入証跡まで 4 個の stacked PR として提出する。

**Tech Stack:** TypeScript strict, Cloudflare Workers, SQLite-backed Durable
Objects, D1, npm workspaces, Vitest, `@cloudflare/vitest-pool-workers`,
`js-tiktoken`, Wrangler 4.

## Global Constraints

- Workers Free Plan を維持し、CPU limit 引き上げ設定を追加しない。
- 処理順序は `normalize -> model/policy -> quota_get_state -> tokenizer RPC -> quota arithmetic -> quota_reserve -> in-flight -> upstream` とする。
- Tokenizer 成功後にのみ quota reservation を行う。
- Reservation、Settlement、Fail-Closed、No Paid Fallback の既存契約を変更しない。
- 正常系は `base = o200k_base.encode(inputText).length`、`estimated = base + opaqueInputBytes + 4 * messageCount + 3` を使用する。
- `getEncoding()` または `encode()` が通常の `Error` を投げた場合だけ、UTF-8 byte length を base とする conservative fallback を返す。
- request validation failure、非 `Error` throw、safe-integer failure は fallback せず RPC failure とする。
- 初期化失敗を instance に保存せず、次 request で `getEncoding("o200k_base")` を再試行する。
- Gateway は Tokenizer RPC を再試行せず、独自 timeout を追加しない。
- Gateway 内の BPE、byte fallback、upstream fallback、paid fallback を禁止する。
- Tokenizer failure または malformed result では外部 API 契約として HTTP 500、code `internal_error`、route `error:internal_error` を返し、`Retry-After` を付与しない。外部 response には既存 `errInternal()` を流用し、quota snapshot header と `X-OCTG-Route: error:internal_error` を付与する。
- 内部 `octg.resource_stage` の失敗 route は `error:tokenizer_unavailable` とし、HTTP response の `X-OCTG-Route: error:internal_error` と混同しない。
- Tokenizer failure 時は `quotaReserved = false`、`upstreamReached = false` とし、reserve、release、markUncertain、upstream を呼ばない。
- fixed logical object ID は `tokenizer:primary` とし、sharding、result cache、prompt hash cache を実装しない。
- `resolveMaxInputBytes()` の有効上限を UTF-8 `16 MiB - 65,536 bytes` に cap する。既存 body-size validation が Tokenizer RPC より前にこの ceiling を適用する。
- RPC 発行直前に `TokenizeRequest` の V8 serialized payload worst-case size を保守的に推定し、`>= 32 MiB` なら RPC を呼ばず fail-closed とする。stream/chunk protocol は本変更の対象外。
- Tokenizer package は `@octg/shared` に依存しない。`REQUIREMENTS_2026-08-17.md:687-700` の依存図より、設計書 `docs/superpowers/specs/2026-08-17-tokenizer-durable-object-design.md:50-53` の明示的な依存禁止を優先する。
- Tokenizer は Durable Object Storage、D1、QuotaController、外部 HTTP endpoint を使用しない。
- prompt、input text、message content、request body、Authorization、API key、raw token array、生の例外 message/stack を保存またはログ出力しない。
- `v1` Durable Object migration を変更せず、`v2` に `TokenizerController` を追加する。rollback 時も `v2` を削除・書き換えない。
- `as any`、`@ts-ignore`、`@ts-expect-error`、non-null assertion を追加しない。
- `apps/gateway-worker/src/proxy.ts` へ validation、算術、RPC client helper を追加しない。新規 module に分離し、`proxy.ts` の pure LOC を増やさない。
- 74,000-token fixture は短い非機密固定文字列を実行時に反復生成し、production payload を repository、Storage、D1、ログへ保存しない。
- production canary の expected peak は operator が明示指定し、`MAX_IN_FLIGHT_REQUESTS` から導出しない。

---

## File Structure

### New Tokenizer workspace

- Create `durable-objects/tokenizer-controller/package.json`: workspace metadata、`js-tiktoken` dependency、typecheck script。
- Create `durable-objects/tokenizer-controller/tsconfig.json`: shared strict TypeScript config と Workers types。
- Create `durable-objects/tokenizer-controller/src/contracts.ts`: RPC request/result types と request parser。
- Create `durable-objects/tokenizer-controller/src/observation.ts`: allowlisted `octg.tokenizer_stage` event。
- Create `durable-objects/tokenizer-controller/src/estimator.ts`: lazy encoding、exact/fallback、safe arithmetic。
- Create `durable-objects/tokenizer-controller/src/tokenizer-controller.ts`: public Durable Object RPC boundary。
- Create `durable-objects/tokenizer-controller/src/index.ts`: package public exports。
- Create `durable-objects/tokenizer-controller/test/fixtures/tokenization-golden.json`: 移行前 `estimateInputTokens()` から取得した golden case 期待値。
- Create `durable-objects/tokenizer-controller/test/contracts.test.ts`: request runtime validation。
- Create `durable-objects/tokenizer-controller/test/estimator.test.ts`: golden fixture parity、fallback、retry、reuse、overflow。
- Create `durable-objects/tokenizer-controller/test/observation.test.ts`: safe logging contract。
- Create `durable-objects/tokenizer-controller/test/tokenizer-controller.test.ts`: real DO RPC と Storage 非使用。

### Gateway integration

- Create `apps/gateway-worker/src/tokenizer.ts`: fixed ID resolution、single RPC、RPC preflight size check、response validation、outcome union。
- Create `apps/gateway-worker/src/token-budget.ts`: Gateway-side safe quota arithmetic と typed outcomes。
- Create `apps/gateway-worker/test/tokenizer-client.test.ts`: client call count、fixed ID、malformed result、RPC preflight。
- Create `apps/gateway-worker/test/token-budget.test.ts`: overflow、413、429、resolved budget。
- Create `apps/gateway-worker/test/tokenizer-integration.test.ts`: HTTP 500 fail-closed と quota lifecycle regression。
- Create `apps/gateway-worker/test/tokenizer-74k-regression.test.ts`: generated 74k exact BPE と Gateway path。
- Modify `apps/gateway-worker/src/index.ts`: Tokenizer class export と Env binding。
- Modify `apps/gateway-worker/src/proxy.ts`: local estimator block を tokenizer outcome と token budget orchestration に置換。`resolveMaxInputBytes()` の ceiling を `16 MiB - 65,536 bytes` に変更。
- Modify `apps/gateway-worker/src/resource-observation.ts`: `error:tokenizer_unavailable` route。
- Modify `apps/gateway-worker/wrangler.jsonc`: binding と immutable `v2` migration。
- Modify `apps/gateway-worker/vitest.config.ts`: Tokenizer workspace tests を Worker pool へ追加。
- Modify `apps/gateway-worker/package.json`: `@octg/tokenizer-controller` dependency。

### Shared cleanup and guards

- Modify `packages/shared/src/estimate.ts`: `estimateInputTokens`、encoding cache、`js-tiktoken` import を削除し、quota arithmetic だけを残す。
- Modify `packages/shared/src/errors.ts`: `errInternal()` を拡張し、optional `quota` と `route` を付与できるようにする。
- Modify `packages/shared/test/estimate.test.ts`: BPE tests を削除し、quota arithmetic tests を維持する。
- Modify `packages/shared/test/errors.test.ts`: `errInternal()` の拡張に対する test を追加する。
- Create `packages/shared/test/tokenizer-dependency-isolation.test.ts`: Gateway/shared production source の BPE isolation guard。
- Modify `packages/shared/package.json`: `js-tiktoken` dependency を削除する。
- Modify `package-lock.json`: workspace link と direct dependency ownership を npm で再生成する。

### Operations and evidence

- Modify `README.md`: architecture、deploy validation、rollback、large-input restriction。
- Modify `docs/DEPLOY_FROM_TEMPLATE.md`: `v2` migration を含む deploy/canary/rollback sequence。
- Modify `docs/troubleshooting-503-worker-resource-limits.md`: Tokenizer stage、Free Plan、AC-01〜AC-13 の証跡表。
- Verify without changing `docs/cloudflare-ai-gateway-custom-provider.md`: Gateway A/B の payload logging disabled 手順。
- Reuse `scripts/canary-worker-resource-limits.mjs`: concurrency `1,2,expected peak` の安全な JSONL driver。

---

## Stacked PR Delivery Strategy

この実装は **1 個の PR にまとめない**。次の 4 branch を trunk-first の線形 stack
として作成し、各 branch から 1 個ずつ、合計 4 個の stacked PR を提出する。

```text
(main)
  <- tokenizer-do/controller
  <- tokenizer-do/wiring
  <- tokenizer-do/cutover
  <- tokenizer-do/verification
```

| PR | Branch | Base | Scope | Merge gate |
| --- | --- | --- | --- | --- |
| 1 | `tokenizer-do/controller` | `main` | RPC contracts、golden fixture、estimator、safe logging、unit tests | Tokenizer focused tests と workspace typecheck |
| 2 | `tokenizer-do/wiring` | `tokenizer-do/controller` | Worker export、Env、Wrangler binding/v2、real DO test、Gateway client、RPC preflight | Wrangler-backed DO/client tests と gateway typecheck |
| 3 | `tokenizer-do/cutover` | `tokenizer-do/wiring` | token budget、500 internal_error contract、proxy cutover、74k Gateway regression、quota lifecycle regression | Gateway success/failure tests、reserve/upstream ordering |
| 4 | `tokenizer-do/verification` | `tokenizer-do/cutover` | shared cleanup、dependency guard、runbook、canary evidence | full test/typecheck、manual HTTP QA、production canary |

実装開始時に最下層を作成する。

```bash
gh stack init tokenizer-do/controller
```

各 PR の tasks と commits が green になってから次層を追加する。

```bash
gh stack add tokenizer-do/wiring
gh stack add tokenizer-do/cutover
gh stack add tokenizer-do/verification
```

全層完成後に draft PR を一括提出し、stack 構造を JSON で確認する。

```bash
gh stack submit --auto --remote origin
gh stack view --json
```

PR の merge は human operator が bottom-to-top で行う。実装 agent は merge を実行
しない。

---

## PR 1: `tokenizer-do/controller`

### Task 1: Workspace と RPC contracts を追加する

**Files:**

- Create: `durable-objects/tokenizer-controller/package.json`
- Create: `durable-objects/tokenizer-controller/tsconfig.json`
- Create: `durable-objects/tokenizer-controller/src/contracts.ts`
- Create: `durable-objects/tokenizer-controller/src/index.ts`
- Create: `durable-objects/tokenizer-controller/test/contracts.test.ts`
- Modify: `apps/gateway-worker/vitest.config.ts:20-26`
- Modify: `package-lock.json`

**Interfaces:**

- Produces: `TokenizeRequest`, `EstimationPath`, `TokenizeResult`。
- Produces: `parseTokenizeRequest(value: unknown): TokenizeRequest`。
- Constraint: runtime dependencies は `js-tiktoken` だけで、`@octg/shared` を含めない。

- [ ] **Step 1: Create manifest、test harness、failing contract tests**

Create the workspace manifest exactly with the existing workspace conventions:

```json
{
  "name": "@octg/tokenizer-controller",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc -p tsconfig.json" },
  "dependencies": { "js-tiktoken": "^1.0.12" },
  "devDependencies": { "@cloudflare/workers-types": "^4.20250617.0" }
}
```

Create `tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["@cloudflare/workers-types"] },
  "include": ["src"]
}
```

Add `../../durable-objects/tokenizer-controller/test/**/*.test.ts` to the existing
Vitest `include` array. In `contracts.test.ts`, write table-driven RED cases for a
valid request and each invalid boundary: non-object, empty request ID, non-string
input, negative/fractional/unsafe message count, and negative/fractional/unsafe
opaque bytes.

```ts
const valid = {
  requestId: "req_contract",
  inputText: "hello",
  messageCount: 1,
  opaqueInputBytes: 0,
} as const;

expect(parseTokenizeRequest(valid)).toEqual(valid);

it.each([
  null,
  { ...valid, requestId: "" },
  { ...valid, inputText: 1 },
  { ...valid, messageCount: -1 },
  { ...valid, messageCount: 1.5 },
  { ...valid, messageCount: Number.MAX_SAFE_INTEGER + 1 },
  { ...valid, opaqueInputBytes: -1 },
  { ...valid, opaqueInputBytes: 1.5 },
  { ...valid, opaqueInputBytes: Number.MAX_SAFE_INTEGER + 1 },
])("rejects invalid request %j", (value) => {
  expect(() => parseTokenizeRequest(value)).toThrow(TypeError);
});
```

- [ ] **Step 2: Run the contract test and verify RED**

Run:

```bash
npm install
npm exec vitest run --config apps/gateway-worker/vitest.config.ts \
  durable-objects/tokenizer-controller/test/contracts.test.ts
```

Expected: FAIL because `contracts.ts` and its parser do not exist.

- [ ] **Step 3: Implement exact readonly contracts and parser**

```ts
export interface TokenizeRequest {
  readonly requestId: string;
  readonly inputText: string;
  readonly messageCount: number;
  readonly opaqueInputBytes: number;
}

export type EstimationPath = "exact_bpe" | "conservative_bytes";

export interface TokenizeResult {
  readonly estimatedInputTokens: number;
  readonly estimationPath: EstimationPath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseTokenizeRequest(value: unknown): TokenizeRequest {
  if (!isRecord(value)) throw new TypeError("Invalid tokenizer request.");
  const { requestId, inputText, messageCount, opaqueInputBytes } = value;
  if (
    typeof requestId !== "string" || requestId.length === 0 ||
    typeof inputText !== "string" ||
    typeof messageCount !== "number" ||
    !Number.isSafeInteger(messageCount) || messageCount < 0 ||
    typeof opaqueInputBytes !== "number" ||
    !Number.isSafeInteger(opaqueInputBytes) || opaqueInputBytes < 0
  ) {
    throw new TypeError("Invalid tokenizer request.");
  }
  return { requestId, inputText, messageCount, opaqueInputBytes };
}
```

Re-export only the public contracts from `src/index.ts` at this step.

- [ ] **Step 4: Run focused test and workspace typecheck**

```bash
npm exec vitest run --config apps/gateway-worker/vitest.config.ts \
  durable-objects/tokenizer-controller/test/contracts.test.ts
npm run typecheck -w durable-objects/tokenizer-controller
```

Expected: both commands exit 0.

- [ ] **Step 5: Commit Task 1 on the bottom stack branch**

Run only after an explicit user instruction to perform git operations:

```bash
git add durable-objects/tokenizer-controller/package.json \
  durable-objects/tokenizer-controller/tsconfig.json \
  durable-objects/tokenizer-controller/src/contracts.ts \
  durable-objects/tokenizer-controller/src/index.ts \
  durable-objects/tokenizer-controller/test/contracts.test.ts \
  apps/gateway-worker/vitest.config.ts package-lock.json
git commit -m "feat: Tokenizer RPC契約を追加"
```

### Task 2: Golden fixture を作成し Lazy exact BPE と conservative fallback を実装する

**Files:**

- Create: `durable-objects/tokenizer-controller/test/fixtures/tokenization-golden.json`
- Create: `durable-objects/tokenizer-controller/src/estimator.ts`
- Create: `durable-objects/tokenizer-controller/src/observation.ts`
- Create: `durable-objects/tokenizer-controller/test/estimator.test.ts`
- Modify: `durable-objects/tokenizer-controller/src/index.ts`

**Interfaces:**

- Consumes: validated `TokenizeRequest`。
- Produces: `TokenizerEstimator.estimate(request, context): TokenizeResult`。
- Produces: `TokenizerEstimatorContext` with request/revision IDs and typed emitter。
- Produces: the typed `TokenizerStageEvent` contract consumed by the estimator。
- Produces: `durable-objects/tokenizer-controller/test/fixtures/tokenization-golden.json` with pre-migration expected token counts。
- Invariant: only `Error` from encoding initialization/encode becomes conservative fallback.

- [ ] **Step 1: Generate golden fixture from pre-migration `estimateInputTokens()`**

Before removing any shared BPE code, capture expected token counts from the current
`master` implementation. Create
`durable-objects/tokenizer-controller/test/fixtures/tokenization-golden.json` with
the exact expected `estimatedInputTokens` for each case:

```json
{
  "cases": [
    { "name": "empty", "inputText": "", "messageCount": 0, "opaqueInputBytes": 0, "expected": 3 },
    { "name": "ascii_hello", "inputText": "Hello, world!", "messageCount": 1, "opaqueInputBytes": 0, "expected": 11 },
    { "name": "japanese", "inputText": "こんにちは、世界！", "messageCount": 1, "opaqueInputBytes": 0, "expected": 11 },
    { "name": "emoji", "inputText": "Hello 👋🌍", "messageCount": 1, "opaqueInputBytes": 0, "expected": 12 },
    { "name": "source_code", "inputText": "const answer: number = 42;\nconsole.log(answer);", "messageCount": 2, "opaqueInputBytes": 0, "expected": 23 },
    { "name": "json", "inputText": "{\"model\":\"gpt-5.6-luna\",\"input\":\"hello\"}", "messageCount": 1, "opaqueInputBytes": 7, "expected": 30 },
    { "name": "mixed_unicode", "inputText": "OCTG は exact BPE を Durable Object で実行します 🚀", "messageCount": 3, "opaqueInputBytes": 11, "expected": 43 },
    { "name": "long_english_100x", "inputText": "The quick brown fox jumps over the lazy dog.\n", "messageCount": 100, "opaqueInputBytes": 0, "repeat": 100, "expected": 1007 },
    { "name": "long_japanese_1000x", "inputText": "こんにちは世界。\n", "messageCount": 1000, "opaqueInputBytes": 0, "repeat": 1000, "expected": "TODO_VERIFY >= 4003 (min = 4*messageCount + 3)" },
    { "name": "long_mixed_500x", "inputText": "OCTG は exact BPE を Durable Object で実行します 🚀\n", "messageCount": 500, "opaqueInputBytes": 0, "repeat": 500, "expected": 9007 },
    { "name": "long_english_7400x", "inputText": "The quick brown fox jumps over the lazy dog.\n", "messageCount": 1, "opaqueInputBytes": 0, "repeat": 7400, "expected": "TODO_VERIFY from master estimateInputTokens(repeat=7400)" }
  ]
}
```

These values must be verified against the current `estimateInputTokens()` on `master`
before any BPE code is removed. If any value differs, update the fixture to match the
pre-migration implementation — the fixture is the parity source of truth.

- [ ] **Step 2: Write RED estimator tests using the golden fixture**

Load the golden fixture and test every case for exact BPE parity. Also inject a
counting encoding factory and verify: one factory call across two successful
requests; initialization failure falls back and calls the factory again on the next
request; encode failure falls back without discarding the initialized encoding;
opaque bytes are added once; `Number.MAX_SAFE_INTEGER` arithmetic throws; a thrown
string is propagated rather than converted to fallback.

```ts
import goldenFixture from "./fixtures/tokenization-golden.json";

it.each(goldenFixture.cases)("golden parity: %s", (c) => {
  const inputText = c.repeat ? c.inputText.repeat(c.repeat) : c.inputText;
  const result = estimator.estimate({
    requestId: "req_golden",
    inputText,
    messageCount: c.messageCount,
    opaqueInputBytes: c.opaqueInputBytes,
  }, context);
  expect(result.estimatedInputTokens).toBe(c.expected);
  expect(result.estimationPath).toBe("exact_bpe");
});
```

- [ ] **Step 3: Run estimator tests and verify RED**

```bash
npm exec vitest run --config apps/gateway-worker/vitest.config.ts \
  durable-objects/tokenizer-controller/test/estimator.test.ts
```

Expected: FAIL because `TokenizerEstimator` does not exist.

- [ ] **Step 4: Implement lazy encoding and safe estimation**

Create `observation.ts` with the event contract before importing it from the
estimator. Stage names are `tokenizer_init` and `tokenizer_encode`:

```ts
export type TokenizerStage = "tokenizer_init" | "tokenizer_encode";
export type TokenizerStageOutcome = "success" | "fallback" | "exception";
export type TokenizerFailureCategory = "encoding_init" | "encoding_encode" | "arithmetic";

export type TokenizerStageEvent =
  | {
      readonly event: "octg.tokenizer_stage";
      readonly requestId: string;
      readonly revisionId: string;
      readonly stage: TokenizerStage;
      readonly phase: "start";
    }
  | {
      readonly event: "octg.tokenizer_stage";
      readonly requestId: string;
      readonly revisionId: string;
      readonly stage: TokenizerStage;
      readonly phase: "finish";
      readonly durationMs: number;
      readonly outcome: TokenizerStageOutcome;
      readonly byteCount?: number;
      readonly tokenCount?: number;
      readonly estimationPath?: "exact_bpe" | "conservative_bytes";
      readonly failureCategory?: TokenizerFailureCategory;
    };
```

Use an injectable factory for deterministic tests, with the production default fixed
to `o200k_base`:

```ts
import { getEncoding, type Tiktoken } from "js-tiktoken";
import type { TokenizeRequest, TokenizeResult } from "./contracts";
import type { TokenizerStageEvent } from "./observation";

type Encoding = Pick<Tiktoken, "encode">;
type EncodingFactory = () => Encoding;

export interface TokenizerEstimatorContext {
  readonly requestId: string;
  readonly revisionId: string;
  readonly emit: (event: TokenizerStageEvent) => void;
}

export class TokenizerEstimator {
  private encoding: Encoding | undefined;

  constructor(
    private readonly encodingFactory: EncodingFactory = () => getEncoding("o200k_base"),
  ) {}

  estimate(request: TokenizeRequest, context: TokenizerEstimatorContext): TokenizeResult {
    return this.encoding === undefined
      ? this.initializeAndEstimate(request, context)
      : this.encodeWithFallback(this.encoding, request, context);
  }

  private initializeAndEstimate(
    request: TokenizeRequest,
    context: TokenizerEstimatorContext,
  ): TokenizeResult {
    const startedAt = performance.now();
    context.emit({
      event: "octg.tokenizer_stage",
      requestId: request.requestId,
      revisionId: context.revisionId,
      stage: "tokenizer_init",
      phase: "start",
    });
    let initialized: Encoding;
    try {
      initialized = this.encodingFactory();
    } catch (error) {
      if (error instanceof Error) {
        try {
          const fallback = this.conservativeEstimate(request);
          context.emit({
            event: "octg.tokenizer_stage",
            requestId: request.requestId,
            revisionId: context.revisionId,
            stage: "tokenizer_init",
            phase: "finish",
            durationMs: Math.max(0, performance.now() - startedAt),
            outcome: "fallback",
            byteCount: fallback.byteCount,
            tokenCount: fallback.result.estimatedInputTokens,
            estimationPath: fallback.result.estimationPath,
            failureCategory: "encoding_init",
          });
          return fallback.result;
        } catch (arithmeticError) {
          context.emit({
            event: "octg.tokenizer_stage",
            requestId: request.requestId,
            revisionId: context.revisionId,
            stage: "tokenizer_init",
            phase: "finish",
            durationMs: Math.max(0, performance.now() - startedAt),
            outcome: "exception",
            failureCategory: "arithmetic",
          });
          throw arithmeticError;
        }
      }
      context.emit({
        event: "octg.tokenizer_stage",
        requestId: request.requestId,
        revisionId: context.revisionId,
        stage: "tokenizer_init",
        phase: "finish",
        durationMs: Math.max(0, performance.now() - startedAt),
        outcome: "exception",
        failureCategory: "encoding_init",
      });
      throw error;
    }
    this.encoding = initialized;
    context.emit({
      event: "octg.tokenizer_stage",
      requestId: request.requestId,
      revisionId: context.revisionId,
      stage: "tokenizer_init",
      phase: "finish",
      durationMs: Math.max(0, performance.now() - startedAt),
      outcome: "success",
    });
    return this.encodeWithFallback(initialized, request, context);
  }

  private encodeWithFallback(
    encoding: Encoding,
    request: TokenizeRequest,
    context: TokenizerEstimatorContext,
  ): TokenizeResult {
    const startedAt = performance.now();
    context.emit({
      event: "octg.tokenizer_stage",
      requestId: request.requestId,
      revisionId: context.revisionId,
      stage: "tokenizer_encode",
      phase: "start",
    });
    let base: number;
    try {
      base = encoding.encode(request.inputText).length;
    } catch (error) {
      if (error instanceof Error) {
        try {
          const fallback = this.conservativeEstimate(request);
          context.emit({
            event: "octg.tokenizer_stage",
            requestId: request.requestId,
            revisionId: context.revisionId,
            stage: "tokenizer_encode",
            phase: "finish",
            durationMs: Math.max(0, performance.now() - startedAt),
            outcome: "fallback",
            byteCount: fallback.byteCount,
            tokenCount: fallback.result.estimatedInputTokens,
            estimationPath: fallback.result.estimationPath,
            failureCategory: "encoding_encode",
          });
          return fallback.result;
        } catch (arithmeticError) {
          context.emit({
            event: "octg.tokenizer_stage",
            requestId: request.requestId,
            revisionId: context.revisionId,
            stage: "tokenizer_encode",
            phase: "finish",
            durationMs: Math.max(0, performance.now() - startedAt),
            outcome: "exception",
            failureCategory: "arithmetic",
          });
          throw arithmeticError;
        }
      }
      context.emit({
        event: "octg.tokenizer_stage",
        requestId: request.requestId,
        revisionId: context.revisionId,
        stage: "tokenizer_encode",
        phase: "finish",
        durationMs: Math.max(0, performance.now() - startedAt),
        outcome: "exception",
        failureCategory: "encoding_encode",
      });
      throw error;
    }
    try {
      const result = {
        estimatedInputTokens: estimatedTokensOf(base, request),
        estimationPath: "exact_bpe",
      } as const;
      context.emit({
        event: "octg.tokenizer_stage",
        requestId: request.requestId,
        revisionId: context.revisionId,
        stage: "tokenizer_encode",
        phase: "finish",
        durationMs: Math.max(0, performance.now() - startedAt),
        outcome: "success",
        tokenCount: result.estimatedInputTokens,
        estimationPath: result.estimationPath,
      });
      return result;
    } catch (error) {
      context.emit({
        event: "octg.tokenizer_stage",
        requestId: request.requestId,
        revisionId: context.revisionId,
        stage: "tokenizer_encode",
        phase: "finish",
        durationMs: Math.max(0, performance.now() - startedAt),
        outcome: "exception",
        failureCategory: "arithmetic",
      });
      throw error;
    }
  }

  private conservativeEstimate(request: TokenizeRequest): {
    readonly result: TokenizeResult;
    readonly byteCount: number;
  } {
    const byteCount = new TextEncoder().encode(request.inputText).byteLength;
    return {
      byteCount,
      result: {
        estimatedInputTokens: estimatedTokensOf(byteCount, request),
        estimationPath: "conservative_bytes",
      },
    };
  }
}
```

Use this exact arithmetic boundary for both paths:

```ts
function estimatedTokensOf(base: number, request: TokenizeRequest): number {
  const messageOverhead = request.messageCount * 4;
  const estimated = base + request.opaqueInputBytes + messageOverhead + 3;
  if (
    !Number.isSafeInteger(base) || base < 0 ||
    !Number.isSafeInteger(messageOverhead) || messageOverhead < 0 ||
    !Number.isSafeInteger(estimated) || estimated < 0
  ) {
    throw new RangeError("Tokenizer arithmetic overflow.");
  }
  return estimated;
}
```

Calculate the safe result before emitting `success` or `fallback`; if arithmetic
fails, emit `exception` and throw. Never retain an initialization failure.

- [ ] **Step 5: Run estimator tests and typecheck**

```bash
npm exec vitest run --config apps/gateway-worker/vitest.config.ts \
  durable-objects/tokenizer-controller/test/estimator.test.ts
npm run typecheck -w durable-objects/tokenizer-controller
```

Expected: all golden fixture cases and fallback cases pass; typecheck exits 0.

- [ ] **Step 6: Commit Task 2**

```bash
git add durable-objects/tokenizer-controller/src/estimator.ts \
  durable-objects/tokenizer-controller/src/observation.ts \
  durable-objects/tokenizer-controller/src/index.ts \
  durable-objects/tokenizer-controller/test/estimator.test.ts \
  durable-objects/tokenizer-controller/test/fixtures/tokenization-golden.json
git commit -m "feat: golden fixtureとexact BPE・保守的fallbackを実装"
```

### Task 3: Safe Tokenizer stage logging と Durable Object class を追加する

**Files:**

- Modify: `durable-objects/tokenizer-controller/src/observation.ts`
- Create: `durable-objects/tokenizer-controller/src/tokenizer-controller.ts`
- Create: `durable-objects/tokenizer-controller/test/observation.test.ts`
- Modify: `durable-objects/tokenizer-controller/src/estimator.ts`
- Modify: `durable-objects/tokenizer-controller/src/index.ts`

**Interfaces:**

- Produces: `TokenizerStageEvent` with stages `tokenizer_init | tokenizer_encode` and outcomes `success | fallback | exception`。
- Produces: `emitTokenizerStage(event): void` which cannot throw into estimation。
- Produces: `TokenizerController.tokenize(request: TokenizeRequest): Promise<TokenizeResult>` with runtime parsing。

- [ ] **Step 1: Write RED observation tests**

Build an event with extra secret-bearing properties via `Object.assign`, then assert
that `console.log` receives only request ID, revision ID, stage, phase, duration,
outcome, byte/token counts, estimation path, and bounded failure category. Use the
secret strings `secret prompt`, `Bearer secret`, and `raw encoder failure` and assert
that none appears in serialized log arguments. Also make `console.log` throw and
assert `emitTokenizerStage()` does not throw. Assert that stage values are only
`tokenizer_init` or `tokenizer_encode`.

- [ ] **Step 2: Run observation tests and verify RED**

```bash
npm exec vitest run --config apps/gateway-worker/vitest.config.ts \
  durable-objects/tokenizer-controller/test/observation.test.ts
```

Expected: FAIL because the event boundary does not exist.

- [ ] **Step 3: Implement allowlisted best-effort logging**

```ts
export type TokenizerStage = "tokenizer_init" | "tokenizer_encode";
export type TokenizerStageOutcome = "success" | "fallback" | "exception";
export type TokenizerFailureCategory = "encoding_init" | "encoding_encode" | "arithmetic";

type TokenizerStageEventBase = {
  readonly event: "octg.tokenizer_stage";
  readonly requestId: string;
  readonly revisionId: string;
  readonly stage: TokenizerStage;
  readonly byteCount?: number;
  readonly tokenCount?: number;
  readonly estimationPath?: "exact_bpe" | "conservative_bytes";
  readonly failureCategory?: TokenizerFailureCategory;
};

export type TokenizerStageEvent =
  | (TokenizerStageEventBase & {
      readonly phase: "start";
      readonly durationMs?: never;
      readonly outcome?: never;
    })
  | (TokenizerStageEventBase & {
      readonly phase: "finish";
      readonly durationMs: number;
      readonly outcome: TokenizerStageOutcome;
    });
```

Construct a fresh runtime object from these properties and call `console.log()` inside
a local `try/catch` that swallows logging failure only. Do not pass the original event
object through unchanged.

- [ ] **Step 4: Add the public Durable Object boundary**

```ts
import { DurableObject } from "cloudflare:workers";

export interface TokenizerControllerEnv {
  readonly CF_VERSION_METADATA?: WorkerVersionMetadata;
}

export class TokenizerController extends DurableObject<TokenizerControllerEnv> {
  private readonly estimator = new TokenizerEstimator();

  async tokenize(request: TokenizeRequest): Promise<TokenizeResult>;
  async tokenize(request: unknown): Promise<TokenizeResult> {
    const parsed = parseTokenizeRequest(request);
    const revisionId = this.env.CF_VERSION_METADATA?.id;
    return this.estimator.estimate(parsed, {
      requestId: parsed.requestId,
      revisionId: typeof revisionId === "string" && revisionId.length > 0 ? revisionId : "local",
      emit: emitTokenizerStage,
    });
  }
}
```

Re-export the class, contracts, estimator, and event types from `src/index.ts`.

- [ ] **Step 5: Run all PR 1 checks**

```bash
npm exec vitest run --config apps/gateway-worker/vitest.config.ts \
  durable-objects/tokenizer-controller/test/contracts.test.ts \
  durable-objects/tokenizer-controller/test/estimator.test.ts \
  durable-objects/tokenizer-controller/test/observation.test.ts
npm run typecheck -w durable-objects/tokenizer-controller
```

Expected: all commands exit 0; logging tests contain no secret-bearing output; stage
values are only `tokenizer_init` or `tokenizer_encode`.

- [ ] **Step 6: Commit Task 3 and create the next stack layer**

```bash
git add durable-objects/tokenizer-controller/src/observation.ts \
  durable-objects/tokenizer-controller/src/tokenizer-controller.ts \
  durable-objects/tokenizer-controller/src/estimator.ts \
  durable-objects/tokenizer-controller/src/index.ts \
  durable-objects/tokenizer-controller/test/observation.test.ts
git commit -m "feat: Tokenizer DOの安全な観測境界を追加"
gh stack add tokenizer-do/wiring
```

---

## PR 2: `tokenizer-do/wiring`

### Task 4: Worker export、binding、immutable v2 migration を追加する

**Files:**

- Modify: `apps/gateway-worker/package.json:12-17`
- Modify: `apps/gateway-worker/src/index.ts:1-32`
- Modify: `apps/gateway-worker/wrangler.jsonc:23-26`
- Modify: `package-lock.json`
- Create: `durable-objects/tokenizer-controller/test/tokenizer-controller.test.ts`

**Interfaces:**

- Produces: `Env.TOKENIZER_CONTROLLER: DurableObjectNamespace<TokenizerController>`。
- Produces: Worker named export `TokenizerController`。
- Produces: binding name `TOKENIZER_CONTROLLER` and migration tag `v2`。

- [ ] **Step 1: Write RED real-Durable-Object tests**

Use `cloudflare:test` and the fixed object name:

```ts
const controller = () => env.TOKENIZER_CONTROLLER.get(
  env.TOKENIZER_CONTROLLER.idFromName("tokenizer:primary"),
);
```

Test a valid exact request, each invalid request contract over RPC, and two requests
to the same object. After tokenization, use `runInDurableObject` to assert
`state.storage.list()` has size zero. To catch transient writes that are later deleted,
instrument `state.storage.put`, `state.storage.delete`, and `state.storage.deleteAll`
with a fail-fast guard or operation-counting spy inside `runInDurableObject`, and assert
the spy was never called rather than relying solely on the final `list()` size. The
class env must not expose `DB` or
`QUOTA_CONTROLLER`, making D1/quota access unavailable by construction.

Invoke malformed RPC inputs without a type escape hatch:

```ts
const stub = env.TOKENIZER_CONTROLLER.get(
  env.TOKENIZER_CONTROLLER.idFromName("tokenizer:primary"),
);
const invokeMalformed = (value: unknown): Promise<TokenizeResult> =>
  Reflect.apply(stub.tokenize, stub, [value]);
```

- [ ] **Step 2: Run the real DO test and verify RED**

```bash
npm exec vitest run --config apps/gateway-worker/vitest.config.ts \
  durable-objects/tokenizer-controller/test/tokenizer-controller.test.ts
```

Expected: FAIL because the Worker has no Tokenizer export or binding.

- [ ] **Step 3: Add dependency, export, Env binding, and migration**

Add `"@octg/tokenizer-controller": "*"` to gateway dependencies. Update the Worker
entrypoint:

```ts
import { TokenizerController } from "@octg/tokenizer-controller";

export { QuotaController, TokenizerController };

export interface Env {
  readonly QUOTA_CONTROLLER: DurableObjectNamespace<QuotaController>;
  readonly TOKENIZER_CONTROLLER: DurableObjectNamespace<TokenizerController>;
  // existing fields remain unchanged
}
```

Update Wrangler without modifying the existing `v1` object:

```jsonc
"durable_objects": {
  "bindings": [
    { "name": "QUOTA_CONTROLLER", "class_name": "QuotaController" },
    { "name": "TOKENIZER_CONTROLLER", "class_name": "TokenizerController" }
  ]
},
"migrations": [
  { "tag": "v1", "new_sqlite_classes": ["QuotaController"] },
  { "tag": "v2", "new_sqlite_classes": ["TokenizerController"] }
],
```

Run `npm install` to regenerate, not hand-edit, lockfile workspace links.

- [ ] **Step 4: Run real DO test and affected typechecks**

```bash
npm install
npm exec vitest run --config apps/gateway-worker/vitest.config.ts \
  durable-objects/tokenizer-controller/test/tokenizer-controller.test.ts
npm run typecheck -w durable-objects/tokenizer-controller
npm run typecheck -w apps/gateway-worker
```

Expected: real RPC succeeds, invalid requests reject, Storage stays empty, typechecks exit 0.

- [ ] **Step 5: Commit Task 4**

```bash
git add apps/gateway-worker/package.json apps/gateway-worker/src/index.ts \
  apps/gateway-worker/wrangler.jsonc package-lock.json \
  durable-objects/tokenizer-controller/test/tokenizer-controller.test.ts
git commit -m "feat: Tokenizer DOをWorkerへ登録"
```

### Task 5: Gateway tokenizer client、RPC preflight、response validation を追加する

**Files:**

- Create: `apps/gateway-worker/src/tokenizer.ts`
- Create: `apps/gateway-worker/test/tokenizer-client.test.ts`

**Interfaces:**

- Consumes: a structural namespace with `idFromName()` and `get()`。
- Produces: `TokenizerOutcome = resolved | unavailable`。
- Produces: `tokenizeInput(namespace, request): Promise<TokenizerOutcome>`。
- Produces: `estimateRpcPayloadSize(request: TokenizeRequest): number` for V8 serialization preflight。
- Invariant: fixed ID、one stub lookup、one RPC attempt、no retry、no timeout。
- Invariant: RPC preflight fails closed if estimated V8 payload `>= 32 MiB`.

- [ ] **Step 1: Write RED client tests**

Use a generic fake namespace whose ID type is `string`. Assert the exact name
`tokenizer:primary`, one `get`, and one `tokenize`. Add table-driven malformed results:
missing fields, unknown path, NaN, Infinity, negative, fractional, and
`Number.MAX_SAFE_INTEGER + 1`. Add a rejected RPC and assert `unavailable` with one
attempt. Add RPC preflight cases: ASCII input under 16 MiB passes, non-Latin-1 input
whose worst-case V8 size reaches 32 MiB returns `unavailable` without calling `get` or
`tokenize`.

- [ ] **Step 2: Run client tests and verify RED**

```bash
npm test -w apps/gateway-worker -- test/tokenizer-client.test.ts
```

Expected: FAIL because the client does not exist.

- [ ] **Step 3: Implement generic namespace adapter, RPC preflight, and independent parser**

```ts
import type { TokenizeRequest, TokenizeResult } from "@octg/tokenizer-controller";

const RPC_LIMIT_BYTES = 32 * 1024 * 1024;

export type TokenizerOutcome =
  | { readonly kind: "resolved"; readonly result: TokenizeResult }
  | { readonly kind: "unavailable" };

interface TokenizerRpcStub {
  tokenize(request: TokenizeRequest): Promise<unknown>;
}

export interface TokenizerNamespace<Id> {
  idFromName(name: string): Id;
  get(id: Id): TokenizerRpcStub;
}

export function estimateRpcPayloadSize(request: TokenizeRequest): number {
  const inputTextUtf16Size = request.inputText.length * 2;
  const requestIdSize = request.requestId.length * 2;
  const framingOverhead = 200;
  return inputTextUtf16Size + requestIdSize + framingOverhead;
}

function parseTokenizeResult(value: unknown): TokenizeResult | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const estimatedInputTokens = Reflect.get(value, "estimatedInputTokens");
  const estimationPath = Reflect.get(value, "estimationPath");
  if (
    typeof estimatedInputTokens !== "number" ||
    !Number.isSafeInteger(estimatedInputTokens) ||
    estimatedInputTokens < 0
  ) return undefined;
  if (estimationPath !== "exact_bpe" && estimationPath !== "conservative_bytes") return undefined;
  return { estimatedInputTokens, estimationPath };
}
```

`tokenizeInput()` must first call `estimateRpcPayloadSize(request)` and return
`{ kind: "unavailable" }` without resolving the stub if the estimate is
`>= RPC_LIMIT_BYTES`. Otherwise, wrap `idFromName("tokenizer:primary")`, `get()`,
`stub.tokenize(request)`, and `parseTokenizeResult()` in a single try/catch so that
both synchronous exceptions from `idFromName`/`get`/`Reflect.get` and rejected
promises from `stub.tokenize()` are converted to `{ kind: "unavailable" }`. Parse
the successful result and convert every rejection, exception, or invalid result to
`{ kind: "unavailable" }`. It must not call itself
recursively, schedule a timer, or perform local estimation.

- [ ] **Step 4: Run client tests and gateway typecheck**

```bash
npm test -w apps/gateway-worker -- test/tokenizer-client.test.ts
npm run typecheck -w apps/gateway-worker
```

Expected: all client cases pass; typecheck exits 0.

- [ ] **Step 5: Commit Task 5 and create the cutover layer**

```bash
git add apps/gateway-worker/src/tokenizer.ts \
  apps/gateway-worker/test/tokenizer-client.test.ts
git commit -m "feat: Gateway Tokenizer clientとRPC preflightを追加"
gh stack add tokenizer-do/cutover
```

---

## PR 3: `tokenizer-do/cutover`

### Task 6: Safe quota arithmetic と 500 internal_error contract を追加する

**Files:**

- Create: `apps/gateway-worker/src/token-budget.ts`
- Create: `apps/gateway-worker/test/token-budget.test.ts`
- Modify: `packages/shared/src/errors.ts:155-157`
- Modify: `packages/shared/test/errors.test.ts`
- Modify: `apps/gateway-worker/src/resource-observation.ts:10-21`
- Modify: `apps/gateway-worker/test/resource-observation.test.ts`

**Interfaces:**

- Produces: `resolveTokenBudget(args): TokenBudgetOutcome`。
- Produces outcomes: `resolved | request_too_large | quota_exceeded | unavailable`。
- Produces: extended `errInternal(requestId, options?)` with optional `quota` and `route`。
- Produces: internal resource-stage route `error:tokenizer_unavailable`。
- Produces: external HTTP response route `error:internal_error` via `errInternal()`。

- [ ] **Step 1: Write RED budget and error-contract tests**

Test valid REJECT and CLAMP decisions, upper-bound 413, quota 429, invalid/overflow
estimated input, limit, remaining ratio, margin, upper bound, output, and reservation.
For 500, assert exact status, body, `X-OCTG-*` quota headers, `X-OCTG-Route: error:internal_error`,
and absence of `Retry-After`.

```ts
expect(await errorResponse(errInternal("req_tokenizer", {
  quota: snapshot,
  route: "error:internal_error",
})).json()).toEqual({
  error: {
    message: "An internal error occurred.",
    type: "api_error",
    param: null,
    code: "internal_error",
    pool: "standard",
    remaining_tokens: snapshot.remaining,
    reset_at: snapshot.resetAt,
  },
  request_id: "req_tokenizer",
});
```

- [ ] **Step 2: Run focused tests and verify RED**

```bash
npm test -w apps/gateway-worker -- test/token-budget.test.ts test/resource-observation.test.ts
npm test -w packages/shared -- test/errors.test.ts
```

Expected: FAIL because budget outcome, route, and extended `errInternal()` do not exist.

- [ ] **Step 3: Extend `errInternal()` with optional quota and route**

```ts
export function errInternal(
  requestId: string,
  options: { quota?: QuotaSnapshot; route?: "error:internal_error" } = {},
): OctgHttpError {
  return makeError(
    500,
    requestId,
    "An internal error occurred.",
    "api_error",
    null,
    "internal_error",
    options,
  );
}
```

Add only `"error:tokenizer_unavailable"` to `ResourceStageRoute`; do not add a new
stage or `Retry-After` behavior. This is the internal resource-stage route, distinct
from the external HTTP response route `error:internal_error`.

- [ ] **Step 4: Implement typed budget calculation**

```ts
export interface TokenBudgetArguments {
  readonly estimatedInput: number;
  readonly maxOutputTokens: number;
  readonly remaining: number;
  readonly limit: number;
  readonly outputLimitMode: "REJECT" | "CLAMP";
}

export type TokenBudgetOutcome =
  | { readonly kind: "resolved"; readonly margin: number; readonly upperBound: number; readonly maxOutputTokens: number; readonly reservation: number }
  | { readonly kind: "request_too_large" }
  | { readonly kind: "quota_exceeded" }
  | { readonly kind: "tokenizer_unavailable" }
  | { readonly kind: "arithmetic_error" };
```

Validate all inputs before division. Call existing `safetyMargin`, `upperBoundOf`, and
`decideOutput`; validate every returned number as a non-negative safe integer. Return
`request_too_large` only for a valid upper bound above a valid pool limit,
`quota_exceeded` only for a valid reject decision, `tokenizer_unavailable` for
Tokenizer RPC failures, and `arithmetic_error` for every invalid arithmetic
result. Never clamp an invalid number. Proxy must record `tokenizer_unavailable`
and `arithmetic_error` distinctly so arithmetic bugs are not misclassified as
external dependency failures in `octg.resource_stage` logs.

- [ ] **Step 5: Run focused tests and typechecks**

```bash
npm test -w apps/gateway-worker -- test/token-budget.test.ts test/resource-observation.test.ts
npm test -w packages/shared -- test/errors.test.ts
npm run typecheck -w apps/gateway-worker
npm run typecheck -w packages/shared
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit Task 6**

```bash
git add apps/gateway-worker/src/token-budget.ts \
  apps/gateway-worker/test/token-budget.test.ts \
  apps/gateway-worker/src/resource-observation.ts \
  apps/gateway-worker/test/resource-observation.test.ts \
  packages/shared/src/errors.ts packages/shared/test/errors.test.ts
git commit -m "feat: Tokenizer障害の500 internal_error契約を追加"
```

### Task 7: Proxy を Tokenizer RPC へ cut over する

**Files:**

- Modify: `apps/gateway-worker/src/proxy.ts:1-31,101-103,353-400`
- Create: `apps/gateway-worker/test/tokenizer-integration.test.ts`
- Create: `apps/gateway-worker/test/tokenizer-74k-regression.test.ts`
- Modify: `apps/gateway-worker/test/proxy.test.ts`
- Modify: `apps/gateway-worker/test/proxy-failures.test.ts:1-7,278-304`

**Interfaces:**

- Consumes: `tokenizeInput(env.TOKENIZER_CONTROLLER, TokenizeRequest)`。
- Consumes: `estimateRpcPayloadSize()` preflight inside `tokenizeInput()`。
- Consumes: `resolveTokenBudget()` outcomes。
- Consumes: extended `errInternal(requestId, { quota, route: "error:internal_error" })`。
- Preserves: all existing reserve/in-flight/upstream/finalization code after the current reservation calculation.

- [ ] **Step 1: Write RED HTTP integration tests**

Temporarily replace `env.TOKENIZER_CONTROLLER` with a configurable fake via
`Object.defineProperty`. For each failure, drive `SELF.fetch()` and assert:

1. rejected RPC, overload-like rejection, and malformed result return 500;
2. missing field, unknown path, NaN, Infinity, negative, fractional, and unsafe token count return 500;
3. RPC preflight size limit (input whose V8 payload estimate reaches 32 MiB) returns 500 without calling `get` or `tokenize`;
4. Tokenizer RPC call count is exactly one (zero for preflight failure);
5. reserve state and request count do not change;
6. upstream fetch count is zero;
7. response has quota snapshot headers and `X-OCTG-Route: error:internal_error` and no `Retry-After`;
8. body is the existing `errInternal()` body: `message: "An internal error occurred."`, `type: "api_error"`, `code: "internal_error"`;
9. tokenize finish log contains internal route `error:tokenizer_unavailable`, `quotaReserved: false`, `upstreamReached: false`;
10. no `quota_reserve` or `upstream` start event is emitted;
11. prompt, body, Authorization, API key, exception text, and stack are absent from logs.

Add success lifecycle cases for settle, upstream uncertainty/markUncertain, known
pre-upstream release, and reserve rejection/upstream zero. Assert Tokenizer is called
before the first reserve call in an ordered call trace. At least one success case must
use the real `env.TOKENIZER_CONTROLLER` binding (not the fake) and exercise the exported
`TokenizerController` RPC through `SELF.fetch()`, including RPC serialization and the
Gateway-to-Durable-Object connection. Reserve the fake binding only for failure
injection. Extend the success lifecycle coverage to preserve the existing settle,
uncertainty, release, and reserve-rejection scenarios while asserting the real
Tokenizer call occurs before the first reserve call.

In `tokenizer-74k-regression.test.ts`, generate
`"The quick brown fox jumps over the lazy dog.\n".repeat(7_400)`. Assert the real
Tokenizer DO returns `{ estimatedInputTokens: 74_007, estimationPath: "exact_bpe" }`,
then drive the same 333,000-byte input through `SELF.fetch()` and assert the Gateway
invokes Tokenizer once before reserve. Before cutover, the direct DO assertion passes
but the Gateway call/order assertion fails because production still runs local BPE.

- [ ] **Step 2: Run integration tests and verify RED**

```bash
npm test -w apps/gateway-worker -- \
  test/tokenizer-integration.test.ts \
  test/tokenizer-74k-regression.test.ts
```

Expected: FAIL because `proxy.ts` still calls local `estimateInputTokens()`.

- [ ] **Step 3: Replace local estimation with one RPC and one budget decision**

Remove `estimateInputTokens` from the shared import. Update `resolveMaxInputBytes()` to
cap at `16 MiB - 65,536 bytes`:

```ts
const MAX_INPUT_BYTES_CEILING = 16 * 1024 * 1024 - 65_536;

export function resolveMaxInputBytes(configured: string | undefined): number {
  const resolved = resolvePositiveSafeInteger(configured, MAX_NORMALIZED_INPUT_BYTES);
  return Math.min(resolved, MAX_INPUT_BYTES_CEILING);
}
```

Build this exact request after `quota_get_state` succeeds:

```ts
const tokenizerOutcome = await tokenizeInput(env.TOKENIZER_CONTROLLER, {
  requestId,
  inputText: requestData.inputText,
  messageCount: requestData.messageCount,
  opaqueInputBytes: requestData.opaqueInputBytes,
});
```

If unavailable, finish the existing `tokenize` stage as `exception` with the internal
route `error:tokenizer_unavailable` and false booleans, complete audit best-effort as
failed, and return `errInternal(requestId, { quota: snapshot, route: "error:internal_error" })`
before reserve starts.

For a resolved result, call `resolveTokenBudget`. Treat `unavailable` identically.
Map `request_too_large` to the existing 413 and `quota_exceeded` to the existing 429.
For `resolved`, use only returned `reservation`, `upperBound`, and `maxOutputTokens`.
Finish the tokenize stage as success with `estimationPath` and the three existing byte
metrics. Use exhaustive `switch` statements with a `never` default assignment for
both discriminated unions.

- [ ] **Step 4: Preserve lifecycle and remove test-side shared BPE use**

In the opaque reasoning test, configure the fake Tokenizer result directly instead of
importing `estimateInputTokens`. Keep `safetyMargin` only where the test verifies quota
arithmetic. Do not alter reserve retry, in-flight lease, upstream, streaming,
settlement, uncertainty, release, or audit ownership code below the cutover.

- [ ] **Step 5: Run focused success/failure/lifecycle tests**

```bash
npm test -w apps/gateway-worker -- \
  test/tokenizer-integration.test.ts \
  test/tokenizer-74k-regression.test.ts \
  test/proxy.test.ts \
  test/proxy-failures.test.ts \
  test/quota-settle.test.ts \
  test/quota-lifecycle.test.ts \
  test/quota-reservation.test.ts
npm run typecheck -w apps/gateway-worker
```

Expected: all commands exit 0; every Tokenizer failure has reserve/upstream count zero
and HTTP 500 with `internal_error` body.

- [ ] **Step 6: Manually drive local HTTP success and bad-input surfaces**

Run `npm run setup:local`, launch `npm run dev -w apps/gateway-worker`, and send one
valid Chat request with the seeded local key:

```bash
curl --fail-with-body http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer octg_sk_local_demo" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5","messages":[{"role":"user","content":"hello"}],"max_completion_tokens":1}'
```

Confirm HTTP success and quota headers. Then send invalid JSON and confirm the existing
400 boundary remains intact without an upstream request:

```bash
curl --include http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer octg_sk_local_demo" \
  -H "Content-Type: application/json" \
  --data-binary '{'
```

The Tokenizer-specific 500 fault injection remains in the Worker-pool integration test
where the binding can be replaced safely without adding a production test hook.

- [ ] **Step 7: Commit Task 7 and create the verification layer**

```bash
git add apps/gateway-worker/src/proxy.ts \
  apps/gateway-worker/test/tokenizer-integration.test.ts \
  apps/gateway-worker/test/tokenizer-74k-regression.test.ts \
  apps/gateway-worker/test/proxy.test.ts \
  apps/gateway-worker/test/proxy-failures.test.ts
git commit -m "feat: quota予約前にTokenizer RPCを統合"
gh stack add tokenizer-do/verification
```

---

## PR 4: `tokenizer-do/verification`

### Task 8: Shared BPE dependency を除去し静的 isolation guard を追加する

**Files:**

- Modify: `packages/shared/src/estimate.ts:1-14`
- Modify: `packages/shared/test/estimate.test.ts:1-59`
- Modify: `packages/shared/package.json:10-15`
- Create: `packages/shared/test/tokenizer-dependency-isolation.test.ts`
- Modify: `package-lock.json`

**Interfaces:**

- Preserves: `safetyMargin`, `upperBoundOf`, `decideOutput`, `OutputDecision`。
- Removes: `estimateInputTokens` and all shared/gateway production BPE symbols。
- Preserves: golden fixture parity tests in `durable-objects/tokenizer-controller` (Task 2)。

- [ ] **Step 1: Write RED dependency-isolation tests**

From a Node Vitest test, recursively read only `packages/shared/src` and
`apps/gateway-worker/src`. Assert no source contains a `js-tiktoken` import,
`getEncoding(` call, or `encoding.encode(` call. Dynamically import shared index and
assert it has no own property `estimateInputTokens`. Exclude
`durable-objects/tokenizer-controller` from this scan because it is the sole approved
BPE owner.

- [ ] **Step 2: Run isolation test and verify RED**

```bash
npm test -w packages/shared -- test/tokenizer-dependency-isolation.test.ts
```

Expected: FAIL on the existing shared dependency and estimator export.

- [ ] **Step 3: Remove shared BPE code, tests, and dependency**

Delete the `js-tiktoken` import, module cache, and `estimateInputTokens` from
`estimate.ts`. Delete only the `describe("estimateInputTokens")` block from
`estimate.test.ts`; retain all safety margin, upper bound, and output decision tests.
The golden fixture parity tests already exist in
`durable-objects/tokenizer-controller/test/estimator.test.ts` (Task 2), so no BPE
test helper or `estimateInputTokens` copy remains in shared.
Remove `js-tiktoken` from `packages/shared/package.json`; do not remove it from the
Tokenizer workspace.

- [ ] **Step 4: Regenerate lockfile and run isolation/full affected tests**

```bash
npm install
npm test -w packages/shared
npm test -w apps/gateway-worker
npm run typecheck -w packages/shared
npm run typecheck -w apps/gateway-worker
npm run typecheck -w durable-objects/tokenizer-controller
```

Expected: all commands exit 0. Lockfile shows `js-tiktoken` as a direct dependency of
Tokenizer only, while the package resolution itself remains installed.

- [ ] **Step 5: Commit Task 8**

```bash
git add packages/shared/src/estimate.ts packages/shared/test/estimate.test.ts \
  packages/shared/test/tokenizer-dependency-isolation.test.ts \
  packages/shared/package.json package-lock.json
git commit -m "refactor: BPE依存をTokenizer DOへ隔離"
```

### Task 9: Runbook、production canary、stacked PR submission を完了する

**Files:**

- Modify: `README.md:9-29,238-267,287-293`
- Modify: `docs/DEPLOY_FROM_TEMPLATE.md`
- Modify: `docs/troubleshooting-503-worker-resource-limits.md:159-198`
- Verify: `docs/cloudflare-ai-gateway-custom-provider.md`
- Verify: `scripts/canary-worker-resource-limits.mjs`

**Interfaces:**

- Produces: deploy revision、request IDs、Free Plan、stage ordering、settlement、privacy、rollback evidence。
- Produces: canary halt conditions with 6 quantitative thresholds。
- Uses: existing canary JSONL contract and operator-provided expected peak。

- [ ] **Step 1: Update architecture and deployment runbook**

Show Tokenizer DO between normalization and QuotaController in `README.md`. Document
that Worker deploy applies the immutable Durable Object `v2` migration while the
existing D1 migration command remains separate. Add this verification order:

```text
deploy -> capture revision -> concurrency 1 -> concurrency 2 -> expected peak
-> inspect Gateway/Tokenizer stages -> confirm reserve/upstream/settle order
-> confirm payload logging disabled -> accept or rollback
```

- [ ] **Step 2: Add exact rollback procedure**

Document the current Wrangler commands:

```bash
npx wrangler deployments list --config apps/gateway-worker/wrangler.jsonc
npx wrangler rollback "$PREVIOUS_VERSION_ID" \
  --message "Rollback TokenizerController canary" \
  --config apps/gateway-worker/wrangler.jsonc
```

version, does not remove/rewrite `v2`, and must not activate Gateway local BPE.
Rollback to a pre-Tokenizer revision re-introduces local BPE code. To prevent its
activation, either (a) roll back to a Tokenizer DO-compatible revision that delegates
estimation to the Durable Object, or (b) explicitly define a traffic-routing mechanism
(e.g., route all requests through a maintenance path that rejects before BPE) that
prevents the Gateway from invoking local BPE. Do not rely solely on restricting large
requests, because small requests would still trigger local BPE. After rollback,
document the chosen target revision or routing condition alongside the Wrangler
commands, and restrict large requests operationally because the previous revision
retains the known Error 1102 risk.

- [ ] **Step 3: Expand the evidence table for AC-01 through AC-13**

For one documented revision, record: Worker plan, expected peak value and rationale,
request ID, `$workers.outcome`, CPU/wall time, Gateway tokenize start/finish,
Tokenizer `tokenizer_init`/`tokenizer_encode` events, estimation path, reserve/upstream
ordering, actual usage settlement, failure reserve/upstream counts, and AI Gateway A/B
payload logging state. A missing field keeps the incident open.

- [ ] **Step 4: Add canary halt conditions**

Document the 6 quantitative thresholds for the expected peak canary. Any threshold
exceeded halts the canary immediately, and the exceeded metric, threshold, and
concurrency level are recorded:

| Metric | Threshold (example) | Source |
| --- | --- | --- |
| max queue length | 128 requests, or DO input queue limit 50% | Cloudflare DO metrics (if available) |
| p95 tokenization latency | 250 ms | canary driver per-request timing |
| p99 tokenization latency | 500 ms | canary driver per-request timing |
| 503 overload rate | 0.1% of all requests | canary driver error count |
| Tokenizer CPU utilization | 80% (monitorable only) | Cloudflare Workers analytics |
| total completion time | 60 s | canary driver wall clock |

If a metric cannot be measured by the canary driver (e.g., CPU utilization, queue
length), document the Cloudflare dashboard query procedure and pass/fail judgment in
the runbook. Record the measured value, threshold, and pass/fail result for each metric
in the evidence table.

- [ ] **Step 5: Run full local verification**

```bash
npm test
npm run typecheck
npx markdownlint-cli2 \
  docs/superpowers/plans/2026-08-17-tokenizer-durable-object.md \
  README.md docs/DEPLOY_FROM_TEMPLATE.md \
  docs/troubleshooting-503-worker-resource-limits.md
```

Run `lsp_diagnostics` on every changed TypeScript file. Expected: zero introduced
diagnostics and all commands exit 0.

- [ ] **Step 6: Deploy and run the required production canary**

After human-approved deployment, capture the emitted revision ID and run:

```bash
CANARY_PAYLOAD_PATH="$(mktemp)"
export CANARY_PAYLOAD_PATH
node --input-type=module -e '
  import { writeFile } from "node:fs/promises";
  const input = "The quick brown fox jumps over the lazy dog.\n".repeat(7_400);
  const payload = { model: "gpt-5", messages: [{ role: "user", content: input }], max_completion_tokens: 1 };
  await writeFile(process.env.CANARY_PAYLOAD_PATH, JSON.stringify(payload), { mode: 0o600 });
'

OCTG_CANARY_URL="$OCTG_CANARY_URL" \
OCTG_CANARY_ALLOWED_HOSTS="$OCTG_CANARY_ALLOWED_HOSTS" \
OCTG_CANARY_CLIENT_KEY="$OCTG_CANARY_CLIENT_KEY" \
CANARY_PAYLOAD_PATH="$CANARY_PAYLOAD_PATH" \
CANARY_CONCURRENCY="1,2,$EXPECTED_PEAK_CONCURRENCY" \
CANARY_REQUEST_TIMEOUT_MS="$CANARY_REQUEST_TIMEOUT_MS" \
node scripts/canary-worker-resource-limits.mjs
```

Verify no `exceededCpu`, Free Plan remains active, every successful request follows
Tokenizer success -> reserve success -> upstream -> settle. Use Task 7's isolated
binding fault-injection evidence for the failure contract; do not add a production
fault-injection endpoint or environment flag. Confirm no prompt, payload, or API key
appears in Worker, Tokenizer, or AI Gateway logs. Check all 6 canary halt thresholds
against the evidence table; halt immediately if any threshold is exceeded.

- [ ] **Step 7: Commit documentation and evidence**

```bash
git add README.md docs/DEPLOY_FROM_TEMPLATE.md \
  docs/troubleshooting-503-worker-resource-limits.md
git commit -m "docs: Tokenizer DOのcanaryとrollbackを追加"
```

- [ ] **Step 8: Submit four stacked PRs, not one PR**

```bash
gh stack submit --auto --remote origin
gh stack view --json
```

Confirm JSON shows exactly these four open branches in order:

```text
tokenizer-do/controller
tokenizer-do/wiring
tokenizer-do/cutover
tokenizer-do/verification
```

Use `gh pr edit` after submission to set the four PR titles to:

```text
feat: TokenizerController の計算基盤を追加
feat: Tokenizer Durable Object を Gateway に配線
feat: Tokenizer RPC を quota 前処理へ統合
test: Tokenizer 分離の回帰・canary 証跡を追加
```

Do not merge any PR. Human reviewers merge bottom-to-top after every layer's checks
and evidence pass.

---

## Final Acceptance Matrix

| Acceptance criterion | Automated evidence | Production evidence |
| --- | --- | --- |
| AC-01 / AC-02 | `tokenizer-74k-regression.test.ts` + dependency guard | 74k canary、no `exceededCpu` |
| AC-03 / AC-04 | observation and integration tests | matching Gateway and Tokenizer events by request ID |
| AC-05 / AC-06 | ordered integration call trace | stage timestamps show tokenizer -> reserve -> upstream |
| AC-07 | proxy/quota settle tests | actual usage settlement record |
| AC-08 | injected RPC/malformed/overflow tests with reserve=0/upstream=0 and HTTP 500 `internal_error` | correlate any canary unavailable event without adding a production fault hook |
| AC-09 | existing settle/uncertain/release suites | upstream uncertain remains reconcilable |
| AC-10 | allowlist/redaction/Storage tests | Worker/DO/AI Gateway log inspection |
| AC-11 / AC-13 | canary driver validation with 6 halt thresholds | concurrency 1/2/expected peak on Free Plan, all thresholds within limits |
| AC-12 | root scripts | `npm test` and `npm run typecheck` exit 0 |

Implementation is complete only after all four stacked PR layers are green and the
production evidence row is fully populated for one deployment revision.
