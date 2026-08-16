# Worker Resource Limits Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

<!-- markdownlint-disable MD013 MD032 -->

**Goal:** Error 1102 の原因を revision と request ID 単位で切り分け、確認できた CPU、memory、並行負荷の分岐だけを適用しながら、大規模入力の fail-closed な quota reservation を維持する。

**Architecture:** まず Workers Logs / traces と OCTG の安全な stage event を組み合わせ、deployment revision、invocation outcome、CPU / wall time、入力 byte 数、推定経路、reserve / upstream 到達を関連付ける。観測結果をゲートとして、CPU 分岐では BPE cutoff、memory 分岐では raw / normalized limit の分離、並行負荷分岐では quota state と独立した期限付き tokenization lease を追加する。各分岐は独立して承認・テスト・デプロイでき、観測で確認されていない分岐は実装しない。

**Tech Stack:** TypeScript strict, Cloudflare Workers, Workers Logs / traces, Durable Objects with SQLite-backed storage, D1, npm workspaces, Vitest, `@cloudflare/vitest-pool-workers`, `js-tiktoken`.

## Global Constraints

- Invocation outcome 取得前に BPE cutoff を production の恒久対策として有効化しない。
- Quota の authoritative state は Durable Object に置き、D1 は監査・証跡用途だけに使う。
- D1 監査の失敗を quota 判定または upstream 到達条件にしない。
- 未検証の byte 比率式を request 全体の token 上限として使わない。
- Workers プランの既定値から障害時 deployment の実効 CPU / memory limit を推定しない。
- 入力本文、tokenizer 対象文字列、認証素材、`octg_sk_*` をログへ記録しない。
- 約 74,000-token 級の確認済み payload は、安全性を確認できる限り受理する。
- 安全な予約上限を確認できない payload 形状は reserve 前に HTTP 400 `invalid_request` で拒否する。
- Raw / normalized hard limit 超過は HTTP 413 `request_too_large` とし、reserve と upstream を実行しない。
- Tokenization admission 飽和は HTTP 429 `rate_limit_error`、code `tokenization_concurrency_exceeded`、route `reject:tokenization_concurrency` とする。
- Production の `BPE_MAX_INPUT_BYTES`、`MAX_RAW_BODY_BYTES`、`MAX_NORMALIZED_INPUT_BYTES`、`MAX_TOKENIZATION_REQUESTS`、`TOKENIZATION_LEASE_TTL_MS` は canary の profile から決定し、観測前には `wrangler.jsonc` へ値を追加しない。
- Existing upstream in-flight lease と settle / markUncertain / release 契約は変更しない。
- `as any`、`@ts-ignore`、`@ts-expect-error`、non-null assertion を追加しない。

---

## File Structure

### Mandatory baseline

- Modify `docs/troubleshooting-503-worker-resource-limits.md`: fact / unknown / current implementation / observation gate / remediation branches / resolution criteria に再構成する。
- Modify `apps/gateway-worker/wrangler.jsonc`: Workers Logs、traces、version metadata binding を有効化し、対策値は追加しない。
- Modify `apps/gateway-worker/src/index.ts`: `CF_VERSION_METADATA` binding を型定義する。
- Create `apps/gateway-worker/src/resource-observation.ts`: payload を含まない resource stage event の型と出力を所有する。
- Modify `apps/gateway-worker/src/request-body.ts`: raw bytes、body read time、parse time を結果へ返す。
- Modify `apps/gateway-worker/src/db.ts`: insert / completion の失敗を quota flow へ伝播させない best-effort wrapper を提供する。
- Modify `apps/gateway-worker/src/proxy.ts`: stage event、同一 request ID の 500、reserve 不明状態の fail-closed 処理を統合する。
- Modify `apps/gateway-worker/src/upstream.ts`: AI Gateway payload collection を無効化する。
- Create `apps/gateway-worker/test/resource-observation.test.ts`: event の安全な field contract を検証する。
- Create `apps/gateway-worker/test/request-body.test.ts`: raw body metrics と境界を検証する。
- Modify `apps/gateway-worker/test/proxy.test.ts`: payload collection 無効化と正常 lifecycle を検証する。
- Modify `apps/gateway-worker/test/proxy-failures.test.ts`: audit failure、推定 / reserve 例外、reserve 不明状態を検証する。
- Create `scripts/canary-worker-resource-limits.mjs`: 同一 payload を concurrency 1、2、想定ピークで送る canary driver とする。

### CPU branch only

- Modify `packages/shared/src/estimate.ts`: exact BPE と conservative bytes を区別する推定結果を返す。
- Modify `packages/shared/test/estimate.test.ts`: cutoff の直前 / 境界 / 直後と opaque bytes の単一加算を検証する。
- Modify `apps/gateway-worker/src/index.ts`: optional `BPE_MAX_INPUT_BYTES` binding を型定義する。
- Modify `apps/gateway-worker/src/proxy.ts`: cutoff 設定と推定経路を統合する。
- Modify `apps/gateway-worker/test/proxy-failures.test.ts`: byte-based 経路の予約値と upstream 非到達を検証する。
- Create `packages/shared/test/payload-differential.canary.test.ts`: accepted payload と upstream `usage.total_tokens` を比較する。

### Memory branch only

- Modify `apps/gateway-worker/src/index.ts`: optional raw / normalized limit bindings を型定義する。
- Modify `apps/gateway-worker/src/proxy.ts`: raw / normalized limit を別々に解決する。
- Modify `apps/gateway-worker/test/proxy-failures.test.ts`: 両 limit の直前 / 境界 / 1 byte 超過を検証する。

### Concurrency branch only

- Modify `packages/shared/src/types.ts`: tokenization lease と RPC result union を定義する。
- Modify `packages/shared/src/errors.ts`: admission 専用 429 契約を定義する。
- Modify `durable-objects/quota-controller/src/store.ts`: quota と独立した lease storage を追加する。
- Modify `durable-objects/quota-controller/src/quota-controller.ts`: acquire / release RPC を transaction で実装する。
- Modify `apps/gateway-worker/src/index.ts`: optional admission bindings を型定義する。
- Modify `apps/gateway-worker/src/proxy.ts`: BPE 前 acquire と matching lease release を統合する。
- Modify `apps/gateway-worker/test/quota-controller.test.ts`: expiry、idempotency、stale release、quota 非消費を検証する。
- Modify `apps/gateway-worker/test/proxy-failures.test.ts`: admission 429 と推定例外 cleanup を検証する。

## Execution Gates

| Gate | Required evidence | Allowed tasks |
| --- | --- | --- |
| Baseline | なし。診断と秘匿性の前提 | Tasks 1-4 |
| CPU | 同じ request ID / revision で `exceededCpu`、かつ tokenize が主要 CPU 区間 | Tasks 5-6 |
| Memory | 同じ request ID / revision で `exceededMemory`、かつ memory profile が一時 allocation を特定 | Task 7 |
| Concurrency | concurrency 1 は成功し、2 または想定ピーク時だけ BPE 同時進入中に失敗 | Tasks 8-9 |
| Resolution | 適用した分岐の canary と payload differential が全条件を満たす | Task 10 |

複数の原因が確認された場合だけ対応する複数 branch を実行する。Gate を満たさない branch は読み飛ばし、設定値も追加しない。

### Task 1: Incident report と platform observability を現行実装へ合わせる

**Files:**
- Modify: `docs/troubleshooting-503-worker-resource-limits.md:1-481`
- Modify: `apps/gateway-worker/wrangler.jsonc:1-28`
- Modify: `apps/gateway-worker/src/index.ts:12-29`
- Modify: `apps/gateway-worker/src/upstream.ts:43-52`
- Modify: `apps/gateway-worker/test/proxy.test.ts:45-67`

**Interfaces:**
- Produces: `Env.CF_VERSION_METADATA: WorkerVersionMetadata`.
- Produces: Workers invocation logs / traces with version, outcome, CPU time, wall time, binding spans, and upstream fetch spans.
- Produces: AI Gateway request header `cf-aig-collect-log-payload: false`.

- [ ] **Step 1: Write the failing upstream privacy assertion**

Change the existing assertion in `proxy.test.ts` before production code:

```ts
expect(upstreamHeaders?.get("cf-aig-collect-log-payload")).toBe("false");
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -w apps/gateway-worker -- test/proxy.test.ts`

Expected: FAIL because `callUpstream()` currently sends `true`.

- [ ] **Step 3: Enable platform correlation and disable payload collection**

Add the following top-level configuration to `wrangler.jsonc`:

```jsonc
"version_metadata": { "binding": "CF_VERSION_METADATA" },
"observability": {
  "enabled": true,
  "logs": { "invocation_logs": true, "head_sampling_rate": 1 },
  "traces": { "enabled": true, "head_sampling_rate": 1 }
}
```

Add this binding to `Env`:

```ts
readonly CF_VERSION_METADATA: WorkerVersionMetadata;
```

Change the AI Gateway control header to:

```ts
"cf-aig-collect-log-payload": "false",
```

- [ ] **Step 4: Rewrite the incident report around evidence and gates**

Use these exact top-level sections:

```markdown
## インシデント事実
## 未確定事項
## 現行実装と処理順序
## 観測ゲート
## 原因別対策
## Canary 手順
## 解決判定
```

Delete the claim that `NormalizedRequest.inputTextBytes` is missing. Document that
`normalize.ts` already maintains `inputBytes = inputTextBytes + opaqueInputBytes`
for Responses. State that `$workers.outcome`, `$workers.cpuTimeMs`, and
`$workers.wallTimeMs` come from Workers invocation telemetry, while OCTG custom
events provide only application stages and safe numeric metadata.

- [ ] **Step 5: Run focused verification**

Run: `npm test -w apps/gateway-worker -- test/proxy.test.ts`

Expected: PASS; the upstream request still succeeds and payload collection is false.

- [ ] **Step 6: Prepare the commit boundary**

Run only after an explicit user instruction to perform git operations:

```bash
git add docs/troubleshooting-503-worker-resource-limits.md \
  apps/gateway-worker/wrangler.jsonc \
  apps/gateway-worker/src/index.ts \
  apps/gateway-worker/src/upstream.ts \
  apps/gateway-worker/test/proxy.test.ts
git commit -m "fix: Worker障害の観測条件とpayload秘匿を修正"
```

### Task 2: Safe resource stage events と request-body metrics を追加する

**Files:**
- Create: `apps/gateway-worker/src/resource-observation.ts`
- Create: `apps/gateway-worker/test/resource-observation.test.ts`
- Modify: `apps/gateway-worker/src/request-body.ts:1-38`
- Create: `apps/gateway-worker/test/request-body.test.ts`
- Modify: `apps/gateway-worker/src/proxy.ts:84-259`

**Interfaces:**
- Produces: `ResourceStage`, `ResourceStageEvent`, `emitResourceStage(event): void`.
- Produces: `ReadJsonBodyMetrics` and metrics on every `ReadJsonBodyResult` branch.
- Constraint: event types do not accept payload text, request headers, API keys, or tokenizer input.

- [ ] **Step 1: Write RED tests for the event contract and body metrics**

Use the following public contracts in the tests:

```ts
export type ResourceStage =
  | "body_read"
  | "parse"
  | "normalize"
  | "tokenize"
  | "quota_get_state"
  | "quota_reserve"
  | "upstream";

export interface ResourceStageEvent {
  readonly event: "octg.resource_stage";
  readonly requestId: string;
  readonly revisionId: string;
  readonly stage: ResourceStage;
  readonly phase: "start" | "finish";
  readonly durationMs?: number;
  readonly rawBodyBytes?: number;
  readonly inputBytes?: number;
  readonly inputTextBytes?: number;
  readonly opaqueInputBytes?: number;
  readonly estimationPath?: "exact_bpe" | "conservative_bytes";
  readonly concurrency?: number;
  readonly quotaReserved?: boolean;
  readonly upstreamReached?: boolean;
}

export interface ReadJsonBodyMetrics {
  readonly rawBodyBytes: number;
  readonly bodyReadMs: number;
  readonly parseMs: number;
}
```

Assert that a valid JSON body returns its exact UTF-8 byte count and non-negative
durations. Test `Content-Length` present and absent at `limit - 1`, `limit`, and
`limit + 1`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm test -w apps/gateway-worker -- test/resource-observation.test.ts test/request-body.test.ts`

Expected: FAIL because the module and metrics do not exist.

- [ ] **Step 3: Implement the typed event boundary**

Implement `resource-observation.ts` with a single structured object log:

```ts
export function emitResourceStage(event: ResourceStageEvent): void {
  console.info(event);
}
```

Do not serialize arbitrary objects. Every field must be a primitive admitted by
`ResourceStageEvent`.

- [ ] **Step 4: Return body metrics without retaining extra payload copies**

Change `ReadJsonBodyResult` to:

```ts
type ReadJsonBodyResult =
  | { readonly ok: true; readonly body: unknown; readonly metrics: ReadJsonBodyMetrics }
  | {
      readonly ok: false;
      readonly reason: "invalid_json" | "too_large";
      readonly metrics: ReadJsonBodyMetrics;
    };
```

Measure `bodyReadMs` around stream consumption and chunk concatenation, then
`parseMs` around decode plus `JSON.parse`. Preserve the current `>` boundary and
cancel the reader on stream overflow.

- [ ] **Step 5: Instrument the proxy at decision boundaries**

Emit start / finish events around normalize, tokenize, DO `getState`, reserve,
and upstream. Use the same `requestId` and `env.CF_VERSION_METADATA.id` on every
event. Log only byte counts, duration, route state, estimation path, and booleans.
Do not add event emission inside shared pure functions or Durable Object storage
helpers.

- [ ] **Step 6: Run the focused tests and typecheck**

Run: `npm test -w apps/gateway-worker -- test/resource-observation.test.ts test/request-body.test.ts test/proxy.test.ts test/proxy-failures.test.ts`

Run: `npm run typecheck -w apps/gateway-worker`

Expected: all commands exit 0 and no changed TypeScript file has LSP diagnostics.

- [ ] **Step 7: Prepare the commit boundary**

Run only after an explicit user instruction to perform git operations:

```bash
git add apps/gateway-worker/src/resource-observation.ts \
  apps/gateway-worker/src/request-body.ts \
  apps/gateway-worker/src/proxy.ts \
  apps/gateway-worker/test/resource-observation.test.ts \
  apps/gateway-worker/test/request-body.test.ts
git commit -m "feat: Workerリソース段階の安全な観測を追加"
```

### Task 3: Audit failure と pre-upstream exception を fail-closed にする

**Files:**
- Modify: `apps/gateway-worker/src/db.ts:4-64`
- Create: `apps/gateway-worker/src/quota-reservation.ts`
- Create: `apps/gateway-worker/test/quota-reservation.test.ts`
- Modify: `apps/gateway-worker/src/proxy.ts:41-184`
- Modify: `apps/gateway-worker/test/proxy-failures.test.ts:49-238`

**Interfaces:**
- Produces: `startRequestAuditBestEffort(...): Promise<boolean>`.
- Produces: `completeRequestAuditBestEffort(...): Promise<void>`.
- Produces: `reserveFailClosed(...): Promise<ResolvedReserve | UnknownReserve>`.
- Invariant: unknown reserve outcome never triggers quota release and never reaches upstream.

- [ ] **Step 1: Write RED tests for audit and reserve failures**

Define the reservation result wrapper in the tests:

```ts
type ResolvedReserve = { readonly kind: "resolved"; readonly result: ReserveResult };
type UnknownReserve = { readonly kind: "unknown" };
```

Test these cases independently:

1. D1 insert rejects, but a valid request still reserves and reaches upstream.
2. D1 completion rejects, but settlement remains authoritative in the DO.
3. First `reserve()` call rejects and the idempotent retry returns a saved result.
4. Both reserve attempts reject; response is 500 with the original request ID,
   upstream count is zero, and no `release(requestId)` is called.
5. Estimation throws; response is 500, audit completion is attempted, reserve and
   upstream are not called.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm test -w apps/gateway-worker -- test/quota-reservation.test.ts test/proxy-failures.test.ts`

Expected: FAIL because D1 failures currently leak into the request path and reserve
outcome resolution is not isolated.

- [ ] **Step 3: Implement best-effort audit wrappers**

Use promise rejection handlers so D1 never changes the quota decision:

```ts
export function startRequestAuditBestEffort(
  env: Env,
  row: RequestLogRow,
): Promise<boolean> {
  return insertRequestRow(env, row).then(
    () => true,
    () => false,
  );
}
```

`completeRequestAuditBestEffort` must skip the update when insert failed and must
resolve to `undefined` when the update rejects.

- [ ] **Step 4: Implement idempotent reserve outcome resolution**

`reserveFailClosed` calls the same DO `reserve()` RPC with the same request ID and
arguments after a transport exception. A resolved retry returns `kind: "resolved"`.
If the retry also rejects, return `kind: "unknown"`; do not call quota release.

- [ ] **Step 5: Add the proxy error boundary before upstream**

Keep the generated `requestId` in scope. Convert estimation, margin, upper-bound,
output-decision, and reserve exceptions to `errInternal(requestId)`. Attempt audit
completion through the best-effort wrapper. Preserve existing handling after a
known successful reservation.

- [ ] **Step 6: Run focused and full workspace verification**

Run: `npm test -w apps/gateway-worker -- test/quota-reservation.test.ts test/proxy-failures.test.ts test/proxy.test.ts`

Run: `npm run typecheck -w apps/gateway-worker`

Expected: all commands exit 0.

- [ ] **Step 7: Prepare the commit boundary**

Run only after an explicit user instruction to perform git operations:

```bash
git add apps/gateway-worker/src/db.ts \
  apps/gateway-worker/src/quota-reservation.ts \
  apps/gateway-worker/src/proxy.ts \
  apps/gateway-worker/test/quota-reservation.test.ts \
  apps/gateway-worker/test/proxy-failures.test.ts
git commit -m "fix: reserve前例外をfail-closedで処理"
```

### Task 4: Canary driver を作り原因 branch を確定する

**Files:**
- Create: `scripts/canary-worker-resource-limits.mjs`
- Modify: `docs/troubleshooting-503-worker-resource-limits.md`

**Interfaces:**
- Consumes: `OCTG_CANARY_URL`, `OCTG_CANARY_CLIENT_KEY`, `CANARY_PAYLOAD_PATH`, `CANARY_CONCURRENCY`.
- Produces: payload を含まない JSON Lines with status, duration, request ID, and concurrency.

- [ ] **Step 1: Implement argument and secret boundaries**

The script must read the request body from `CANARY_PAYLOAD_PATH`, the key only from
`OCTG_CANARY_CLIENT_KEY`, and concurrency from a comma-separated positive integer
list. It must never print the key, headers, or payload.

Implement the driver with this control flow:

```js
import { readFile } from "node:fs/promises";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new TypeError(`${name} is required`);
  return value;
};

const url = required("OCTG_CANARY_URL");
const apiKey = required("OCTG_CANARY_CLIENT_KEY");
const payload = await readFile(required("CANARY_PAYLOAD_PATH"), "utf8");
JSON.parse(payload);
const concurrencies = required("CANARY_CONCURRENCY")
  .split(",")
  .map((value) => Number(value));
if (concurrencies.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
  throw new TypeError("CANARY_CONCURRENCY must contain positive safe integers");
}

for (const concurrency of concurrencies) {
  const results = await Promise.all(Array.from({ length: concurrency }, async (_, ordinal) => {
    const startedAt = performance.now();
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: payload,
    });
    return {
      event: "octg.canary.result",
      concurrency,
      ordinal,
      status: response.status,
      durationMs: performance.now() - startedAt,
      requestId: response.headers.get("X-OCTG-Request-Id"),
    };
  }));
  for (const result of results) console.log(JSON.stringify(result));
}
```

Output one line per request in this shape:

```js
{
  event: "octg.canary.result",
  concurrency,
  ordinal,
  status,
  durationMs,
  requestId: response.headers.get("X-OCTG-Request-Id"),
}
```

- [ ] **Step 2: Exercise one bad-input path locally**

Run with an unreadable `CANARY_PAYLOAD_PATH` and verify a non-zero exit code without
printing `OCTG_CANARY_CLIENT_KEY`.

- [ ] **Step 3: Run the 74,000-token canary at all required concurrency levels**

Run:

```bash
OCTG_CANARY_URL="$OCTG_CANARY_URL" \
OCTG_CANARY_CLIENT_KEY="$OCTG_CANARY_CLIENT_KEY" \
CANARY_PAYLOAD_PATH="$CANARY_PAYLOAD_PATH" \
CANARY_CONCURRENCY="1,2,$EXPECTED_PEAK_CONCURRENCY" \
node scripts/canary-worker-resource-limits.mjs
```

Correlate each `X-OCTG-Request-Id` with version ID, `$workers.outcome`,
`$workers.cpuTimeMs`, `$workers.wallTimeMs`, custom stage events, and trace spans.

- [ ] **Step 4: Record the branch decision**

Update the incident report evidence table with the exact revision, effective
`limits.cpu_ms`, memory limit, raw / normalized bytes, stage durations, outcome,
concurrency, quota reserve presence, and upstream reachability.

Select branches only by the `Execution Gates` table. If no branch gate is met,
stop implementation after Task 4 and keep the incident open.

- [ ] **Step 5: Prepare the commit boundary**

Run only after an explicit user instruction to perform git operations:

```bash
git add scripts/canary-worker-resource-limits.mjs \
  docs/troubleshooting-503-worker-resource-limits.md
git commit -m "test: Workerリソース障害のcanary計測を追加"
```

### Task 5: CPU branch - exact BPE と conservative bytes を分離する

**Gate:** Execute only when the CPU gate is satisfied.

**Files:**
- Modify: `packages/shared/src/estimate.ts:1-46`
- Modify: `packages/shared/test/estimate.test.ts:1-130`
- Modify: `apps/gateway-worker/src/index.ts:12-29`
- Modify: `apps/gateway-worker/src/proxy.ts:133-155`
- Modify: `apps/gateway-worker/test/proxy-failures.test.ts`

**Interfaces:**
- Produces: `InputEstimationPath`, `InputEstimation`, `EstimateInputTokensArgs`.
- Produces: `estimateInputTokens(args: EstimateInputTokensArgs): InputEstimation`.
- Produces: `resolveBpeMaxInputBytes(configured?: string): number | undefined`.

- [ ] **Step 1: Write RED unit tests at the cutoff boundary**

Use this API:

```ts
export type InputEstimationPath = "exact_bpe" | "conservative_bytes";

export interface InputEstimation {
  readonly path: InputEstimationPath;
  readonly tokens: number;
}

export interface EstimateInputTokensArgs {
  readonly inputText: string;
  readonly inputTextBytes: number;
  readonly inputBytes: number;
  readonly messageCount: number;
  readonly opaqueInputBytes: number;
  readonly bpeMaxInputBytes?: number;
}
```

Add cases for `inputBytes = cutoff - 1`, `cutoff`, and `cutoff + 1`. Assert only
the first uses `exact_bpe`. Add printable ASCII, CJK, multiple messages, and a
Responses case where `inputTextBytes = 100_000`, `opaqueInputBytes = 20_000`, and
`inputBytes = 120_000`; assert opaque bytes are added exactly once.

- [ ] **Step 2: Run shared tests and verify RED**

Run: `npm test -w packages/shared -- test/estimate.test.ts`

Expected: FAIL because the current API always attempts exact BPE and returns only a number.

- [ ] **Step 3: Implement the minimal estimator**

Use `inputBytes` only for cutoff selection. Use `inputTextBytes` as the text base
on the conservative path:

```ts
const useExact = args.bpeMaxInputBytes === undefined ||
  args.inputBytes < args.bpeMaxInputBytes;
const base = useExact ? exactBpeTokens(args.inputText) : args.inputTextBytes;
return {
  path: useExact ? "exact_bpe" : "conservative_bytes",
  tokens: base + args.opaqueInputBytes + 4 * args.messageCount + 3,
};
```

If encoding lookup fails, return the UTF-8 byte base with path
`conservative_bytes`.

- [ ] **Step 4: Integrate the optional Worker setting**

Add only the type declaration at first:

```ts
readonly BPE_MAX_INPUT_BYTES?: string;
```

`resolveBpeMaxInputBytes` returns a positive safe integer or `undefined`. Pass all
three byte counters from `NormalizedRequest` into the estimator and use
`estimation.tokens` for margin, upper bound, and reservation. Emit
`estimation.path` in the tokenize finish event.

- [ ] **Step 5: Run focused Worker tests**

Run: `npm test -w apps/gateway-worker -- test/proxy-failures.test.ts test/proxy.test.ts`

Run: `npm run typecheck -w packages/shared`

Run: `npm run typecheck -w apps/gateway-worker`

Expected: all commands exit 0. Do not add a production value to `wrangler.jsonc`
until Task 6 passes and the profiled cutoff is documented.

- [ ] **Step 6: Prepare the commit boundary**

Run only after an explicit user instruction to perform git operations:

```bash
git add packages/shared/src/estimate.ts \
  packages/shared/test/estimate.test.ts \
  apps/gateway-worker/src/index.ts \
  apps/gateway-worker/src/proxy.ts \
  apps/gateway-worker/test/proxy-failures.test.ts
git commit -m "feat: 大規模入力を保守的byte推定へ切り替え"
```

### Task 6: CPU branch - payload differential safety gate を固定する

**Gate:** Execute after Task 5 and before setting production `BPE_MAX_INPUT_BYTES`.

**Files:**
- Create: `packages/shared/test/payload-differential.canary.test.ts`
- Modify: `packages/shared/src/normalize.ts:66-259` only for a shape that fails the differential condition.
- Modify: `packages/shared/test/normalize.test.ts` only for a shape that fails the differential condition.
- Modify: `apps/gateway-worker/wrangler.jsonc` after every accepted fixture passes.
- Modify: `docs/troubleshooting-503-worker-resource-limits.md`

**Interfaces:**
- Consumes: current `normalizeChatCompletions`, `normalizeResponses`, `estimateInputTokens`, `safetyMargin`.
- Produces: a canary assertion that reservation is never below upstream `usage.total_tokens`.

- [ ] **Step 1: Add explicit canary fixtures**

Create independent fixtures for:

1. Chat text-only.
2. Chat multiple messages.
3. Chat tools.
4. Responses text-only.
5. Responses multiple message / item.
6. Responses tools.
7. Responses reasoning.
8. Responses `function_call`.
9. Responses `function_call_output`.
10. Responses composite tool and reasoning history.

Every fixture must specify `max_completion_tokens` or `max_output_tokens` as `1`
to minimize canary output while exercising output normalization.

Keep the external suite out of credential-free test runs:

```ts
const canRun =
  process.env.OCTG_CANARY_UPSTREAM_BASE_URL !== undefined &&
  process.env.OCTG_CANARY_UPSTREAM_API_TOKEN !== undefined;

describe.runIf(canRun)("payload reservation differential canary", () => {
  for (const fixture of fixtures) {
    it(fixture.id, async () => {
      const normalized = fixture.endpoint === "chat"
        ? normalizeChatCompletions(fixture.body)
        : normalizeResponses(fixture.body);
      expect(normalized.ok).toBe(true);
      if (!normalized.ok) return;
      const estimation = estimateInputTokens({
        inputText: normalized.value.inputText,
        inputTextBytes: normalized.value.inputTextBytes,
        inputBytes: normalized.value.inputBytes,
        messageCount: normalized.value.messageCount,
        opaqueInputBytes: normalized.value.opaqueInputBytes,
        bpeMaxInputBytes: fixture.bpeMaxInputBytes,
      });
      const margin = safetyMargin(estimation.tokens, 1);
      const upstreamUsage = await sendCanaryFixture(fixture);
      expect(
        estimation.tokens + normalized.value.maxOutputTokens + margin,
      ).toBeGreaterThanOrEqual(upstreamUsage.total_tokens);
    });
  }
});
```

- [ ] **Step 2: Compare local reservation with independent upstream usage**

For each fixture, normalize and estimate locally, send the original payload to the
canary upstream, and assert:

```ts
const reservation = estimation.tokens + normalized.value.maxOutputTokens + margin;
expect(reservation).toBeGreaterThanOrEqual(upstreamUsage.total_tokens);
```

Also assert Chat sends `max_completion_tokens` and Responses sends
`max_output_tokens` through the existing local Worker integration tests.
The canary test appends `/chat/completions` or `/responses` to
`OCTG_CANARY_UPSTREAM_BASE_URL` and sends
`cf-aig-authorization: Bearer ${OCTG_CANARY_UPSTREAM_API_TOKEN}` without printing
the header or token.

- [ ] **Step 3: Run the external differential suite**

Run with canary-only credentials supplied as environment variables:

```bash
OCTG_CANARY_UPSTREAM_BASE_URL="$OCTG_CANARY_UPSTREAM_BASE_URL" \
OCTG_CANARY_UPSTREAM_API_TOKEN="$OCTG_CANARY_UPSTREAM_API_TOKEN" \
npm test -w packages/shared -- test/payload-differential.canary.test.ts
```

Expected: every accepted fixture passes. A failing fixture must remain rejected by
the normalizer before reserve; add a RED normalization test for that exact feature,
then remove the feature from the accepted grammar.

- [ ] **Step 4: Set the profiled cutoff only after the suite passes**

Read the `BPE cutoff bytes` field from the incident report row for the exact canary
revision. Add `BPE_MAX_INPUT_BYTES` to `wrangler.jsonc` using that decimal integer as
a JSON string. If the row has no positive safe integer, stop Task 6 without editing
`wrangler.jsonc`; the plan intentionally does not invent this value.

- [ ] **Step 5: Prepare the commit boundary**

Run only after an explicit user instruction to perform git operations:

```bash
git add packages/shared/test/payload-differential.canary.test.ts \
  apps/gateway-worker/wrangler.jsonc \
  docs/troubleshooting-503-worker-resource-limits.md \
  packages/shared/src/normalize.ts \
  packages/shared/test/normalize.test.ts
git commit -m "test: payload予約値をupstream usageで検証"
```

### Task 7: Memory branch - raw body と normalized input の上限を分離する

**Gate:** Execute only when the Memory gate is satisfied.

**Files:**
- Modify: `apps/gateway-worker/src/index.ts:18-22`
- Modify: `apps/gateway-worker/src/proxy.ts:74-109`
- Modify: `apps/gateway-worker/test/proxy-failures.test.ts:22-147`
- Modify: `apps/gateway-worker/wrangler.jsonc` after profiling establishes both values.
- Modify: `docs/troubleshooting-503-worker-resource-limits.md`

**Interfaces:**
- Produces: `resolveInputLimits(env): { rawBodyBytes: number; normalizedInputBytes: number }`.
- Preserves: legacy `MAX_INPUT_BYTES` as the fallback for both dimensions.

- [ ] **Step 1: Write RED resolver and boundary tests**

Add bindings:

```ts
readonly MAX_RAW_BODY_BYTES?: string;
readonly MAX_NORMALIZED_INPUT_BYTES?: string;
```

Test precedence exactly:

```text
valid dedicated value > valid legacy MAX_INPUT_BYTES > 1_048_576
```

With raw limit above normalized limit, assert a compact JSON body passes body read
but its normalized CJK / opaque input receives 413. With normalized limit above raw
limit, assert a padded JSON body receives 413 before normalize. Cover Content-Length
present and absent at `limit - 1`, `limit`, and `limit + 1`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm test -w apps/gateway-worker -- test/proxy-failures.test.ts test/request-body.test.ts`

Expected: FAIL because one `MAX_INPUT_BYTES` value currently controls both boundaries.

- [ ] **Step 3: Implement independent resolution and preserve order**

Resolve limits once after authentication. Pass `rawBodyBytes` to `readJsonBody()`
and `normalizedInputBytes` to the endpoint normalizer. Preserve this order:

```text
raw limit -> JSON.parse -> normalize -> normalized limit -> model/policy/pool
```

Do not optimize chunk, decoded string, JSON object, normalized text, or token-array
lifetimes unless the recorded memory profile names that allocation as the peak.

- [ ] **Step 4: Set profiled values and rerun canary**

Add both decimal values from the recorded memory profile to `wrangler.jsonc`, then
run Task 4 at concurrency 1, 2, and expected peak. Verify the accepted 74,000-token
fixture stays below both limits.

- [ ] **Step 5: Run verification and prepare the commit boundary**

Run: `npm test -w apps/gateway-worker -- test/proxy-failures.test.ts test/request-body.test.ts test/proxy.test.ts`

Run: `npm run typecheck -w apps/gateway-worker`

Run only after an explicit user instruction to perform git operations:

```bash
git add apps/gateway-worker/src/index.ts \
  apps/gateway-worker/src/proxy.ts \
  apps/gateway-worker/test/proxy-failures.test.ts \
  apps/gateway-worker/wrangler.jsonc \
  docs/troubleshooting-503-worker-resource-limits.md
git commit -m "feat: raw入力と正規化入力の上限を分離"
```

### Task 8: Concurrency branch - tokenization lease state と stale-release protection を追加する

**Gate:** Execute only when the Concurrency gate is satisfied.

**Files:**
- Modify: `packages/shared/src/types.ts:52-55`
- Modify: `durable-objects/quota-controller/src/store.ts:4-118`
- Modify: `durable-objects/quota-controller/src/quota-controller.ts:178-198`
- Modify: `apps/gateway-worker/test/quota-controller.test.ts:177-217`

**Interfaces:**
- Produces: `TokenizationLease`, `AcquireTokenizationLeaseResult`, `ReleaseTokenizationLeaseResult`.
- Produces: `acquireTokenizationLease(requestId, limit, ttlMs)`.
- Produces: `releaseTokenizationLease(requestId, leaseId)`.

- [ ] **Step 1: Write RED Durable Object tests**

Define these shared types:

```ts
export interface TokenizationLease {
  readonly requestId: string;
  readonly leaseId: string;
  readonly expiresAt: number;
}

export type AcquireTokenizationLeaseResult =
  | { readonly ok: true; readonly lease: TokenizationLease }
  | { readonly ok: false; readonly reason: "tokenization_concurrency_exceeded" };

export type ReleaseTokenizationLeaseResult = {
  readonly ok: true;
  readonly released: boolean;
};
```

Test limit admission, same-request acquire before expiry, expiry cleanup, new lease ID
after expiry, matching release, stale release no-op, and unchanged quota counters.
Use fake system time or direct test-only DO storage setup; do not use sleeps.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -w apps/gateway-worker -- test/quota-controller.test.ts`

Expected: FAIL because tokenization lease types and RPC methods do not exist.

- [ ] **Step 3: Implement separate lease storage**

Store `readonly TokenizationLease[]` under:

```ts
export const TOKENIZATION_LEASES_KEY = "tokenization_leases";
```

In one `storage.transaction()`:

1. Remove entries where `expiresAt <= Date.now()`.
2. Return the saved unexpired lease for the same request ID.
3. Reject when the active count equals the limit.
4. Create a unique `crypto.randomUUID()` lease ID and `expiresAt = now + ttlMs`.

Release must compare both `requestId` and `leaseId` in the same transaction. A stale
release returns `{ ok: true, released: false }` and must not delete a newer lease.

- [ ] **Step 4: Validate RPC inputs**

Reject non-positive or unsafe `limit` / `ttlMs` with `TypeError` before storage access.
Do not read or write `POOL_KEY`, request entries, unresolved counters, or in-flight
upstream state from either tokenization RPC.

- [ ] **Step 5: Run tests and typechecks**

Run: `npm test -w apps/gateway-worker -- test/quota-controller.test.ts`

Run: `npm run typecheck -w packages/shared`

Run: `npm run typecheck -w durable-objects/quota-controller`

Expected: all commands exit 0.

- [ ] **Step 6: Prepare the commit boundary**

Run only after an explicit user instruction to perform git operations:

```bash
git add packages/shared/src/types.ts \
  durable-objects/quota-controller/src/store.ts \
  durable-objects/quota-controller/src/quota-controller.ts \
  apps/gateway-worker/test/quota-controller.test.ts
git commit -m "feat: tokenization admission leaseを追加"
```

### Task 9: Concurrency branch - BPE 前 admission と 429 契約を統合する

**Gate:** Execute after Task 8 and only with measured limit / TTL values.

**Files:**
- Modify: `packages/shared/src/errors.ts:100-110`
- Modify: `packages/shared/test/errors.test.ts`
- Modify: `apps/gateway-worker/src/index.ts:18-24`
- Modify: `apps/gateway-worker/src/proxy.ts:111-184`
- Modify: `apps/gateway-worker/test/proxy-failures.test.ts`
- Modify: `apps/gateway-worker/wrangler.jsonc`

**Interfaces:**
- Produces: `TokenizationAdmissionConfig` and `resolveTokenizationAdmission(env)`.
- Produces: `errTokenizationConcurrencyExceeded(requestId)`.
- Invariant: lease is released with the acquired lease ID before reserve and on every estimation failure.

- [ ] **Step 1: Write RED error and proxy integration tests**

Add the error helper contract:

```ts
errTokenizationConcurrencyExceeded(requestId)
// status: 429
// type: "rate_limit_error"
// code: "tokenization_concurrency_exceeded"
// route: "reject:tokenization_concurrency"
```

Add proxy tests for disabled config, successful acquire/release, saturation, and
estimation exception. Saturation and estimation failure must leave confirmed,
reserved, uncertain, and request count unchanged and must not call upstream.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -w packages/shared -- test/errors.test.ts`

Run: `npm test -w apps/gateway-worker -- test/proxy-failures.test.ts`

Expected: FAIL because the error and Worker integration do not exist.

- [ ] **Step 3: Resolve optional configuration atomically**

Add bindings:

```ts
readonly MAX_TOKENIZATION_REQUESTS?: string;
readonly TOKENIZATION_LEASE_TTL_MS?: string;
```

Return `undefined` unless both values are positive safe integers:

```ts
export interface TokenizationAdmissionConfig {
  readonly limit: number;
  readonly ttlMs: number;
}
```

There is no default-enabled admission mode.

- [ ] **Step 4: Integrate acquire and matching release**

Acquire after model / policy / pool resolution and before estimation. Wrap only the
estimation call in `try/finally`; release with `requestId` and the acquired
`leaseId` in `finally`, before quota reserve. This resolves the design document's
conflicting wording in favor of the stated purpose: the lease protects tokenization,
not Durable Object reserve latency.

Synchronous BPE has no yield point for heartbeat. Therefore the recorded
`TOKENIZATION_LEASE_TTL_MS` must exceed the maximum measured tokenize wall time for
the accepted largest payload. If the measurement violates that condition, do not
enable admission; return to Task 5 or adopt a separately designed yieldable tokenizer.

- [ ] **Step 5: Set measured values and rerun canary**

Add `MAX_TOKENIZATION_REQUESTS` and `TOKENIZATION_LEASE_TTL_MS` to `wrangler.jsonc`
using the values recorded by Task 4. Run the same payload at concurrency 1, 2, and
expected peak. Verify no active request expires before estimation completes.

- [ ] **Step 6: Run focused and full branch verification**

Run: `npm test -w packages/shared -- test/errors.test.ts`

Run: `npm test -w apps/gateway-worker -- test/quota-controller.test.ts test/proxy-failures.test.ts test/proxy.test.ts`

Run: `npm run typecheck`

Expected: all commands exit 0 and no changed TypeScript file has LSP diagnostics.

- [ ] **Step 7: Prepare the commit boundary**

Run only after an explicit user instruction to perform git operations:

```bash
git add packages/shared/src/errors.ts \
  packages/shared/test/errors.test.ts \
  apps/gateway-worker/src/index.ts \
  apps/gateway-worker/src/proxy.ts \
  apps/gateway-worker/test/proxy-failures.test.ts \
  apps/gateway-worker/wrangler.jsonc
git commit -m "feat: BPE前のtokenization admissionを追加"
```

### Task 10: Resolution canary と全体回帰を完了する

**Files:**
- Modify: `docs/troubleshooting-503-worker-resource-limits.md`
- No additional production files.

**Interfaces:**
- Produces: evidence-backed incident resolution record.

- [ ] **Step 1: Run all automated verification**

Run: `npm run typecheck`

Run: `npm test`

Expected: both commands exit 0.

- [ ] **Step 2: Run LSP diagnostics on every changed TypeScript file**

Resolve every error and warning introduced by the implementation. Do not suppress
diagnostics with TypeScript escape hatches.

- [ ] **Step 3: Exercise the live Worker surface**

Run the canary driver with the confirmed 74,000-token payload at concurrency 1, 2,
and expected peak. Also send one invalid payload shape, one raw hard-limit overflow,
and, when enabled, one admission saturation case.

Verify:

1. The accepted payload succeeds at expected peak concurrency.
2. No canary invocation has `exceededCpu` or `exceededMemory`.
3. CPU time, wall time, and memory profile remain inside recorded effective limits.
4. Every accepted payload fixture satisfies
   `estimatedInput + maxOutputTokens + margin >= usage.total_tokens`.
5. Every rejection has zero quota reserve and zero upstream calls.
6. Upstream success still settles actual usage.
7. Upstream uncertain outcomes still call `markUncertain`.
8. Known pre-upstream failures after reserve still release only known reservations.

- [ ] **Step 4: Record the resolution or keep the incident open**

Mark the incident resolved only when all eight checks pass for one documented
deployment revision and its effective limits. If any check fails or invocation
outcome is missing, record the failed condition and keep the incident open.

- [ ] **Step 5: Prepare the final documentation commit boundary**

Run only after an explicit user instruction to perform git operations:

```bash
git add docs/troubleshooting-503-worker-resource-limits.md
git commit -m "docs: Workerリソース障害の解決証跡を記録"
```
