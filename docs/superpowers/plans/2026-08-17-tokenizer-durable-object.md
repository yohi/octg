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
- Tokenizer failure または malformed result では HTTP 503、code `tokenizer_unavailable`、route `error:tokenizer_unavailable` を返し、`Retry-After` を付与しない。
- Tokenizer failure 時は `quotaReserved = false`、`upstreamReached = false` とし、reserve、release、markUncertain、upstream を呼ばない。
- fixed logical object ID は `tokenizer:primary` とし、sharding、result cache、prompt hash cache を実装しない。
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
- Create `durable-objects/tokenizer-controller/test/contracts.test.ts`: request runtime validation。
- Create `durable-objects/tokenizer-controller/test/estimator.test.ts`: parity、fallback、retry、reuse、overflow。
- Create `durable-objects/tokenizer-controller/test/observation.test.ts`: safe logging contract。
- Create `durable-objects/tokenizer-controller/test/tokenizer-controller.test.ts`: real DO RPC と Storage 非使用。

### Gateway integration

- Create `apps/gateway-worker/src/tokenizer.ts`: fixed ID resolution、single RPC、response validation、outcome union。
- Create `apps/gateway-worker/src/token-budget.ts`: Gateway-side safe quota arithmetic と typed outcomes。
- Create `apps/gateway-worker/test/tokenizer-client.test.ts`: client call count、fixed ID、malformed result。
- Create `apps/gateway-worker/test/token-budget.test.ts`: overflow、413、429、resolved budget。
- Create `apps/gateway-worker/test/tokenizer-integration.test.ts`: HTTP 503 fail-closed と quota lifecycle regression。
- Create `apps/gateway-worker/test/tokenizer-74k-regression.test.ts`: generated 74k exact BPE と Gateway path。
- Modify `apps/gateway-worker/src/index.ts`: Tokenizer class export と Env binding。
- Modify `apps/gateway-worker/src/proxy.ts`: local estimator block を tokenizer outcome と token budget orchestration に置換。
- Modify `apps/gateway-worker/src/resource-observation.ts`: `error:tokenizer_unavailable` route。
- Modify `apps/gateway-worker/wrangler.jsonc`: binding と immutable `v2` migration。
- Modify `apps/gateway-worker/vitest.config.ts`: Tokenizer workspace tests を Worker pool へ追加。
- Modify `apps/gateway-worker/package.json`: `@octg/tokenizer-controller` dependency。

### Shared cleanup and guards

- Modify `packages/shared/src/estimate.ts`: `estimateInputTokens`、encoding cache、`js-tiktoken` import を削除し、quota arithmetic だけを残す。
- Modify `packages/shared/src/errors.ts`: 503 error contract を追加する。
- Modify `packages/shared/test/estimate.test.ts`: BPE tests を削除し、quota arithmetic tests を維持する。
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
| 1 | `tokenizer-do/controller` | `main` | RPC contracts、estimator、safe logging、unit tests | Tokenizer focused tests と workspace typecheck |
| 2 | `tokenizer-do/wiring` | `tokenizer-do/controller` | Worker export、Env、Wrangler binding/v2、real DO test、Gateway client | Wrangler-backed DO/client tests と gateway typecheck |
| 3 | `tokenizer-do/cutover` | `tokenizer-do/wiring` | token budget、503 contract、proxy cutover、74k Gateway regression、quota lifecycle regression | Gateway success/failure tests、reserve/upstream ordering |
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

### Task 2: Lazy exact BPE と conservative fallback を実装する

**Files:**

- Create: `durable-objects/tokenizer-controller/src/estimator.ts`
- Create: `durable-objects/tokenizer-controller/src/observation.ts`
- Create: `durable-objects/tokenizer-controller/test/estimator.test.ts`
- Modify: `durable-objects/tokenizer-controller/src/index.ts`

**Interfaces:**

- Consumes: validated `TokenizeRequest`。
- Produces: `TokenizerEstimator.estimate(request, context): TokenizeResult`。
- Produces: `TokenizerEstimatorContext` with request/revision IDs and typed emitter。
- Produces: the typed `TokenizerStageEvent` contract consumed by the estimator。
- Invariant: only `Error` from encoding initialization/encode becomes conservative fallback。

- [ ] **Step 1: Write RED golden, fallback, retry, reuse, and overflow tests**

Use fixed values captured from the pre-migration `o200k_base` implementation:

```ts
it.each([
  ["", 0, 0, 3],
  ["Hello, world!", 1, 0, 11],
  ["こんにちは、世界！", 1, 0, 11],
  ["Hello 👋🌍", 1, 0, 12],
  ["const answer: number = 42;\nconsole.log(answer);", 2, 0, 23],
  [JSON.stringify({ model: "gpt-5.6-luna", input: "hello" }), 1, 7, 30],
  ["OCTG は exact BPE を Durable Object で実行します 🚀", 3, 11, 43],
])("preserves exact BPE parity", (inputText, messageCount, opaqueInputBytes, expected) => {
  expect(estimator.estimate({ requestId: "req_golden", inputText, messageCount, opaqueInputBytes }, context))
    .toEqual({ estimatedInputTokens: expected, estimationPath: "exact_bpe" });
});
```

Add long cases with fixed expected values:

```ts
const estimate = (inputText: string): number => estimator.estimate({
  requestId: "req_long_golden",
  inputText,
  messageCount: 1,
  opaqueInputBytes: 0,
}, context).estimatedInputTokens;

expect(estimate("The quick brown fox jumps over the lazy dog.\n".repeat(100))).toBe(1_007);
expect(estimate("こんにちは世界。\n".repeat(1_000))).toBe(3_007);
expect(estimate("OCTG は exact BPE を Durable Object で実行します 🚀\n".repeat(500))).toBe(9_007);
expect(estimate("The quick brown fox jumps over the lazy dog.\n".repeat(7_400))).toBe(74_007);
```

Inject a counting encoding factory and verify: one factory call across two successful
requests; initialization failure falls back and calls the factory again on the next
request; encode failure falls back without discarding the initialized encoding;
opaque bytes are added once; `Number.MAX_SAFE_INTEGER` arithmetic throws; a thrown
string is propagated rather than converted to fallback.

- [ ] **Step 2: Run estimator tests and verify RED**

```bash
npm exec vitest run --config apps/gateway-worker/vitest.config.ts \
  durable-objects/tokenizer-controller/test/estimator.test.ts
```

Expected: FAIL because `TokenizerEstimator` does not exist.

- [ ] **Step 3: Implement lazy encoding and safe estimation**

Create `observation.ts` with the event contract before importing it from the
estimator:

```ts
export type TokenizerStage = "init" | "encode";
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
      stage: "init",
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
            stage: "init",
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
            stage: "init",
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
        stage: "init",
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
      stage: "init",
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
      stage: "encode",
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
            stage: "encode",
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
            stage: "encode",
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
        stage: "encode",
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
        stage: "encode",
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
        stage: "encode",
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

- [ ] **Step 4: Run estimator tests and typecheck**

```bash
npm exec vitest run --config apps/gateway-worker/vitest.config.ts \
  durable-objects/tokenizer-controller/test/estimator.test.ts
npm run typecheck -w durable-objects/tokenizer-controller
```

Expected: exact and fallback cases pass and typecheck exits 0.

- [ ] **Step 5: Commit Task 2**

```bash
git add durable-objects/tokenizer-controller/src/estimator.ts \
  durable-objects/tokenizer-controller/src/observation.ts \
  durable-objects/tokenizer-controller/src/index.ts \
  durable-objects/tokenizer-controller/test/estimator.test.ts
git commit -m "feat: exact BPEと保守的fallbackを実装"
```

### Task 3: Safe Tokenizer stage logging と Durable Object class を追加する

**Files:**

- Modify: `durable-objects/tokenizer-controller/src/observation.ts`
- Create: `durable-objects/tokenizer-controller/src/tokenizer-controller.ts`
- Create: `durable-objects/tokenizer-controller/test/observation.test.ts`
- Modify: `durable-objects/tokenizer-controller/src/estimator.ts`
- Modify: `durable-objects/tokenizer-controller/src/index.ts`

**Interfaces:**

- Produces: `TokenizerStageEvent` with stages `init | encode` and outcomes `success | fallback | exception`。
- Produces: `emitTokenizerStage(event): void` which cannot throw into estimation。
- Produces: `TokenizerController.tokenize(request: TokenizeRequest): Promise<TokenizeResult>` with runtime parsing。

- [ ] **Step 1: Write RED observation tests**

Build an event with extra secret-bearing properties via `Object.assign`, then assert
that `console.log` receives only request ID, revision ID, stage, phase, duration,
outcome, byte/token counts, estimation path, and bounded failure category. Use the
secret strings `secret prompt`, `Bearer secret`, and `raw encoder failure` and assert
that none appears in serialized log arguments. Also make `console.log` throw and
assert `emitTokenizerStage()` does not throw.

- [ ] **Step 2: Run observation tests and verify RED**

```bash
npm exec vitest run --config apps/gateway-worker/vitest.config.ts \
  durable-objects/tokenizer-controller/test/observation.test.ts
```

Expected: FAIL because the event boundary does not exist.

- [ ] **Step 3: Implement allowlisted best-effort logging**

```ts
export type TokenizerStage = "init" | "encode";
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

Expected: all commands exit 0; logging tests contain no secret-bearing output.

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
`state.storage.list()` has size zero. The class env must not expose `DB` or
`QUOTA_CONTROLLER`, making D1/quota access unavailable by construction.

Invoke malformed RPC inputs without a type escape hatch:

```ts
const invokeMalformed = (value: unknown): Promise<TokenizeResult> =>
  Reflect.apply(controller().tokenize, controller(), [value]);
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

### Task 5: Gateway tokenizer client と response validation を追加する

**Files:**

- Create: `apps/gateway-worker/src/tokenizer.ts`
- Create: `apps/gateway-worker/test/tokenizer-client.test.ts`

**Interfaces:**

- Consumes: a structural namespace with `idFromName()` and `get()`。
- Produces: `TokenizerOutcome = resolved | unavailable`。
- Produces: `tokenizeInput(namespace, request): Promise<TokenizerOutcome>`。
- Invariant: fixed ID、one stub lookup、one RPC attempt、no retry、no timeout。

- [ ] **Step 1: Write RED client tests**

Use a generic fake namespace whose ID type is `string`. Assert the exact name
`tokenizer:primary`, one `get`, and one `tokenize`. Add table-driven malformed results:
missing fields, unknown path, NaN, Infinity, negative, fractional, and
`Number.MAX_SAFE_INTEGER + 1`. Add a rejected RPC and assert `unavailable` with one
attempt.

- [ ] **Step 2: Run client tests and verify RED**

```bash
npm test -w apps/gateway-worker -- test/tokenizer-client.test.ts
```

Expected: FAIL because the client does not exist.

- [ ] **Step 3: Implement generic namespace adapter and independent parser**

```ts
import type { TokenizeRequest, TokenizeResult } from "@octg/tokenizer-controller";

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

`tokenizeInput()` must resolve `idFromName("tokenizer:primary")`, obtain one stub,
await one `stub.tokenize(request)`, parse the result, and convert every rejection or
invalid result to `{ kind: "unavailable" }`. It must not call itself recursively,
schedule a timer, or perform local estimation.

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
git commit -m "feat: Gateway Tokenizer clientを追加"
gh stack add tokenizer-do/cutover
```

---

## PR 3: `tokenizer-do/cutover`

### Task 6: Safe quota arithmetic と HTTP 503 contract を追加する

**Files:**

- Create: `apps/gateway-worker/src/token-budget.ts`
- Create: `apps/gateway-worker/test/token-budget.test.ts`
- Modify: `packages/shared/src/errors.ts:155-183`
- Modify: `packages/shared/test/errors.test.ts`
- Modify: `apps/gateway-worker/src/resource-observation.ts:10-21`
- Modify: `apps/gateway-worker/test/resource-observation.test.ts`

**Interfaces:**

- Produces: `resolveTokenBudget(args): TokenBudgetOutcome`。
- Produces outcomes: `resolved | request_too_large | quota_exceeded | unavailable`。
- Produces: `errTokenizerUnavailable(quota, requestId)` with exact 503 body/headers。

- [ ] **Step 1: Write RED budget and error-contract tests**

Test valid REJECT and CLAMP decisions, upper-bound 413, quota 429, invalid/overflow
estimated input, limit, remaining ratio, margin, upper bound, output, and reservation.
For 503, assert exact status, body, `X-OCTG-*` quota headers, route, and absence of
`Retry-After`.

```ts
expect(await errorResponse(errTokenizerUnavailable(snapshot, "req_tokenizer")).json())
  .toEqual({
    error: {
      message: "Token estimation service unavailable.",
      type: "server_error",
      param: null,
      code: "tokenizer_unavailable",
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

Expected: FAIL because budget outcome, route, and 503 helper do not exist.

- [ ] **Step 3: Implement typed budget calculation**

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
  | { readonly kind: "unavailable" };
```

Validate all inputs before division. Call existing `safetyMargin`, `upperBoundOf`, and
`decideOutput`; validate every returned number as a non-negative safe integer. Return
`request_too_large` only for a valid upper bound above a valid pool limit,
`quota_exceeded` only for a valid reject decision, and `unavailable` for every invalid
arithmetic result. Never clamp an invalid number.

- [ ] **Step 4: Implement 503 helper and observation route**

```ts
export function errTokenizerUnavailable(
  quota: QuotaSnapshot,
  requestId: string,
): OctgHttpError {
  return makeError(
    503,
    requestId,
    "Token estimation service unavailable.",
    "server_error",
    null,
    "tokenizer_unavailable",
    { quota, route: "error:tokenizer_unavailable" },
  );
}
```

Add only `"error:tokenizer_unavailable"` to `ResourceStageRoute`; do not add a new
stage or `Retry-After` behavior.

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
git commit -m "feat: Tokenizer障害の503契約を追加"
```

### Task 7: Proxy を Tokenizer RPC へ cut over する

**Files:**

- Modify: `apps/gateway-worker/src/proxy.ts:1-31,353-400`
- Create: `apps/gateway-worker/test/tokenizer-integration.test.ts`
- Create: `apps/gateway-worker/test/tokenizer-74k-regression.test.ts`
- Modify: `apps/gateway-worker/test/proxy.test.ts`
- Modify: `apps/gateway-worker/test/proxy-failures.test.ts:1-7,278-304`

**Interfaces:**

- Consumes: `tokenizeInput(env.TOKENIZER_CONTROLLER, TokenizeRequest)`。
- Consumes: `resolveTokenBudget()` outcomes。
- Preserves: all existing reserve/in-flight/upstream/finalization code after the current reservation calculation。

- [ ] **Step 1: Write RED HTTP integration tests**

Temporarily replace `env.TOKENIZER_CONTROLLER` with a configurable fake via
`Object.defineProperty`. For each failure, drive `SELF.fetch()` and assert:

1. rejected RPC, overload-like rejection, and malformed result return 503;
2. missing field, unknown path, NaN, Infinity, negative, fractional, and unsafe token count return 503;
3. Tokenizer RPC call count is exactly one;
4. reserve state and request count do not change;
5. upstream fetch count is zero;
6. response has quota snapshot headers and no `Retry-After`;
7. tokenize finish log contains route `error:tokenizer_unavailable`, `quotaReserved: false`, `upstreamReached: false`;
8. no `quota_reserve` or `upstream` start event is emitted;
9. prompt, body, Authorization, API key, exception text, and stack are absent from logs.

Add success lifecycle cases for settle, upstream uncertainty/markUncertain, known
pre-upstream release, and reserve rejection/upstream zero. Assert Tokenizer is called
before the first reserve call in an ordered call trace.

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

Remove `estimateInputTokens` from the shared import. Build this exact request after
`quota_get_state` succeeds:

```ts
const tokenizerOutcome = await tokenizeInput(env.TOKENIZER_CONTROLLER, {
  requestId,
  inputText: requestData.inputText,
  messageCount: requestData.messageCount,
  opaqueInputBytes: requestData.opaqueInputBytes,
});
```

If unavailable, finish the existing `tokenize` stage as `exception` with the fixed
route and false booleans, complete audit best-effort as failed, and return
`errTokenizerUnavailable(snapshot, requestId)` before reserve starts.

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

Expected: all commands exit 0; every Tokenizer failure has reserve/upstream count zero.

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

The Tokenizer-specific 503 fault injection remains in the Worker-pool integration test
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

State that rollback creates a new deployment using the selected previous Worker
version, does not remove/rewrite `v2`, and must not activate Gateway local BPE. After
rollback, restrict large requests operationally because the previous revision retains
the known Error 1102 risk.

- [ ] **Step 3: Expand the evidence table for AC-01 through AC-13**

For one documented revision, record: Worker plan, expected peak value and rationale,
request ID, `$workers.outcome`, CPU/wall time, Gateway tokenize start/finish,
Tokenizer `init`/`encode` events, estimation path, reserve/upstream ordering, actual
usage settlement, failure reserve/upstream counts, and AI Gateway A/B payload logging
state. A missing field keeps the incident open.

- [ ] **Step 4: Run full local verification**

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

- [ ] **Step 5: Deploy and run the required production canary**

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
appears in Worker, Tokenizer, or AI Gateway logs.

- [ ] **Step 6: Commit documentation and evidence**

```bash
git add README.md docs/DEPLOY_FROM_TEMPLATE.md \
  docs/troubleshooting-503-worker-resource-limits.md
git commit -m "docs: Tokenizer DOのcanaryとrollbackを追加"
```

- [ ] **Step 7: Submit four stacked PRs, not one PR**

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
| AC-08 | injected RPC/malformed/overflow tests with reserve=0/upstream=0 | correlate any canary unavailable event without adding a production fault hook |
| AC-09 | existing settle/uncertain/release suites | upstream uncertain remains reconcilable |
| AC-10 | allowlist/redaction/Storage tests | Worker/DO/AI Gateway log inspection |
| AC-11 / AC-13 | canary driver validation | concurrency 1/2/expected peak on Free Plan |
| AC-12 | root scripts | `npm test` and `npm run typecheck` exit 0 |

Implementation is complete only after all four stacked PR layers are green and the
production evidence row is fully populated for one deployment revision.
