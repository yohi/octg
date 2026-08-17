# Tokenizer Durable Object 導入設計

- **作成日:** 2026-08-17
- **対象:** OCTG Gateway Worker からの exact BPE tokenization 分離
- **基礎要件:** `REQUIREMENTS_2026-08-17.md`

## 1. 目的

約 74,000 token 級のリクエストで Gateway Worker の tokenization が
CPU 制限を超過する問題を解消する。`js-tiktoken` による CPU-intensive な処理を
専用の SQLite-backed Durable Object へ移し、既存の quota admission control と
外部 API 契約を維持する。

本設計は次を同時に保証する。

1. Workers Free Plan を維持する。
2. Tokenizer 成功後にのみ quota reservation を行う。
3. Reservation、Settlement、Fail-Closed、No Paid Fallback の契約を変更しない。
4. 正常系では現行の `o200k_base` token estimation と同じ結果を返す。
5. Tokenizer 障害時は予約せず、upstream に到達しない。
6. Gateway Worker の production path から exact BPE 実行を除去する。
7. prompt、入力本文、認証情報を保存またはログ出力しない。

## 2. 採用アプローチ

独立した `@octg/tokenizer-controller` workspace を追加する。Tokenizer の
RPC 契約、runtime validation、BPE、保守的 fallback、内部観測を同 package が
所有する。

```text
@octg/tokenizer-controller
  ├─ TokenizerController
  ├─ TokenizeRequest / TokenizeResult
  ├─ request runtime validation
  ├─ o200k_base lazy initialization
  ├─ exact BPE / conservative byte fallback
  └─ octg.tokenizer_stage observability

gateway-worker
  ├─ tokenizer:primary の解決
  ├─ 単発 RPC
  ├─ response runtime validation
  ├─ 503 fail-closed
  └─ tokenize resource stage

@octg/shared
  └─ safety margin / upper bound / output decision
```

Tokenizer package は `@octg/shared` に依存しない。依存は `js-tiktoken` と
Cloudflare Workers 型に限定する。Gateway Worker は
`@octg/tokenizer-controller` を型と Durable Object export のために参照するが、
BPE を直接呼び出さない。

## 3. リクエストフロー

処理順序を次で固定する。

```text
authenticate
→ body_read
→ parse
→ normalize
→ model classification / policy
→ quota_get_state
→ TokenizerController RPC
→ safety margin / upper bound / output decision
→ quota_reserve
→ in-flight admission
→ upstream
→ settle / markUncertain / release
```

Tokenizer RPC は `quota_reserve` より前、既存の input size validation と
normalize より後に実行する。Tokenizer が成功しなければ後続処理へ進まない。

Tokenizer 成功後の QuotaController lifecycle は変更しない。

## 4. コンポーネント境界

### 4.1 TokenizerController

`TokenizerController` は compute-only Durable Object とする。

責務:

- RPC request の runtime validation
- `o200k_base` encoding の lazy initialization と再利用
- exact BPE tokenization
- 捕捉可能な BPE 例外時の conservative byte fallback
- token estimation 結果の安全な算術検証
- Tokenizer 内部 stage の構造化ログ

禁止事項:

- QuotaController の呼び出し
- Durable Object Storage または D1 への application data 保存
- tokenizer result cache
- prompt、入力本文、token 配列、API key のログ出力
- 外部 HTTP endpoint の公開

### 4.2 Gateway tokenizer client

`apps/gateway-worker/src/tokenizer.ts` に次を集約する。

- logical object ID `tokenizer:primary` の解決
- Durable Object stub の取得
- 1 リクエストにつき最大 1 回の RPC
- RPC 例外の fail-closed outcome への変換
- RPC response の runtime validation

戻り値は判別 union とする。

```ts
type TokenizerOutcome =
  | { readonly kind: "resolved"; readonly result: TokenizeResult }
  | { readonly kind: "unavailable" };
```

`proxy.ts` は Tokenizer client の内部例外を扱わず、outcome に応じて quota 計算または 503 応答へ分岐する。

### 4.3 Shared package

`packages/shared/src/estimate.ts` は維持し、次だけを所有する。

- `safetyMargin()`
- `upperBoundOf()`
- `decideOutput()`

`estimateInputTokens()`、encoding cache、`js-tiktoken` import は削除する。
`packages/shared/src/index.ts` から旧関数の export を除去し、
`packages/shared/package.json` から `js-tiktoken` を削除する。

## 5. RPC 契約

### 5.1 Request

```ts
interface TokenizeRequest {
  requestId: string;
  inputText: string;
  messageCount: number;
  opaqueInputBytes: number;
}
```

RPC request に quota、policy、client ID、API key、revision ID を含めない。

DO の public method 入口で次を検証する。

- `requestId`: 空でない文字列
- `inputText`: 文字列
- `messageCount`: 非負の safe integer
- `opaqueInputBytes`: 非負の safe integer

契約違反は補正、丸め、既定値代入をせず RPC failure とする。
request validation failure は conservative fallback の対象にしない。

### 5.2 Result

```ts
interface TokenizeResult {
  estimatedInputTokens: number;
  estimationPath: "exact_bpe" | "conservative_bytes";
}
```

Gateway は response を独立に runtime validation する。

- `estimatedInputTokens` は `0` 以上の safe integer
- `estimationPath` は定義済みの 2 値のみ
- 欠落、NaN、Infinity、負数、小数、unsafe integer は不正

不正 response は `unavailable` とし、予約と upstream を実行しない。

## 6. Token estimation semantics

### 6.1 Exact BPE

正常系は現行実装と同じ式を使用する。

```text
base = o200k_base.encode(inputText).length
estimated = base + opaqueInputBytes + 4 * messageCount + 3
```

encoding は Durable Object instance field に保持する。初回、eviction 後、
前回の初期化失敗後にのみ `getEncoding("o200k_base")` を実行する。

### 6.2 Conservative fallback

`getEncoding()` または `encode()` が DO 内で捕捉可能な通常の JavaScript 例外を投げた場合だけ、当該リクエストを次で計算する。

```text
base = UTF-8 byte length(inputText)
estimated = base + opaqueInputBytes + 4 * messageCount + 3
```

fallback result は成功結果として返し、Gateway は通常どおり safety margin、
upper bound、output decision、reservation を計算する。過大推定による 413 または
429 は安全側の結果として許容する。

初期化失敗は instance に記憶しない。次のリクエストで exact BPE 初期化を再試行する。

### 6.3 Safe integer

DO は token estimation の加算結果が非負の safe integer であることを確認する。
Gateway はさらに margin、upper bound、reservation の各算術結果を検証する。

算術結果が不正な場合は値を clamp せず、Tokenizer unavailable として fail-closed にする。

## 7. Object identity と実行制御

MVP は全 tokenization request に固定 ID `tokenizer:primary` を使用する。
ID 解決は Gateway tokenizer client の 1 か所に置く。

sharding、result cache、prompt hash cache は実装しない。

Gateway は Tokenizer RPC を再試行しない。独自の wall-clock timeout も設けない。
Cloudflare の Durable Object 既定 CPU 上限と overload / queue 制御に従い、
発生した例外を 503 へ変換する。

## 8. Fail-Closed とエラー契約

次を Tokenizer unavailable として扱う。

- RPC rejection または network failure
- Durable Object CPU 超過
- overload または queue failure
- Durable Object unavailable
- request contract 違反による remote exception
- malformed result
- token 数または quota 算術の不正値と overflow

Gateway 内での BPE fallback、byte fallback、upstream fallback、RPC retry は禁止する。

### 8.1 HTTP response

```json
{
  "error": {
    "message": "Token estimation service unavailable.",
    "type": "server_error",
    "param": null,
    "code": "tokenizer_unavailable"
  },
  "request_id": "req_..."
}
```

- HTTP status: `503 Service Unavailable`
- route: `error:tokenizer_unavailable`
- `Retry-After`: 付与しない

`quota_get_state` で取得済みの snapshot から次の header を付与する。

- `X-OCTG-Request-Id`
- `X-OCTG-Pool`
- `X-OCTG-Quota-Limit`
- `X-OCTG-Quota-Used`
- `X-OCTG-Quota-Remaining`
- `X-OCTG-Quota-Reset`
- `X-OCTG-Route`

Tokenizer unavailable 分岐は `quota_reserve` の前に return する。したがって
reservation の release や `markUncertain()` は不要であり、次を保証する。

```text
quotaReserved = false
upstreamReached = false
```

## 9. Observability

### 9.1 Gateway stage

既存の `octg.resource_stage` と `tokenize` stage を維持する。

成功時の finish に最低限次を含める。

- `outcome: success`
- `estimationPath`
- input bytes
- input text bytes
- opaque input bytes

失敗時は次を必須とする。

```json
{
  "event": "octg.resource_stage",
  "stage": "tokenize",
  "phase": "finish",
  "outcome": "exception",
  "route": "error:tokenizer_unavailable",
  "quotaReserved": false,
  "upstreamReached": false
}
```

`quota_reserve` と `upstream` stage は開始しない。

### 9.2 Durable Object stage

Tokenizer DO は構造化 `console.log` event `octg.tokenizer_stage` を出力する。

stage:

- `init`: `getEncoding()` を実際に呼ぶ場合だけ start / finish
- `encode`: exact BPE を試すたびに start / finish

outcome:

- `success`: exact 処理成功
- `fallback`: 捕捉可能な BPE 例外から byte fallback へ移行
- `exception`: RPC を成立させられない異常

revision ID は `env.CF_VERSION_METADATA?.id` から取得し、未設定時は `local` とする。
RPC request では渡さない。

ログ可能な metadata は次に限定する。

- request ID
- revision ID
- stage / phase / outcome
- duration
- byte count
- token count
- estimation path
- 入力内容を含まない failure category

次はログへ出力しない。

- input text、prompt、message content、request body
- Authorization header、API key、client secret
- raw token array、tokenizer 対象文字列
- 生の例外 message と stack

観測は best-effort とし、ログ出力の問題で token estimation または fail-closed 判定を変更しない。

## 10. Wrangler と migration

Gateway Worker から `TokenizerController` を export し、Env に次を追加する。

```ts
readonly TOKENIZER_CONTROLLER: DurableObjectNamespace<TokenizerController>;
```

`wrangler.jsonc` に binding を追加する。

```json
{
  "name": "TOKENIZER_CONTROLLER",
  "class_name": "TokenizerController"
}
```

既存の `v1` migration は変更しない。新しい SQLite-backed class を `v2` で追加する。

```json
{
  "tag": "v2",
  "new_sqlite_classes": ["TokenizerController"]
}
```

DO は SQLite-backed として登録するが、application data の保存には使用しない。
CPU limit の引き上げ設定は追加せず、Workers Free Plan の既定範囲を使用する。

## 11. テスト戦略

### 11.1 Tokenizer unit test

次を検証する。

- request runtime validation
- exact BPE と現行 semantics の parity
- empty、ASCII、日本語、emoji、source code、JSON
- long English、long Japanese、mixed Unicode
- opaque input、multiple messages
- `getEncoding()` failure の fallback
- `encode()` failure の fallback
- 初期化失敗後の次 request での再試行
- encoding instance の再利用
- safe integer と overflow
- Storage / D1 非使用
- 入力内容をログへ含めないこと

parity は移行前の `estimateInputTokens()` から取得した数値を golden case として
保存する。旧 BPE 実装を shared または test helper に残さない。

### 11.2 74k-token regression

短い非機密の固定テキストを決定的に反復し、テスト時に約 74,000 token 級の入力を生成する。production payload は保存しない。

通常の `npm test` で次を検証する。

- exact BPE が完了すること
- token 数が想定規模であること
- Gateway production path で local BPE を実行しないこと

### 11.3 Gateway integration test

次の失敗を注入する。

- RPC failure
- overload 相当の例外
- missing field
- unknown estimation path
- NaN、Infinity、負数、小数、unsafe integer
- quota 算術 overflow

各ケースで次を検証する。

- Tokenizer RPC call は 1 回
- HTTP 503 と `tokenizer_unavailable`
- `Retry-After` がない
- reserve calls は 0
- upstream calls は 0
- failure stage に未予約・未到達が明記される

成功系では次の既存 lifecycle を回帰検証する。

- Tokenizer success → reserve success → upstream success → settle
- Tokenizer success → reserve success → upstream uncertain → markUncertain
- known pre-upstream failure → release
- reserve failure → upstream 未到達

### 11.4 Dependency isolation test

Gateway と shared の production code に次が存在しないことを静的に検査する。

- `js-tiktoken` import
- `getEncoding()`
- `encoding.encode()`
- Tokenizer RPC failure 後の local estimation

## 12. Production canary

deploy 後に concurrency `1`、`2`、運用者が必須指定する `expected peak` で
canary を実行する。`expected peak` は `MAX_IN_FLIGHT_REQUESTS` から導出しない。
実行値と根拠を検証記録へ残す。

各 canary で次を確認する。

- Workers Free Plan のまま実行できる
- Gateway invocation に `exceededCpu` がない
- 同一 request ID に Gateway `tokenize` start / finish がある
- Tokenizer DO に `init` または `encode` の該当 event がある
- tokenization 成功後にのみ `quota_reserve` が始まる
- reservation 成功後にのみ upstream が始まる
- OpenAI success 時に actual usage で settle される
- Tokenizer failure 時に reserve と upstream が 0 回
- prompt、payload、API key がログへ保存されない

## 13. Rollback

問題発生時は deployment revision 単位で前の revision へ rollback する。
Gateway 内の local BPE へ自動 fallback しない。

`v2` migration は削除または書き換えない。rollback 後の旧 revision には大規模入力の CPU 超過問題が残るため、運用上、大規模入力を制限する。

## 14. 対象外

本変更では次を実装しない。

- tokenizer sharding
- tokenizer result cache または prompt hash cache
- model ごとの tokenizer 選択
- Workers Paid Plan への移行
- QuotaController redesign
- quota upper-bound algorithm の再設計
- paid fallback
- OpenAI Usage API reconciliation の変更

## 15. 完了条件

次をすべて満たした場合に完了とする。

1. `npm test` が成功する。
2. `npm run typecheck` が成功する。
3. 74k-token級fixtureでGateway WorkerがCPU超過しない。
4. Tokenizer成功後にのみreserveへ進む。
5. Tokenizer失敗時のreserveとupstreamが0回である。
6. 既存のsettle、markUncertain、release semanticsに回帰がない。
7. Gatewayとsharedのproduction codeにBPE依存が残っていない。
8. 機密入力がStorage、D1、ログへ保存されない。
9. concurrency 1、2、expected peakのproduction canaryをWorkers Free Planで完了する。
10. `REQUIREMENTS_2026-08-17.md` のAC-01からAC-13までの証跡が揃う。
