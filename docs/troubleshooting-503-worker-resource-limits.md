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
| `exceededCpu` / `exceededMemory`、CPU time、wall time | 未取得 | Workers Logs または Trace Events から確認する |

---

## 2. 根本原因の分析（Root Cause Analysis）

### 2.1 確認できた事実と未確定事項

確認できた直接のエラーは **Cloudflare Error 1102（Worker exceeded resource
limits）** です。Cloudflare のエラー一覧では 1102 は CPU 時間制限超過として説明
されています。一方、Limits の説明では、メモリ制限超過でも同じエラーページが発生
し得ます。

現時点で確定できるのは Worker がリソース制限に達したことです。同期トークン推定に
よる CPU 超過は有力な原因候補ですが、Workers Logs の `exceededCpu`、
`exceededMemory`、CPU time、wall time を確認するまで根本原因として断定しません。
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

---

## 3. OCTG の設計思想と解決方針

### 3.1 設計思想との照合

OCTG の中核設計原則は **意図しない課金の防止（Zero Unexpected Cost / Fail-Closed）**
です。

- **事前予約（Reserve）の目的:** クォータ不足時に Upstream へ流さないこと。
- **実測精算（Settle）の仕組み:** Upstream の `usage.total_tokens` を使って実使用量を
  確定し、過剰予約分を解放すること。

### 3.2 解決方針

厳密な BPE トークナイズを省略すること自体は可能です。ただし、省略する場合は、
実際の token 数を下回らない上限、または安全な拒否条件が必要です。

`Math.ceil(UTF8Bytes / 2)` は安全な上限ではありません。実際の `o200k_base` で、
20,000 byte の printable input が 14,846 tokens となる一方、同じ入力の `/ 2` 推定は
10,000 tokens となる反例を確認しています。

したがって、巨大入力では `/ 2` のような比率推定を使いません。正規化済み入力の
UTF-8 byte 数を保守的な上限として扱うか、安全性を証明できない入力を reserve 前に
`413 Request Entity Too Large` として拒否します。

byte 上限による拒否は新規に追加する仕組みではありません。対象 proxy endpoint の
`handleProxy()` は既に `MAX_INPUT_BYTES` を `readJsonBody()` に渡し、raw JSON body の
`Content-Length` とストリーミング実測値を JSON parse 前に検査します。超過時は HTTP 413 を
返し、正規化、D1 監査行の登録、quota reserve、Upstream 呼出の前に処理を終了します。
さらに正規化後の入力は、別の `MAX_NORMALIZED_INPUT_BYTES`（既定値
`1_048_576` bytes）で検査されます。前者は raw body 全体、後者は抽出した `inputText` と
Responses API の `opaqueInputBytes` を測るため、両者を同一の byte 数として扱ってはいけません。
まず障害発生時の deployment に適用された `MAX_INPUT_BYTES` と、74,000-token リクエストの
raw body byte 数を比較し、既存の 413 防御の対象だったかを確認します。必要な場合だけ、
profiling に基づいて既存設定を引き下げます。

---

## 4. 具体的な解決策（Solution）

### 4.1 既存状態と今回の追加変更

現在の実装には、次の二段階の hard limit が既にあります。

1. `MAX_INPUT_BYTES`（現ブランチの既定値は 1 MiB）は raw request body に対する上限です。
   `readJsonBody()` が `Content-Length` またはストリーム実測値を JSON parse 前に検査し、超過時は
   `413` を返します。
2. `MAX_NORMALIZED_INPUT_BYTES`（既定値は 1 MiB）は正規化後の semantic input に対する上限です。
   `normalizeChatCompletions()` と `normalizeResponses()` が検査し、超過時は `413` を返します。

したがって、「固定 byte 上限を追加する」こと自体は今回の解決策ではありません。今回新たに
決めるべきなのは、障害時の invocation outcome を確認したうえで、既存 limit を調整するか、
トークン推定の経路を変更するかです。

### 4.2 CPU 超過が確認された場合のトークン推定改善

対象ファイルは [`packages/shared/src/estimate.ts`](../packages/shared/src/estimate.ts)
です。閾値は任意の文字数ではなく、Workers の CPU profiling 結果を基に UTF-8 byte
数で決定します。

#### 実装方針

1. 正規化済み入力の UTF-8 byte 数を算出します。
2. 小さい入力は従来どおり `o200k_base` で推定します。
3. profiling で決めた閾値以上の入力は BPE を実行せず、入力テキストの byte 数を
   input token の保守的な上限として使います。
4. 現行の `NormalizedRequest.inputBytes` は `inputText` と `opaqueInputBytes` の合計
   なので、text 用 byte 数は `inputBytes - opaqueInputBytes` として求めます。
   `opaqueInputBytes` は推定式で一度だけ加算します。
5. 既存の `MAX_INPUT_BYTES` と `readJsonBody()` は raw request body に対する一次防御として
   そのまま利用します。これは BPE の閾値や正規化後入力の上限とは別の設定です。profiling の
   結果、raw body を早期拒否する必要がある場合に限り、既存の `MAX_INPUT_BYTES` を引き下げます。

疑似コードは次のとおりです。

```typescript
const inputTextBytes = normalizedInput.inputBytes
  - normalizedInput.opaqueInputBytes;
const base = inputTextBytes >= profiledThresholdBytes
  ? inputTextBytes
  : exactEstimate(normalizedInput.inputText);
const estimatedInput = base
  + normalizedInput.opaqueInputBytes
  + 4 * normalizedInput.messageCount
  + 3;
```

ここで `profiledThresholdBytes` は実測で決定する設定値です。`exactEstimate` は既存の
`o200k_base` 推定処理を表します。実装時は `normalizedInput.opaqueInputBytes` を
そのまま推定関数へ渡し、`inputBytes` 全体を base として再度加算しないでください。
`NormalizedRequest` の invariant は、`inputBytes` が `inputText` の UTF-8 byte 数と
`opaqueInputBytes` の合計であることです。このため `inputTextBytes` は上記の差分で
求め、`opaqueInputBytes` は推定式で一度だけ加算します。この疑似コードはそのまま
貼り付ける実装ではなく、既存の型での byte 数の算出と二重計上防止を含む設計を示して
います。

### 4.3 memory 超過が確認された場合の別 remediation

`exceededMemory` が確認された場合、BPE bypass だけを解決策として扱いません。次の変更を
別途 profiling し、必要な範囲で適用します。

1. 既存の `MAX_INPUT_BYTES` および `MAX_NORMALIZED_INPUT_BYTES` を、対象 deployment の
   実効 memory limit と負荷試験に基づく安全値へ引き下げます。
2. `readJsonBody()` の chunks、結合後 `Uint8Array`、decoded string、JSON object が同時に
   生存する時間を測定し、body buffering と JSON parse の一時 allocation を削減します。
3. `normalizeResponses()` の serialized text と `inputText` の構築が同時に保持される範囲を
   測定し、必要なら正規化処理を分割または早期拒否します。

memory outcome を確認できない場合は、これらを適用したことだけで 1102 解消とは判定せず、
原因を未確定のまま維持します。

### 4.4 効果と安全性の判定条件

1. **CPU・メモリ負荷:** Workers Logs または Trace Events で、入力サイズ別の CPU time、
   memory outcome、wall time を比較します。「0.1ms 未満」のような未測定の保証は記載
   しません。
2. **過小評価防止:** byte-based 経路が対象入力の token 数を下回らないことを、tokenizer
   の仕様と代表的な反例を含むテストで確認します。証明できない入力形式は reserve 前に
   拒否します。
3. **Upstream 到達制御:** 推定または固定 byte 上限で拒否した場合、reserve と Upstream
   呼出が発生しないことを確認します。
4. **正確なクォータ精算:** Upstream が `usage.total_tokens` を返した場合は、
   `stub.settle(requestId, usage.total_tokens)` で実使用量に精算します。ただし settle は
   既に発生した過小予約を取り消せないため、安全な予約上限の代替にはなりません。
5. **raw body の境界:** `MAX_INPUT_BYTES + 1` bytes の body が JSON parse、正規化、
   reserve、Upstream 呼出より前に `413` になることを確認します。
6. **推定経路の境界:** BPE threshold の下側と上側で期待する経路を確認し、byte-based 経路で
   `estimatedInput >= actual input tokens` が維持されることを検証します。`opaqueInputBytes` は
   一度だけ加算されることも確認します。
7. **canary の invocation outcome:** 同程度の大規模入力を canary で実行し、
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
   memory outcome、Upstream 到達有無を保存します。認証素材や入力本文はログに保存しません。

### 5.1 追加調査が必要な項目

- Workers Logs で `exceededCpu` と `exceededMemory` を確認する。
- 障害時の deployment/version ID または commit SHA、Workers プラン、実効
  `limits.cpu_ms`、実効 memory limit を取得する。取得できない場合は「取得不能」と
  記録する。
- Workers Logs または Trace Events で `exceededCpu` / `exceededMemory`、CPU time、
  wall time を取得する。どちらも確認できない場合は原因を未確定のまま維持する。
- 実際の request body byte 数、正規化後の `inputText` byte 数、
  `opaqueInputBytes`、および `inputBytes` の関係を比較する。
- 障害発生時の raw request body に適用された `MAX_INPUT_BYTES` 実値と、74,000-token
  リクエストの raw request bytes を比較し、既存の 413 防御の対象だったかを記録から確認する。
- `getEncoding()` 初期化、JSON parse、正規化、BPE、Durable Object RPC を分けて CPU
  profiling する。
- canary 環境で大規模入力を送信し、Error 1102 が再現するか確認する。

### 5.2 参照資料

- [Cloudflare Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Workers Errors and exceptions](https://developers.cloudflare.com/workers/observability/errors/)
