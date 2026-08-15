<!-- markdownlint-disable MD013 -->

# OCTG 503 エラー（Cloudflare Error 1102）障害調査報告書

## 1. 発生事象（Overview）

### 事象の概要

Cloudflare AI Gateway（`my-gateway`）経由で OCTG Worker（`octg-gateway`）へ
リクエストを送信した際、連続して **`503 Service Unavailable`** が返却されました。

### ログ確認結果（JST: 2026-08-16）

```text
┌──────────────────────┬────────┬───────────────┬────────────────┬────────────────┬──────────┬─────────────────┐
│ 日時 (JST)           │ Status │ Provider      │ Model          │ Path           │ Duration │ Tokens (In/Out) │
├──────────────────────┼────────┼───────────────┼────────────────┼────────────────┼──────────┼─────────────────┤
│ 2026/8/16 02:16:47   │ 503    │ custom-octg   │ gpt-5.6-luna   │ v1/responses   │ 0.10s    │ 0 / 0           │
│ 2026/8/16 02:16:42   │ 503    │ custom-octg   │ gpt-5.6-luna   │ v1/responses   │ 0.10s    │ 0 / 0           │
│ 2026/8/16 02:16:40   │ 503    │ custom-octg   │ gpt-5.6-luna   │ v1/responses   │ 0.30s    │ 0 / 0           │
│ 2026/8/16 02:16:38   │ 200    │ custom-octg   │ gpt-5.6-luna   │ v1/responses   │ 3.79s    │ 74,504 / 73    │
│ 2026/8/16 02:16:34   │ 200    │ custom-octg   │ gpt-5.6-luna   │ v1/responses   │ 3.64s    │ 74,383 / 74    │
│ 2026/8/16 02:16:29   │ 200    │ custom-octg   │ gpt-5.6-luna   │ v1/responses   │ 4.85s    │ 74,223 / 116   │
└──────────────────────┴────────┴───────────────┴────────────────┴────────────────┴──────────┴─────────────────┘
```

- **正常完了（200 OK）時:** AI Gateway の記録では入力が約 **74,000 tokens**、
  所要時間は約 3.6〜4.8 秒でした。
- **異常発生（503 エラー）時:** 200 OK の直後、約 100〜300ms で 503 が返却され、
  記録上は Upstream への到達を確認できませんでした。

### エラー詳細（Response Payload）

AI Gateway ログの詳細から、Cloudflare エッジが以下のエラー HTML を返却したことが
確認されました。

```html
<title>Worker exceeded resource limits | octg-gateway.yohi-consadole12.workers.dev | Cloudflare</title>
<span class="cf-error-code">1102</span>
<h2 class="cf-subheadline">Worker exceeded resource limits</h2>
```

この 503 は OCTG Worker が生成した通常の OpenAI 互換エラーではなく、Worker の実行
中断に伴う Cloudflare エッジの応答です。

### インシデント環境の記録

今回確認できた記録だけでは、障害時に実際に稼働していた Worker の revision と
Cloudflare 側の実効リソース設定を特定できません。Workers のプラン既定値を、対象
Worker に適用された上限として扱わないでください。

| 項目 | 現時点の記録 | 確認方法・注記 |
| --- | --- | --- |
| Worker deployment/version ID または commit SHA | 未取得 | 障害時の deployment とログの revision を照合する |
| Workers プラン | 未取得 | 対象 Worker のアカウント設定で確認する |
| 実効 `limits.cpu_ms` | 未取得 | `wrangler.jsonc` に明示設定がないことだけでは実効値を確定できない |
| 実効 memory limit | 未取得 | Error 1102 は memory 制限超過でも発生し得るため、CPU と別に確認する |
| `MAX_INPUT_BYTES`（現ブランチの raw request body 上限） | `1048576`（1 MiB） | 障害時 deployment の設定が同じか別途確認する |
| `MAX_IN_FLIGHT_REQUESTS`（現ブランチ設定） | `2` | 障害時 deployment の設定が同じか別途確認する |
| `compatibility_date`（現ブランチ設定） | `2026-08-01` | 障害時 deployment の設定が同じか別途確認する |
| インシデント時間帯 | 2026-08-16 02:16:29〜02:16:47 JST | ログに記録された観測範囲 |
| Invocation outcome（`exceededCpu` / `exceededMemory`） | 未取得 | Metrics > Errors > Invocation Statuses、Analytics、または Logpush の `Outcome` から確認する |
| CPU time、wall time | 未取得 | Workers Logs または Trace Events から確認する。Workers Logs では outcome ではなく実行時間を確認する |

---

## 2. 根本原因の分析（Root Cause Analysis）

### 2.1 確認できた事実と未確定事項

確認できた直接のエラーは **Cloudflare Error 1102（Worker exceeded resource
limits）** です。Cloudflare のエラー一覧では 1102 は CPU 時間制限超過として説明
されています。一方、Limits の説明では、メモリ制限超過でも同じエラーページが発生
し得ます。

現時点で確定できるのは Worker がリソース制限に達したことです。同期トークン推定に
よる CPU 超過は有力な原因候補ですが、Metrics > Errors > Invocation Statuses、Analytics、
または Logpush の invocation outcome（`exceededCpu` / `exceededMemory`）と、Workers Logs
または Trace Events の CPU time / wall time を確認するまで根本原因として断定しません。
Workers Logs では CPU time / wall time を確認し、`exceededCpu` / `exceededMemory` は
invocation outcome の観測経路で確認します。
また、Free/Paid のプラン既定値や旧 Bundled usage model の値ではなく、障害時の
deployment に適用された実効 `cpu_ms` を確認する必要があります。

### 2.2 ボトルネック候補のコード

[`packages/shared/src/estimate.ts`](../packages/shared/src/estimate.ts) の入力
トークン推定処理がボトルネック候補です。

```typescript
import { getEncoding, type Tiktoken } from "js-tiktoken";

let encoding: Tiktoken | undefined;

export function estimateInputTokens(
  text: string,
  messageCount: number,
  opaqueInputBytes = 0,
): number {
  let base: number;
  try {
    encoding ??= getEncoding("o200k_base");
    base = encoding.encode(text).length;
  } catch {
    base = new TextEncoder().encode(text).length;
  }
  return base + opaqueInputBytes + 4 * messageCount + 3;
}
```

この関数は reserve 前に同期的な BPE エンコードを実行します。ただし、実際の CPU
時間やメモリ使用量は入力内容と実行環境に依存するため、コード断片だけでは 1102 の
原因を確定できません。

### 2.3 推定されるメカニズム

1. クライアントから大規模なテキストを含む JSON が送信されます。
2. Worker は入力の正規化後、Durable Object で事前予約するために
   `estimateInputTokens(text, ...)` を呼び出します。
3. `js-tiktoken` の `o200k_base` エンコードが同期実行され、CPU またはメモリ負荷が
   増加する可能性があります。
4. この処理を含む Worker の CPU またはメモリ使用量が制限を超えた場合、エッジが
   リクエストを中断して Error 1102 を返します。
5. AI Gateway は Worker の HTML エラーページを受け取り、クライアントに 503 として
   返却したと考えられます。

上記は観測結果と実装経路に基づく仮説です。CPU trace または invocation outcome で
確認するまで、トークン推定だけを単一の根本原因とは扱いません。

根本原因の切り分けでは、次の項目を個別に確認します。

- 障害時の deployment に `MAX_INPUT_BYTES=1048576`（1 MiB）が含まれていたか。
- 障害時の deployment に `MAX_IN_FLIGHT_REQUESTS=2` が含まれていたか。
- 同一 isolate または Worker instance で、障害時に何件のリクエストが同時実行されていたか。
- Invocation Statuses、Analytics、または Logpush の `Outcome` が `exceededCpu` と
  `exceededMemory` のどちらだったか。
- 上記の outcome と、障害リクエストの raw body bytes、正規化後 bytes、BPE 処理時間、reserve
  および in-flight lease の取得時刻が整合するか。

---

## 3. OCTG の設計思想と解決方針

### 3.1 設計思想との照合

OCTG の中核設計原則は **意図しない課金の防止（Zero Unexpected Cost / Fail-Closed）**
です。

- **事前予約（Reserve）の目的:** クォータ不足時に Upstream へ流さないこと。
- **実測精算（Settle）の仕組み:** Upstream の `usage.total_tokens` を使って実使用量を
  確定し、過剰予約分を解放すること。

### 3.2 解決方針（追加対策の提案）

以下は現時点では **Proposed / 未実装** です。現在の Worker がすでに持つ入力制限や
in-flight 制御を置き換える実装ではなく、障害時の outcome と profiling の結果に応じて
追加検討する対策です。

厳密な BPE トークナイズを省略すること自体は可能です。ただし、省略する場合は、
実際の token 数を下回らない上限、または安全な拒否条件が必要です。

`Math.ceil(UTF8Bytes / 2)` は安全な上限ではありません。`o200k_base` の deterministic fixture
（seed `0x12345678`、printable ASCII alphabet、20,000 bytes）では 14,812 tokens となる一方、
同じ入力の `/ 2` 推定は 10,000 tokens です。この再現ケースは
[`packages/shared/test/estimate.test.ts`](../packages/shared/test/estimate.test.ts) の
`reproduces a printable 20 KB counterexample to byte-halving` に固定しています。UTF-8 byte 数を
使う場合も、まず `inputText` そのものの `o200k_base` token 数に対する上限として扱います。

したがって、巨大入力では `/ 2` のような比率推定を使いません。BPE 専用 cutoff を導入する場合は、
正規化済みの `inputText` の UTF-8 byte 数を、その text の tokenizer token 数に対する保守的な上限として
扱います。安全性を証明できない入力を reserve 前に `413 Request Entity Too Large` として拒否するのは、
BPE cutoff そのものではなく、必要と判断した場合だけ追加する hard rejection です。
ただし、この関係だけでは Responses API の item 構造、message overhead、tools、reasoning、
その他の upstream 固有形式を含む**request 全体の `usage.input_tokens` の上限は保証しません**。
request 全体を fail-closed に予約するには、受理する payload 形状ごとの構造 overhead を別途
保守的に加算するか、raw request bytes を request 全体の上限として使えることを検証するか、
検証できない structured payload を拒否します。

byte 上限による拒否は新規に追加する仕組みではありません。対象 proxy endpoint の
`handleProxy()` は既に `MAX_INPUT_BYTES` を `readJsonBody()` に渡し、raw JSON body の
`Content-Length` とストリーミング実測値を JSON parse 前に検査します。超過時は HTTP 413 を
返し、正規化、D1 監査行の登録、quota reserve、Upstream 呼出の前に処理を終了します。
さらに正規化後の入力も、`handleProxy()` が `env.MAX_INPUT_BYTES` から解決した
`maxInputBytes` と同じ実効閾値で検査されます。`MAX_NORMALIZED_INPUT_BYTES` は normalize 関数を
引数なしで単独呼出しする場合のデフォルト値であり、proxy では `MAX_INPUT_BYTES` が未設定または
不正な場合に `resolveMaxInputBytes()` が返す fallback 値として使われるだけです。独立した
Worker runtime 設定ではありません。raw body と normalized input は測定対象こそ異なりますが、
現行 proxy 経路では同じ `maxInputBytes` を共有します。
まず障害発生時の deployment に適用された `MAX_INPUT_BYTES` と、74,000-token リクエストの
raw body byte 数を比較し、既存の 413 防御の対象だったかを確認します。必要な場合だけ、
profiling に基づいて既存設定を引き下げます。

---

## 4. 具体的な解決策（Solution）

この節は、**現ブランチで実装済みの緩和策**と、障害時の profiling 後にだけ検討する
**未実装の追加改善候補**を分けて記載します。現時点では byte-based estimation や
`BPE_MAX_INPUT_BYTES` cutoff は存在せず、`estimateInputTokens()` は BPE 推定を実行します。

実装と設定の対応は次のとおりです。

| 対策 | 実装箇所 | 現ブランチの既定値・動作 |
| --- | --- | --- |
| raw request body の上限 | `apps/gateway-worker/src/request-body.ts` / `apps/gateway-worker/src/proxy.ts` | `MAX_INPUT_BYTES=1 MiB`。JSON parse 前に超過を `413` で拒否 |
| normalized input の上限 | `apps/gateway-worker/src/proxy.ts` / `packages/shared/src/normalize.ts` | raw body と同じ解決済み `maxInputBytes`（現ブランチの既定値 1 MiB）。`inputTextBytes` と `opaqueInputBytes` を含む `inputBytes` を検査 |
| pool 単位の in-flight 制御 | `apps/gateway-worker/src/proxy.ts` / `durable-objects/quota-controller/src/quota-controller.ts` | `MAX_IN_FLIGHT_REQUESTS=2`。現行実装では reserve 後、upstream 前に acquire。BPE 実行前の admission ではない |

### 4.1 既存実装・BPE cutoff・追加 hard rejection の区別

この節では、入力サイズに関する制御を次の 3 つに分けて扱います。障害時 deployment に同じ
revision と設定が適用されていたかは未確認です。

1. **既存実装: raw body / normalized input の hard limit**
   - `MAX_INPUT_BYTES`（現ブランチの既定値は 1 MiB）は raw request body の上限です。
     `Content-Length` が存在して上限を超える場合は body を読む前に拒否し、存在しない場合も
     `readJsonBody()` が stream の累積 byte 数を制限します。超過時は JSON parse、正規化、reserve、
     Upstream 呼出を行わず、`413` を返します。
   - 正規化後の semantic input も、`handleProxy()` が `env.MAX_INPUT_BYTES` から解決した
     `maxInputBytes` で検査されます。raw body と normalized input は測定対象が異なりますが、
     現行 proxy 経路では両方に同じ実効閾値が渡されます。`normalizeChatCompletions()` と
     `normalizeResponses()` は `inputBytes` を算出し、上限超過時に `413` を返します。これは今回
     新たに追加する仕組みではありません。
   - `MAX_NORMALIZED_INPUT_BYTES` は normalize 関数を引数なしで単独呼出しする場合のデフォルト値です。
     proxy では `MAX_INPUT_BYTES` が未設定または不正な場合に `resolveMaxInputBytes()` が返す fallback
     として使われますが、独立した Worker runtime 設定ではありません。

2. **今回追加する候補: BPE 専用 cutoff（Proposed / 未実装）**
   - `BPE_MAX_INPUT_BYTES` は、CPU profiling で決める BPE 専用の概念的な閾値です。現ブランチには
     この設定も cutoff 経路も存在しません。`MAX_INPUT_BYTES` や `MAX_NORMALIZED_INPUT_BYTES` の
     代替・別名ではありません。
   - 正規化成功後、`requestData.inputBytes < BPE_MAX_INPUT_BYTES` の場合だけ従来の
     `js-tiktoken` / `encoding.encode()` を実行します。閾値以上でも既存 hard limit 未満なら、BPE を
     実行せず、`requestData.inputTextBytes` と `requestData.opaqueInputBytes` を使う byte-based
     estimation に切り替えます。この cutoff 自体は入力を拒否する hard limit ではありません。
   - `MAX_IN_FLIGHT_REQUESTS`（現ブランチの既定値は `2`）は QuotaController の pool 単位で
     upstream 呼出し中のリクエスト数を制限しますが、`acquireInFlight()` より前の BPE を保護する
     admission control ではありません。

3. **必要な場合だけ追加する hard rejection（Proposed / 未実装）**
   - profiling で既存の 1 MiB hard limit が CPU または memory 保護に不十分と判明した場合だけ、
     `MAX_INPUT_BYTES` を安全値へ引き下げる、または別の hard limit を設けることを検討します。
     この変更は BPE cutoff とは別の入力拒否制御であり、既定の追加対策ではありません。
   - hard limit を変更する場合は、Issue #33 の合法な Responses API の text / reasoning / tool
     history を不用意に拒否しないことを回帰テストで確認します。安全な上限を証明できない structured
     payload だけを拒否する方針も、同じ回帰テストの対象にします。

処理順序は概ね
`authenticate → request body 1 MiB hard limit → JSON.parse → normalize / normalized size check
→ BPE cutoff 判定 → BPE または byte-based estimation → reserve → acquireInFlight → upstream`
です。`readJsonBody()` が request body の byte 上限と JSON parse をまとめて実行しますが、処理順序上は
JSON parse が raw body 上限の後にあります。したがって raw body の 1 MiB 制限は正規化・BPE・reserve
より前に働きますが、BPE cutoff は正規化後の `requestData.inputBytes` を見て推定経路だけを切り替えます。
in-flight 制御は `estimateInputTokens()` と reserve の後に働くため、tokenizer 自身の同期 CPU spike や、
その前段の JSON parse・正規化による負荷は防ぎません。

ここまでの raw body 上限、JSON parse 前の 413、normalized input の上限は現ブランチで実装済みです。
1102 対策として新たに追加する項目ではなく、74,000-token workload に対して既存の 1 MiB が十分かを
profiling で再評価する対象です。

この `MAX_IN_FLIGHT_REQUESTS` は QuotaController の pool 単位の制御であり、Worker isolate 内の
tokenizer 実行を直接制限する admission control ではありません。したがって、同じ isolate に
複数の threshold 未満の大きめ入力が同時に到着すると、各リクエストが `acquireInFlight()` より
前に BPE まで進み、単発 profiling では見えない CPU または memory の合算負荷が発生し得ます。
追加対策を検討する場合は、BPE 前に bounded な admission/concurrency control を設ける案を
候補に含めます。ただし、これを導入する場合も quota の authoritative な予約制御を
Durable Object から移してはいけません。現在の reserve → acquire の順序を単純に入れ替える
だけでは、BPE 前に pool を決定する軽量な経路、admission 拒否時の quota 非消費、後続の
normalize / reserve 失敗時の lease 解放を定義できないため、別途設計・実装・検証が必要です。

したがって、「固定 byte 上限を追加する」こと自体は今回の追加対策ではありません。今回新たに
決めるべきなのは、障害時の invocation outcome を確認したうえで、既存 limit を調整するか、
未実装のトークン推定経路を変更するかです。

### 4.2 BPE cutoff によるトークン推定改善（Proposed / 未実装）

現在も正規化後に `estimateInputTokens()` が無条件に呼ばれ、内部で
`encoding.encode(text)` による同期 BPE 推定を実行しています。byte-based fallback はまだ
実装されていません。

この Proposed cutoff の前提契約は、`NormalizedRequest` が `inputTextBytes`（`inputText` の UTF-8
bytes のみ）、`inputBytes`（正規化済み入力全体）、`opaqueInputBytes`（`encrypted_content` などの
opaque bytes）を別々に公開することです。現行ブランチでは `inputBytes` と `opaqueInputBytes` は
公開されていますが、`inputTextBytes` はまだ公開されていません。BPE cutoff を実装する際は、
先に次の型・normalize 変更を行います。

```typescript
readonly inputTextBytes: number;
```

`normalizeChatCompletions()` / `normalizeResponses()` で `inputText` の UTF-8 bytes を一度算出して
返し、Responses では `inputBytes = inputTextBytes + opaqueInputBytes`、Chat では
`inputBytes = inputTextBytes` かつ `opaqueInputBytes = 0` を維持します。BPE cutoff の byte-based
経路では `requestData.inputTextBytes` を使い、`requestData.inputBytes` を text bytes として扱いません。

Chat では `opaqueInputBytes` が常に `0` のため、`inputTextBytes` は `inputBytes` と同じです。
Responses では reasoning の `encrypted_content` などの opaque bytes がすでに
`inputBytes` に含まれるため、`inputBytes` 全体を byte-based の `base` に使ってから
`opaqueInputBytes` を加算してはいけません。

対象ファイルは [`packages/shared/src/estimate.ts`](../packages/shared/src/estimate.ts)
です。閾値は任意の文字数ではなく、Workers の CPU profiling 結果を基に UTF-8 byte
数で決定します。

#### 実装方針

1. 上記の型・normalize 変更後に正規化処理で算出された `requestData.inputTextBytes`、`requestData.inputBytes`、
   `requestData.opaqueInputBytes` を使います。Responses の invariant は
   `inputBytes = inputTextBytes + opaqueInputBytes` です。
2. `requestData.inputBytes < BPE_MAX_INPUT_BYTES` の場合だけ、従来どおり `o200k_base` の
   `encoding.encode()` による正確な推定を実行します。
3. `requestData.inputBytes >= BPE_MAX_INPUT_BYTES` かつ既存 hard limit 未満の場合は BPE を実行せず、
   `requestData.inputTextBytes` をその text の tokenizer token 数に対する保守的な上限として使います。
4. `opaqueInputBytes` は推定式で一度だけ加算します。既存の raw body 上限を変更する場合は、
   BPE の閾値や normalized input の上限とは別の設定として、profiling の結果に基づいて行います。

以下は `inputTextBytes` を追加済みの型を前提にした、BPE cutoff 実装後の想定コードです。現行の
`proxy.ts` にそのまま存在するコードではなく、BPE cutoff を実装する際の疑似コードです。

```typescript
const inputTextBytes = requestData.inputTextBytes;
const base = requestData.inputBytes < BPE_MAX_INPUT_BYTES
  ? exactEstimate(requestData.inputText)
  : inputTextBytes;
const estimatedInput = base
  + requestData.opaqueInputBytes
  + 4 * requestData.messageCount
  + 3;
```

例えば `inputText` が 100,000 bytes、`opaqueInputBytes` が 20,000 bytes の Responses
request では、`inputBytes` は 120,000 です。大入力経路の `base` は 100,000 とし、opaque
bytes は式の後半で一度だけ加算します。したがって、opaque bytes を 120,000 の `base` に
含めたうえで再度加算する実装は誤りです。

ここで `BPE_MAX_INPUT_BYTES` は実測で決定する設定値です。`exactEstimate` は既存の
`o200k_base` 推定処理を表します。実装時は `requestData.opaqueInputBytes` をそのまま推定式へ渡し、
`requestData.inputBytes` 全体を base として再度加算しないでください。
この設計では cutoff の判定には normalized total bytes である `requestData.inputBytes` を使えますが、
byte-based fallback の `base` には必ず `inputTextBytes` だけを使います。`inputBytes` はすでに
`opaqueInputBytes` を含むため、`inputBytes` を `base` にして opaque bytes を加算する実装は禁止です。
`opaqueInputBytes` は推定式で一度だけ加算します。この疑似コードは、現行の型で byte 数の意味を
分離し、opaque bytes の二重計上を防ぐ設計を示しています。

#### 追加候補のテスト方針

`packages/shared/test/estimate.test.ts` などの推定テストでは、少なくとも次を固定します。

- `requestData.inputBytes < BPE_MAX_INPUT_BYTES` の cutoff 前では `encoding.encode()` が実行される。
- `MAX_INPUT_BYTES` 未満でも `requestData.inputBytes >= BPE_MAX_INPUT_BYTES` の cutoff 後では
  `encoding.encode()` が実行されず、byte-based estimation が選ばれる。
- `opaqueInputBytes = 0` の Chat と、`opaqueInputBytes > 0` になる Responses の reasoning / tool
  history の両方で、`inputBytes === inputTextBytes + opaqueInputBytes` の invariant を確認する。
- cutoff 前後とも `opaqueInputBytes` がちょうど一度だけ加算され、`estimatedInput` が過小評価にも
  opaque bytes の二重計上にもならないことを確認する。
- `MAX_INPUT_BYTES` を引き下げる、または別の hard limit を追加する場合は、Issue #33 の合法な
  Responses API payload（text / reasoning / tool history）が不用意に `413` にならない回帰テストを通す。

この疑似コードが保証する対象は、`inputText` の tokenizer token 数と、既存の近似式に
明示された `opaqueInputBytes` および message overhead だけです。これを OpenAI が返す
request 全体の `usage.input_tokens` の証明済み upper bound と解釈してはいけません。
Responses API の `function_call` / `function_call_output`、tool schema、reasoning の
`summary` / `encrypted_content`、多数の structured item を受理する場合は、各構造を
upstream の usage と比較する differential test を実施し、`estimated/reserved input >=
upstream reported input_tokens` を確認できた形状だけを許可します。確認できない形状は
reservation 前に拒否します。

### 4.3 memory 超過が確認された場合の別 remediation

`exceededMemory` が確認された場合、BPE bypass だけを解決策として扱いません。`exceededMemory` は
per-isolate の memory limit を超過した invocation outcome であり、実際の peak memory や allocation
量そのものではありません。次の変更を別途 profiling し、必要な範囲で適用します。

1. 現行 proxy 経路で raw body と normalized input が共有する `MAX_INPUT_BYTES` の実効値を、
   対象 deployment の memory limit と負荷試験に基づく安全値へ引き下げます。
   `MAX_NORMALIZED_INPUT_BYTES` は現状では fallback 定数であり、独立した deployment 設定ではありません。
   `MAX_INPUT_BYTES` が有効な場合にこの定数だけを変更しても、proxy 経路の normalized input 上限は
   変わりません。raw body と normalized input を独立して tuning する場合は、新しい runtime 設定と
   それを別々に `readJsonBody()` / `normalize*()` へ渡すコード変更として設計・検証します。
2. `readJsonBody()` の chunks、結合後 `Uint8Array`、decoded string、JSON object が同時に
   生存する時間を測定し、body buffering と JSON parse の一時 allocation を削減します。
3. `normalizeResponses()` の serialized text と `inputText` の構築が同時に保持される範囲を
   測定し、必要なら正規化処理を分割または早期拒否します。
4. DevTools の memory profiling で、request stream buffering → 結合後の `Uint8Array` →
   `TextDecoder` → `JSON.parse` → normalize / `join` → `TextEncoder` → `getEncoding()` 初期化
   → `encoding.encode()` の各段階における peak allocation を比較します。

`exceededMemory` だけを確認できて実際の memory profile を取得できない場合は、これらを適用した
ことだけで 1102 解消とは判定せず、
原因を未確定のまま維持します。

### 4.4 効果と安全性の判定条件

1. **CPU 負荷:** Metrics > Errors > Invocation Statuses、Analytics、または Logpush の `Outcome`
   で `exceededCpu` を確認し、Workers Logs または Trace Events で CPU time / wall time を
   入力サイズ別に比較します。CPU のどの処理が重いかは DevTools の CPU profiling で調べます。
   「0.1ms 未満」のような未測定の保証は記載しません。
2. **メモリ負荷:** `Outcome` の `exceededMemory` は per-isolate の memory limit breach の有無を
   示す invocation outcome であり、memory 使用量や peak 値ではありません。実際の allocation や
   peak の比較には DevTools の memory profiling / Memory snapshots を使い、CPU の CPU time / wall
   time と混同しません。
3. **過小評価防止:** byte-based 経路が `inputText` の tokenizer token 数を下回らないことを、
   deterministic fixture と代表的な反例を含むテストで確認します。ただし、これは request 全体の
   upstream `usage.input_tokens` を保証しません。Chat Completions と Responses の text-only、
   複数 message/item、tools、reasoning、`function_call`、`function_call_output` を含む代表的な
   request shape について、同一 payload を実際の upstream に canary または統合テストとして送り、
   `reservedInputTokens >= upstream usage.input_tokens` を確認します。比較対象は正規化済み text の
   tokenizer token 数ではなく、upstream が返す実際の input usage です。structured payload はこの
   differential test を通過した形状だけを許可し、未確認の shape、または upstream の内部
   serialization に対する安全な上限を保証できない shape は、追加 safety margin を適用するか
   reserve 前に拒否します。`settle()` は既に発生した過小予約を取り消せないため、この確認の代替には
   なりません。
4. **Upstream 到達制御:** 推定または固定 byte 上限で拒否した場合、reserve と Upstream
   呼出が発生しないことを確認します。
5. **正確なクォータ精算:** Upstream が `usage.total_tokens` を返した場合は、
   `stub.settle(requestId, usage.total_tokens)` で実使用量に精算します。ただし settle は
   既に発生した過小予約を取り消せないため、安全な予約上限の代替にはなりません。
6. **運用・統合検証項目（raw body の境界）:** `Content-Length` あり・なしの両方で、`MAX_INPUT_BYTES + 1` bytes の
   body が JSON parse、正規化、reserve、Upstream 呼出より前に `413` になることを確認します。
7. **推定経路の境界:** BPE threshold の下側と上側で期待する経路を確認し、byte-based 経路で
   `estimatedInput >= inputText の tokenizer tokens` が維持されることを検証します。さらに
   plain text、複数 message、text part、large tool schema、function call 履歴、reasoning
   summary、large encrypted content、およびこれらを組み合わせた Issue #33 相当 payload で、
   `estimated/reserved input >= upstream reported input_tokens` を検証します。`opaqueInputBytes`
   は一度だけ加算されることも確認します。
8. **同時実行時の負荷:** 同一 payload を concurrency `1`、`2`、および想定ピーク並行数で
   実行し、各ケースの `exceededCpu` / `exceededMemory`、CPU time、wall time、memory profile を比較します。
   単発で threshold を決めず、threshold 未満の入力を複数同時に BPE へ通す現行順序での
   合算負荷も評価します。必要に応じて BPE 前 admission/concurrency control を導入し、
   導入前後で同じ測定を再実施します。
9. **canary の invocation outcome:** 同程度の大規模入力を canary で実行し、
   `exceededCpu` / `exceededMemory` のいずれにもならないことを確認します。CPU 原因と memory
   原因を区別できない場合、「解決済み」と判定しません。

---

## 5. 運用面での推奨事項（Operational Recommendations）

1. **クライアント側（OpenCode）の履歴管理:** コンテキスト長が 70,000 tokens を超える
   と、レイテンシと消費クォータが増大します。定期的なセッション切替やコンテキスト
   圧縮を推奨します。
2. **Workers プランの確認:** HTTP リクエストの CPU 制限は Free が 10 ms、Paid は既定
   30 秒で、設定により最大 5 分まで引き上げられます。50 ms は旧 Bundled usage model
   の値として知られていますが、これらの値から障害時の実効上限を推定しません。対象
   deployment の Worker 設定で実効 `limits.cpu_ms` を確認し、プラン変更だけで解決した
   と判断せず、profiling と入力制限を併用します。
3. **観測データの保存:** request ID、入力 byte 数、正規化後 byte 数、推定値、CPU time、
   wall time、invocation outcome（`exceededCpu` / `exceededMemory`）、Upstream 到達有無を保存します。
   `exceededMemory` は memory 使用量ではないため、実測値として扱いません。認証素材や入力本文は
   ログに保存しません。

### 5.1 追加調査が必要な項目

- **CPU:** Metrics > Errors > Invocation Statuses、Analytics、または Logpush の `Outcome` で
  `exceededCpu` を確認し、Workers Logs または Trace Events で CPU time / wall time を取得する。
  CPU の負荷箇所は DevTools の CPU profiling で確認する。
- **メモリ:** `Outcome` の `exceededMemory` を memory limit breach の有無として確認する。
  これは memory 使用量・peak 値ではないため、実際の allocation や peak の比較には DevTools の
  memory profiling / Memory snapshots を使う。本番の実メモリピークをこの outcome だけから推定せず、
  memory profile を取得できない場合は memory 原因を未確定のまま維持する。
- 障害時の deployment/version ID または commit SHA、Workers プラン、実効
  `limits.cpu_ms`、実効 memory limit を取得する。取得できない場合は「取得不能」と
  記録する。
- 実際の request body byte 数、正規化後の `inputText` byte 数、
  `opaqueInputBytes`、および `inputBytes` の関係を比較する。
- 障害発生時の raw request body に適用された `MAX_INPUT_BYTES` 実値と、74,000-token
  リクエストの raw request bytes を比較し、既存の 413 防御の対象だったかを記録から確認する。
- 同一 payload について、request stream buffering → 結合後の `Uint8Array` → `TextDecoder` →
  `JSON.parse` → normalize / `join` → `TextEncoder` → `getEncoding()` 初期化 → `encoding.encode()`
  → Durable Object RPC を処理段階ごとに分け、CPU profiling と memory profiling の両方を行う。
  BPE を無効化した比較ケースも用意し、推定処理以外の allocation と CPU 負荷を切り分ける。
- 同一 payload を concurrency `1`、`2`、想定ピーク並行数で canary 実行し、BPE 前の
  admission/concurrency control が必要かを `exceededCpu` / `exceededMemory`、CPU time、wall time、
  memory profile で判定する。現行の `MAX_IN_FLIGHT_REQUESTS` は `acquireInFlight()` より前の BPE を
  保護しないため、設定値 `1` と `2` の比較も行う。
- canary 環境で大規模入力を送信し、Error 1102 が再現するか確認する。

### 5.2 参照資料

- [Cloudflare Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Workers Errors and exceptions](https://developers.cloudflare.com/workers/observability/errors/)
