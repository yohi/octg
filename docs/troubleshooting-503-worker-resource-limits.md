<!-- markdownlint-disable MD013 MD032 -->

# OCTG 503 / Cloudflare Error 1102 調査記録

## インシデント事実

2026-08-16 02:16:29〜02:16:47 JST に、Cloudflare AI Gateway の Custom
Provider 経由で OCTG Worker へ `/v1/responses` を送ったところ、同じ大規模入力に
対して 200 と 503 が混在しました。

| 時刻 (JST) | Status | Model | Duration | 記録上の tokens (in/out) |
| --- | ---: | --- | ---: | ---: |
| 02:16:29 | 200 | `gpt-5.6-luna` | 4.85 s | 74,223 / 116 |
| 02:16:34 | 200 | `gpt-5.6-luna` | 3.64 s | 74,383 / 74 |
| 02:16:38 | 200 | `gpt-5.6-luna` | 3.79 s | 74,504 / 73 |
| 02:16:40 | 503 | `gpt-5.6-luna` | 0.30 s | 0 / 0 |
| 02:16:42 | 503 | `gpt-5.6-luna` | 0.10 s | 0 / 0 |
| 02:16:47 | 503 | `gpt-5.6-luna` | 0.10 s | 0 / 0 |

503 の応答は OCTG の通常の OpenAI 互換エラーではなく、Cloudflare の
`Worker exceeded resource limits`（Error 1102）HTML でした。1102 はリソース制限に
達したことを示しますが、CPU と memory のどちらが原因か、この記録だけでは確定
できません。入力本文、認証素材、tokenizer 対象文字列はログへ保存しません。

今回のリクエストでは、正常完了した約 74,000-token 級の payload を安全性が確認できる
限り受理すること、未検証の比率式を request 全体の token 上限にしないことを維持します。

## 未確定事項

以下は障害時の同一 revision と request ID に紐付く証跡が得られるまで未確定です。

| 項目 | 状態 | 確認方法 |
| --- | --- | --- |
| Worker deployment / version ID | 未取得 | `CF_VERSION_METADATA.id` と Workers invocation telemetry を照合 |
| commit SHA | 未取得 | deployment の version metadata と照合 |
| 実効 `limits.cpu_ms` | 未取得 | 障害時 deployment の設定と account の有効 limit を確認 |
| 実効 memory limit | 未取得 | 対象 deployment と memory profiling を確認 |
| invocation outcome | 未取得 | `$workers.outcome` の `exceededCpu` / `exceededMemory` |
| CPU / wall time | 未取得 | `$workers.cpuTimeMs` / `$workers.wallTimeMs` と trace spans |
| 障害時の concurrency | 未取得 | 同一 revision の request ID 群を時系列で照合 |
| reserve 到達 | 未取得 | OCTG の安全な `quota_reserve` stage event |
| upstream 到達 | 未取得 | OCTG event と upstream fetch span |

Workers のプラン既定値や旧 Bundled usage model の値から、障害時 deployment の実効
CPU / memory limit を推定しません。

## 現行実装と処理順序

Baseline 適用後の観測可能な処理順序は次のとおりです。

```text
authentication
  -> raw body read / JSON parse
  -> endpoint normalization / normalized input byte check
  -> model registry / policy / quota getState
  -> TokenizerController RPC (tokenizer:primary, exact o200k_base BPE)
  -> input estimation / margin / upper bound / output decision
  -> quota reserve
  -> in-flight admission
  -> upstream fetch
  -> settle, markUncertain, or known pre-upstream release
```

TokenizerController RPC は 1 request につき 1 回だけ実行します。outcome ごとの契約は次のとおりです。

- `work_limit` は HTTP `413`、`request_too_large`、route `reject:request_too_large` です。
- RPC failure、malformed result、RPC preflight ceiling 超過、Tokenizer RPC 境界の
  `MAX_INPUT_TEXT_BYTES` 超過は unavailable として HTTP `500 internal_error`、route
  `error:internal_error` になります。
- Worker の HTTP 正規化で解決済み入力上限を超過した場合は RPC より前に HTTP `413`
  `request_too_large`、route `reject:request_too_large` になります。
- token budget の算術異常は HTTP `500 internal_error` です。公開 HTTP route は
  `error:internal_error`、resource stage event の route は `error:arithmetic_error` です。

上記の全ケースで未検証の推定値を使わず、`quota_reserve`、in-flight admission、upstream fetch
は実行しません。障害時は response の HTTP status / `error.code` / `X-OCTG-Route` と、同じ
request ID の `octg.resource_stage` event を照合してください。exact BPE は Gateway Worker や
shared package では実行せず、`TokenizerController` の RPC 境界に隔離します。

TokenizerController の estimate は次の境界を使用します。

```text
base = o200k_base.encode(inputText).length
estimatedInputTokens = base + opaqueInputBytes + (messageCount * 4) + 3
```

TokenizerController は RPC 専用であり、`ctx.storage` を呼び出しません。入力本文、API key、
tokenizer state を Durable Object storage や stage event に保存しないことを確認します。

`readJsonBody()` の raw body 上限は JSON parse より前に適用されます。正規化処理は
`inputTextBytes`、`opaqueInputBytes`、`inputBytes` を分離して返します。Responses では
`normalize.ts` が既に次の invariant を維持しています。

```text
inputBytes = inputTextBytes + opaqueInputBytes
```

したがって、`NormalizedRequest.inputTextBytes` が欠落しているという前提は誤りです。
`inputBytes` を text bytes として再利用して opaque bytes を二重加算しないことが必要です。

Workers の invocation telemetry が `$workers.outcome`、`$workers.cpuTimeMs`、
`$workers.wallTimeMs` を提供します。OCTG の custom `octg.resource_stage` event は、
アプリケーション上の stage、request ID、revision、safe な byte 数・duration・boolean
metadata だけを提供し、Workers の outcome や実メモリ使用量を代替しません。

AI Gateway へ送る `cf-aig-collect-log-payload` は `false` とし、payload collection を
無効化します。D1 は監査・証跡用途だけであり、quota の authoritative state は
Durable Object に置きます。

Worker から Gateway B への outbound は `cf-aig-max-attempts: 1` とし、retry-delay / backoff を
設定しません。隠れた再試行で usage が二重計上されないようにし、upstream 通信失敗・usage
取得不能・クライアント切断は `markUncertain` へ倒します。`Idempotency-Key` は空文字・未指定を
absent、指定値を UTF-8 255 bytes 以下として client × pool × UTC day 単位で重複排除します。

## 観測ゲート

同じ request ID と deployment revision について、次の証跡が揃った場合だけ原因別 branch
を有効化します。

| Gate | 必須証跡 | 許可する対策 |
| --- | --- | --- |
| Baseline | revision、request ID、safe stage event、Workers logs / traces の相関 | Tasks 1〜4 |
| CPU | `exceededCpu` かつ tokenize が主要 CPU 区間 | BPE cutoff branch |
| Memory | `exceededMemory` かつ peak allocation が特定済み | raw / normalized limit 分離 |
| Concurrency | concurrency 1 は成功し、2 または想定ピークだけ BPE 同時進入で失敗 | tokenization lease |
| Resolution | 適用 branch の canary と payload differential が全条件を通過 | 解決判定 |

観測前に `BPE_MAX_INPUT_BYTES`、`MAX_RAW_BODY_BYTES`、`MAX_NORMALIZED_INPUT_BYTES`、
`MAX_TOKENIZATION_REQUESTS`、`TOKENIZATION_LEASE_TTL_MS` を `wrangler.jsonc` に追加
しません。確認できなかった branch は実装・設定変更の対象外です。

## 原因別対策

### Baseline（必須）

- Workers Logs、traces、version metadata を有効にし、revision と request ID を相関する。
- stage event は payload、headers、API key、例外文字列を含めず、限定された primitive field
  だけを出力する。
- body read / parse の raw byte provenance と duration を記録する。宣言された
  `Content-Length` と streamed partial bytes は exact measurement と扱わない。
- D1 insert / completion の失敗は quota decision や upstream 到達条件へ伝播させない。
- reserve の結果が不明な場合は fail-closed にし、release や upstream 到達を行わず、DO の
  reconciliation 対象として保持する。
- upstream には payload collection 無効化 header を送る。
- `TokenizerController` の success stage と quota reserve stage を request ID で相関する。
- Tokenizer stage event は request ID、revision、stage、duration、safe な byte/token 数、
  allowlist 済み outcome だけを記録し、入力本文、Authorization、API key、例外文字列を記録しない。

### CPU branch（Gate 通過時だけ）

`inputBytes` が cutoff 未満のときだけ exact BPE を実行し、cutoff 以上では検証済みの
conservative bytes 経路へ切り替えます。conservative path は `inputTextBytes` を base とし、
`opaqueInputBytes` と message overhead を一度だけ加算します。cutoff は canary revision の
profiling から決め、未検証の byte 比率式を使用しません。

### Memory branch（Gate 通過時だけ）

memory profile が特定した allocation に対応する範囲で、raw body hard limit と normalized
input hard limit を分離します。`Content-Length` のみで拒否した値や streamed overflow の
partial 値を exact profile measurement に使いません。

### Concurrency branch（Gate 通過時だけ）

BPE 前に quota state と独立した期限付き tokenization lease を取得します。admission saturation
は HTTP 429 `rate_limit_error`、code `tokenization_concurrency_exceeded`、route
`reject:tokenization_concurrency` とします。lease の期限・limit は最大 tokenize wall time
の実測値を超えることを確認できた場合だけ有効化します。既存の upstream in-flight lease と
settle / markUncertain / release 契約は変更しません。

## Canary 手順

`scripts/canary-worker-resource-limits.mjs` は、`CANARY_PAYLOAD_PATH` の JSON payload を
concurrency `1`、`2`、および operator が指定した想定ピークで送ります。入力は payload を
出力せず、結果 JSON Lines に outcome、status、duration、request ID、concurrency を記録します。
`fetch_error` の `errorName` / `errorCode` は allowlist 済みの値だけを記録し、timeout では両値を
`null` にします。

必要な環境変数は次のとおりです。

```text
OCTG_CANARY_URL
OCTG_CANARY_ALLOWED_HOSTS
OCTG_CANARY_CLIENT_KEY
CANARY_PAYLOAD_PATH
CANARY_CONCURRENCY
CANARY_REQUEST_TIMEOUT_MS
```

URL は HTTPS かつ exact allow-list host でなければならず、redirect は拒否します。設定
エラーは固定 marker だけを出力し、key、URL、path、headers、payload、例外文字列を出力
しません。各 request は独自の AbortController と timeout を持ち、timeout / fetch failure
も 1 request 1 line として次の concurrency level へ進みます。

canary の各 request ID を version ID、`$workers.outcome`、`$workers.cpuTimeMs`、
`$workers.wallTimeMs`、custom stage events、trace spans と相関し、74,000-token 級 payload
について reserve の有無と upstream 到達を記録します。production credentials がない場合は
driver の設定境界だけをローカルで検証し、原因別 branch を有効化しません。

現時点の branch decision は次のとおりです。production の canary 証跡が未取得のため、
CPU・memory・concurrency の設定値は追加していません。

| revision | request ID | CPU limit / memory limit | raw / normalized bytes | stage / outcome / concurrency | reserve / upstream | branch |
| --- | --- | --- | --- | --- | --- | --- |
| 未取得 | 未取得 | 未取得 / 未取得 | 未取得 / 未取得 | 未取得 / 未取得 / 未取得 | 未取得 / 未取得 | CPU・memory・concurrency 未適用 |

TokenizerController migration の確認も branch decision の前提です。`apps/gateway-worker/wrangler.jsonc`
の `TOKENIZER_CONTROLLER` binding と migration `v2` を削除・改名・再利用せず、rollback でも
manifest を維持します。Free Plan の CPU 上限を理由に、production 証跡なしで arbitrary cutoff、
未検証の byte 比率式、tokenization lease、paid fallback を追加しません。

operator が想定ピークを正の safe integer として決めた場合の実行例は次のとおりです。

```bash
CANARY_CONCURRENCY="1,2,$EXPECTED_PEAK_CONCURRENCY" \
node scripts/canary-worker-resource-limits.mjs
```

## 解決判定

一つの documented deployment revision とその実効 limits について、次の全条件を満たした
場合だけインシデントを resolved とします。

1. 74,000-token 級の accepted payload が concurrency 1、2、想定ピークで成功する。
2. canary invocation に `exceededCpu` / `exceededMemory` がない。
3. CPU time、wall time、memory profile が実効 limits 内にある。
4. accepted fixture ごとに `estimatedInput + maxOutputTokens + margin >= usage.total_tokens`
   が成立する。
5. reserve 前の rejection は quota reserve と upstream call がゼロである。
6. known pre-upstream failure は既知の成功 reservation だけを一度 release し、unknown reserve
   outcome は release しない。
7. upstream success は actual usage で settle する。
8. upstream uncertain は `markUncertain` され、reconciliation 対象として残る。
9. unknown reserve の二回の試行が失敗した場合、元の request ID を返し、upstream と release
   を呼ばず、DO の entry を reconciliation から発見できる。

いずれかの条件、invocation outcome、revision、または実効 limit が欠ける場合は、解決済み
とせず、欠けた証跡と failed condition をこの記録へ追記して incident を open のまま維持
します。
