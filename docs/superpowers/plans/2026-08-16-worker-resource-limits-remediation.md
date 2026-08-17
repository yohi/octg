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

export type ResourceStageRoute =
  | "free_shared"
  | "reject:request_too_large"
  | "reject:complimentary_quota"
  | "reject:model_not_allowed"
  | "reject:duplicate_idempotency_key"
  | "reject:worker_concurrency"
  | "reject:tokenization_concurrency"
  | "error:pre_upstream"
  | "error:upstream_uncertain";

export type ResourceStageOutcome =
  | "success"
  | "rejected"
  | "exception"
  | "uncertain";

type ResourceStageEventBase = {
  readonly event: "octg.resource_stage";
  readonly requestId: string;
  readonly revisionId: string;
  readonly stage: ResourceStage;
  readonly route?: ResourceStageRoute;
  readonly rawBodyBytes?: number;
  readonly rawBodyBytesSource?: "measured" | "declared_content_length" | "measured_partial";
  readonly rawBodyTruncated?: boolean;
  readonly inputBytes?: number;
  readonly inputTextBytes?: number;
  readonly opaqueInputBytes?: number;
  readonly estimationPath?: "exact_bpe" | "conservative_bytes";
  readonly concurrency?: number;
  readonly quotaReserved?: boolean;
  readonly upstreamReached?: boolean;
};

export type ResourceStageEvent =
  | (ResourceStageEventBase & {
      readonly phase: "start";
      readonly durationMs?: never;
      readonly outcome?: never;
    })
  | (ResourceStageEventBase & {
      readonly phase: "finish";
      readonly durationMs: number;
      readonly outcome: ResourceStageOutcome;
    });

export interface ReadJsonBodyMetrics {
  readonly rawBodyBytes: number;
  readonly rawBodyBytesSource: "measured" | "declared_content_length" | "measured_partial";
  readonly declaredContentLength: number | null;
  readonly measuredRawBodyBytes: number | null;
  readonly truncated: boolean;
  readonly bodyReadMs: number;
  readonly parseMs: number;
}
```

Assert that a valid JSON body returns its exact UTF-8 byte count and non-negative
durations with `rawBodyBytesSource: "measured"` and `truncated: false`. Test
`Content-Length` present and absent at `limit - 1`, `limit`, and `limit + 1`.
Also cover invalid JSON, a `Content-Length`-only early rejection, and a streamed
overflow. A declaration-only result must expose
`rawBodyBytesSource: "declared_content_length"`, a null measured count, and
`truncated: true`; an overflow must expose `rawBodyBytesSource: "measured_partial"`.
Only a measured, non-truncated value may be used as an exact profile measurement.

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
cancel the reader on stream overflow. Every return branch must populate the
provenance fields: declared `Content-Length` is not a measured body size, and a
partial stream is not an exact measurement. Do not let profile decisions treat
either branch as an exact `rawBodyBytes` value.

- [ ] **Step 5: Instrument the proxy at decision boundaries**

Emit start / finish events around normalize, tokenize, DO `getState`, reserve,
and upstream. Use the same `requestId` and `env.CF_VERSION_METADATA.id` on every
event. A finish event must always include `durationMs` and an `outcome` of
`success`, `rejected`, `exception`, or `uncertain`; start events must not invent a
finish outcome. Use a finally-equivalent wrapper so every emitted start has one
matching finish on normal return, intentional rejection, early return, and
exception. For streaming, finish only after flush/cancel/body-finalization has
settled, with the existing once-only guard. Log only byte counts, raw-byte
provenance/truncation, duration, the limited route union, estimation path, outcome,
and booleans. Never serialize an
exception object, error text, payload, header, or tokenizer input. Do not add event
emission inside shared pure functions or Durable Object storage helpers.

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
- Modify: `apps/gateway-worker/src/proxy.ts:41-259`
- Modify: `apps/gateway-worker/src/index.ts:31-52`
- Modify: `apps/gateway-worker/src/reconcile.ts:43-68`
- Modify: `durable-objects/quota-controller/src/quota-controller.ts:200-212`
- Modify: `durable-objects/quota-controller/src/quota-lifecycle.ts:34-255`
- Modify: `packages/shared/src/types.ts:56-64`
- Modify: `apps/gateway-worker/test/proxy-failures.test.ts:49-238`
- Modify: `apps/gateway-worker/test/reconcile.test.ts`
- Modify: `apps/gateway-worker/test/quota-lifecycle.test.ts`

**Interfaces:**
- Produces: `startRequestAuditBestEffort(...): Promise<boolean>`.
- Produces: `completeRequestAuditBestEffort(...): Promise<void>`.
- Produces: `reserveFailClosed(...): Promise<ResolvedReserve | UnknownReserve>`.
- Produces: a Durable Object reconciliation snapshot that includes all non-terminal
  `reserved` entries and `uncertain` entries with an explicit uncertainty origin.
- Produces: an explicit DO-side transition that makes an unresolved reserved entry
  eligible for `reconcileRequest` without calling `release`.
- Invariant: unknown reserve outcome never triggers quota release and never reaches
  upstream; if a reservation was committed before the transport failure, the entry
  and its tokens remain discoverable from the Durable Object until reconciliation.

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
6. Registry, policy, quota `getState()`, and in-flight lease failures are each
   converted to a 500 with the request ID generated for that invocation; intentional
   4xx responses remain unchanged.
7. A committed reservation whose reserve response is lost appears in the DO
   reconciliation snapshot and can be dispositioned without using D1 as the source
   of quota state.

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

- [ ] **Step 5: Make unknown reserve entries durable and reconcilable**

When both reserve attempts are unknown, return the original request ID with HTTP
500, do not call `release()`, and do not call upstream. Add a DO-only snapshot that
scans request entries and reports every non-terminal `reserved` entry with its
`requestId`, `reservedTokens`, state, and creation time, plus the uncertainty origin
for entries already moved to `uncertain`. D1 may correlate audit and telemetry
evidence, but it is not authoritative for whether the reservation exists.

The DO must provide an atomic, idempotent transition such as
`markReserveOutcomeUnknown(requestId)` that verifies `state: "reserved"`, moves the
entry to `state: "uncertain"` with an explicit `uncertaintyOrigin:
"reserve_unknown"`, updates the reserved/uncertain unresolved counts, and leaves
the total token accounting unchanged. The existing
`reconcileRequest(requestId, disposition)` path must then accept this origin (or an
equivalent typed disposition) and apply `consumed` / `unused` inside the DO
transaction. Never use the ordinary `release` RPC for this case. `unused` is
permitted only after explicit operator or request-level evidence that no upstream
consumption occurred; absent such evidence, leave the entry pending and do not
apply `unused`. If a terminal fail-closed decision is required, apply `consumed`,
not `unused`. A missing entry is an idempotent no-op, and a retry must not alter
quota counters twice. `runReconciliation` must not infer a disposition for these
entries from an aggregate Usage API difference alone.

Extend the request-entry and reconciliation snapshot types so the origin is
persisted and returned as a bounded value, for example
`"upstream_uncertain" | "reserve_unknown"`; do not encode the origin in a free-form
error string. The operator/reconciliation path must select the request from the DO
snapshot, perform the origin transition in the DO, and then call
`reconcileRequest` against that same DO instance.

Add tests for snapshot discovery, the reserved-to-`uncertain` transition and
origin marker, positive-evidence-only unused disposition, explicit consumed
fallback, retry idempotency, and finalization after the DO entry is resolved. Preserve the
invariant that the unknown reserve response path itself never releases or reaches
upstream.

- [ ] **Step 6: Add the proxy error boundary before upstream**

Keep one request-scoped `requestId` in scope from `index.ts` through `handleProxy`
(either pass it into `handleProxy` or centralize the boundary there). Wrap every
exception-prone pre-upstream await and decision, including authentication/body
read, registry, policy, quota `getState()`, tokenization admission, estimation,
margin, upper-bound, output decision, reserve, and in-flight lease acquisition or
release. Convert unexpected failures to `errInternal(requestId)`, while keeping
intentional 4xx/429 responses unchanged. Attempt audit completion through the
best-effort wrapper. Release only a reservation whose success is known and whose
failure is known to be before upstream; never release an unknown reserve outcome.
The top-level `index.ts` catch must reuse this original ID instead of generating a
second UUID for the 500 response.

- [ ] **Step 7: Run focused and full workspace verification**

Run: `npm test -w apps/gateway-worker -- test/quota-reservation.test.ts test/proxy-failures.test.ts test/proxy.test.ts`

Run: `npm run typecheck -w apps/gateway-worker`

Run: `npm run typecheck -w packages/shared`

Run: `npm run typecheck -w durable-objects/quota-controller`

Expected: all commands exit 0.

- [ ] **Step 8: Prepare the commit boundary**

Run only after an explicit user instruction to perform git operations:

```bash
git add apps/gateway-worker/src/db.ts \
  apps/gateway-worker/src/quota-reservation.ts \
  apps/gateway-worker/src/proxy.ts \
  apps/gateway-worker/src/index.ts \
  apps/gateway-worker/src/reconcile.ts \
  durable-objects/quota-controller/src/quota-controller.ts \
  durable-objects/quota-controller/src/quota-lifecycle.ts \
  packages/shared/src/types.ts \
  apps/gateway-worker/test/quota-reservation.test.ts \
  apps/gateway-worker/test/proxy-failures.test.ts \
  apps/gateway-worker/test/reconcile.test.ts \
  apps/gateway-worker/test/quota-lifecycle.test.ts
git commit -m "fix: reserve前例外をfail-closedで処理"
```

### Task 4: Canary driver を作り原因 branch を確定する

**Files:**
- Create: `scripts/canary-worker-resource-limits.mjs`
- Modify: `docs/troubleshooting-503-worker-resource-limits.md`

**Interfaces:**
- Consumes: `OCTG_CANARY_URL`, `OCTG_CANARY_ALLOWED_HOSTS`,
  `OCTG_CANARY_CLIENT_KEY`, `CANARY_PAYLOAD_PATH`, `CANARY_CONCURRENCY`, and
  `CANARY_REQUEST_TIMEOUT_MS`.
- Operator-only input: `EXPECTED_PEAK_CONCURRENCY` is a positive safe integer
  used to construct the `CANARY_CONCURRENCY` value in the shell example; the
  script receives only the resulting comma-separated list.
- Produces: payload を含まない JSON Lines with outcome, status, duration, request
  ID, and concurrency; timeout and fetch failures produce one result line each.

- [ ] **Step 1: Implement argument and secret boundaries**

The script must read the request body from `CANARY_PAYLOAD_PATH`, the key only from
`OCTG_CANARY_CLIENT_KEY`, and concurrency from a comma-separated positive integer
list. `OCTG_CANARY_ALLOWED_HOSTS` is a required comma-separated list of exact host
names; wildcards are not accepted. `CANARY_REQUEST_TIMEOUT_MS` is a required
positive safe integer. The script must never print the key, headers, payload, URL,
or exception text.

Implement the driver with this control flow:

Place all setup and loop statements below inside `async function main()`. Invoke
`main()` from a top-level `try/catch` that prints only
`octg.canary.config_error` and sets a non-zero exit status; the catch must not
include the exception, URL, path, key, headers, or payload.

```js
import { readFile } from "node:fs/promises";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new TypeError(`${name} is required`);
  return value;
};

let url;
try {
  url = new URL(required("OCTG_CANARY_URL"));
} catch {
  throw new TypeError("OCTG_CANARY_URL must be a valid URL");
}
const allowedHosts = new Set(
  required("OCTG_CANARY_ALLOWED_HOSTS")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
);
if (
  url.protocol !== "https:" ||
  url.username !== "" ||
  url.password !== "" ||
  allowedHosts.size === 0 ||
  !allowedHosts.has(url.hostname.toLowerCase())
) {
  throw new TypeError("OCTG_CANARY_URL must use an allowed HTTPS host");
}
const apiKey = required("OCTG_CANARY_CLIENT_KEY");
let payload;
try {
  payload = await readFile(required("CANARY_PAYLOAD_PATH"), "utf8");
  JSON.parse(payload);
} catch {
  throw new TypeError("CANARY_PAYLOAD_PATH must contain readable valid JSON");
}
const concurrencies = required("CANARY_CONCURRENCY")
  .split(",")
  .map((value) => Number(value));
if (concurrencies.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
  throw new TypeError("CANARY_CONCURRENCY must contain positive safe integers");
}
const requestTimeoutMs = Number(required("CANARY_REQUEST_TIMEOUT_MS"));
if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
  throw new TypeError("CANARY_REQUEST_TIMEOUT_MS must be a positive safe integer");
}

for (const concurrency of concurrencies) {
  const results = await Promise.all(
    Array.from({ length: concurrency }, async (_, ordinal) => {
      const startedAt = performance.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: payload,
          signal: controller.signal,
          redirect: "error",
        });
        return {
          event: "octg.canary.result",
          concurrency,
          ordinal,
          outcome: "response",
          status: response.status,
          durationMs: performance.now() - startedAt,
          requestId: response.headers.get("X-OCTG-Request-Id"),
        };
      } catch (error) {
        const outcome = error instanceof DOMException && error.name === "AbortError"
          ? "timeout"
          : "fetch_error";
        return {
          event: "octg.canary.result",
          concurrency,
          ordinal,
          outcome,
          status: null,
          durationMs: performance.now() - startedAt,
          requestId: null,
        };
      } finally {
        clearTimeout(timeout);
      }
    }),
  );
  for (const result of results) console.log(JSON.stringify(result));
}
```

Output one line per request in this shape:

```js
{
  event: "octg.canary.result",
  concurrency,
  ordinal,
  outcome: "response" | "timeout" | "fetch_error",
  status: number | null,
  durationMs,
  requestId: string | null,
}
```

Each fetch has its own deadline and `AbortController`. Catch failures inside the
individual request task so `Promise.all` resolves with one result per request and
the outer loop always advances to the next concurrency level. A timeout must be
represented as `outcome: "timeout"`, never as a missing line or an unhandled
rejection. Wrap startup configuration, file-read, and JSON validation in a
top-level error boundary that sets a non-zero exit status and emits only a fixed
safe configuration-error marker; never print the caught exception, path, URL, key,
headers, or payload. Fetch failures remain per-request result lines as above.

- [ ] **Step 2: Exercise bad-input paths locally**

Run with an unreadable `CANARY_PAYLOAD_PATH` and verify a non-zero exit code without
printing `OCTG_CANARY_CLIENT_KEY`. Also exercise an invalid URL, a non-HTTPS URL,
and a host outside `OCTG_CANARY_ALLOWED_HOSTS`; verify that no fetch is issued and
no bearer header is constructed for any rejected URL.

- [ ] **Step 3: Run the 74,000-token canary at all required concurrency levels**

Run:

```bash
OCTG_CANARY_URL="$OCTG_CANARY_URL" \
OCTG_CANARY_ALLOWED_HOSTS="$OCTG_CANARY_ALLOWED_HOSTS" \
OCTG_CANARY_CLIENT_KEY="$OCTG_CANARY_CLIENT_KEY" \
CANARY_PAYLOAD_PATH="$CANARY_PAYLOAD_PATH" \
CANARY_CONCURRENCY="1,2,$EXPECTED_PEAK_CONCURRENCY" \
CANARY_REQUEST_TIMEOUT_MS="$CANARY_REQUEST_TIMEOUT_MS" \
node scripts/canary-worker-resource-limits.mjs
```

Correlate each `X-OCTG-Request-Id` with version ID, `$workers.outcome`,
`$workers.cpuTimeMs`, `$workers.wallTimeMs`, custom stage events, and trace spans.
Include timeout and fetch-error result lines in the evidence; a failed request must
not prevent the next concurrency level from running.

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
`inputBytes = 120_000`; assert opaque bytes are added exactly once. Mock an
encoding lookup/encode failure and assert that it returns `path:
"conservative_bytes"` with `inputTextBytes` as the text base and the same
opaque-byte and message overhead as the exact path.

- [ ] **Step 2: Run shared tests and verify RED**

Run: `npm test -w packages/shared -- test/estimate.test.ts`

Expected: FAIL because the current API always attempts exact BPE and returns only a number.

- [ ] **Step 3: Implement the minimal estimator**

Use `inputBytes` only for cutoff selection. Use `inputTextBytes` as the text base
on the conservative path:

```ts
const useExact = args.bpeMaxInputBytes === undefined ||
  args.inputBytes < args.bpeMaxInputBytes;
let base: number;
let path: InputEstimationPath;
if (!useExact) {
  base = args.inputTextBytes;
  path = "conservative_bytes";
} else {
  try {
    base = exactBpeTokens(args.inputText);
    path = "exact_bpe";
  } catch {
    base = args.inputTextBytes;
    path = "conservative_bytes";
  }
}
return {
  path,
  tokens: base + args.opaqueInputBytes + 4 * args.messageCount + 3,
};
```

`exactBpeTokens()` includes both encoding lookup and encoding. If either operation
throws, catch it at this boundary, use the already measured `inputTextBytes`, and
return `conservative_bytes`; never drop or double-count
`opaqueInputBytes + 4 * messageCount + 3`.

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
3. Reject when the active count is greater than or equal to the limit (`active.size >= limit`).
4. Create a unique `crypto.randomUUID()` lease ID and `expiresAt = now + ttlMs`.

Persist the expiry-cleaned list before returning a rejection or creating a new
lease. The same-request lookup must happen after cleanup and before the limit
check, so an unexpired idempotent acquire succeeds even when the configured limit
is already full. Never use an equals-only check; a stale or previously corrupted
active list must not admit another lease above the limit.

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
5. Every rejection before quota reservation has zero quota reserve and zero upstream
   calls.
6. A known pre-upstream failure after a successful reservation releases exactly the
   known reservation; an unknown reserve outcome never calls `release`.
7. Upstream success still settles actual usage.
8. Upstream uncertain outcomes still call `markUncertain` and remain for
   reconciliation; they are not required to have zero reserve.
9. Both unknown reserve attempts return the original request ID, make zero upstream
   calls, leave the immediate path without `release`, and leave any committed DO
   entry discoverable for an explicit DO reconciliation disposition. D1 is used only
   as audit evidence, never as the authoritative quota state.

- [ ] **Step 4: Record the resolution or keep the incident open**

Mark the incident resolved only when all nine checks pass for one documented
deployment revision and its effective limits. If any check fails or invocation
outcome is missing, record the failed condition and keep the incident open.

- [ ] **Step 5: Prepare the final documentation commit boundary**

Run only after an explicit user instruction to perform git operations:

```bash
git add docs/troubleshooting-503-worker-resource-limits.md
git commit -m "docs: Workerリソース障害の解決証跡を記録"
```
