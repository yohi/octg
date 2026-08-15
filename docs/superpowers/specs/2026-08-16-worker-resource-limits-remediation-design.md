# Worker Resource Limits 障害の段階的対策設計

## 背景

Cloudflare AI Gateway 経由の大規模 Responses API リクエストで、OCTG Worker が
Cloudflare Error 1102 を返した。確認できた事実は Worker がリソース制限に達したこと
であり、CPU と memory のどちらが直接原因かは invocation outcome 未取得のため確定
していない。

現行実装には raw request body と normalized input の 1 MiB 上限、および pool 単位の
upstream in-flight 制御がある。一方、同期 BPE は quota reserve と in-flight acquire より
前に実行されるため、現行の in-flight 制御は tokenizer の CPU または memory 負荷を
保護しない。

本設計は、単一の原因を先に決めず、観測結果に応じて必要な対策だけを有効化する。
約 74,000-token 級の合法なリクエストは可能な限り処理し、安全な予約上限を確認できない
payload 形状だけを reserve 前に拒否する。

## 目的

1. 障害報告書の現行実装との不一致を訂正する。
2. Error 1102 の CPU、memory、並行負荷の原因を区別できる観測情報を定義する。
3. 確認された原因に対応する最小限の対策を選択できるようにする。
4. 大規模入力でも fail-closed な quota reservation を維持する。
5. canary と upstream usage の比較に基づく解決判定条件を固定する。

## 非目的

- invocation outcome 取得前に BPE cutoff を恒久対策として確定しない。
- quota の authoritative state を Durable Object 以外へ移さない。
- D1 監査ログの成功を quota 判定や upstream 到達条件にしない。
- 未検証の比率式を request 全体の token 上限として採用しない。
- Workers プランの既定値から障害時 deployment の実効 limit を推定しない。

## 障害報告書の訂正方針

`docs/troubleshooting-503-worker-resource-limits.md` は、次の区分で再構成する。

1. **インシデント事実:** Error 1102、HTTP 503、観測時刻、AI Gateway が記録した
   token 数と応答時間。
2. **未確定事項:** deployment revision、実効 CPU / memory limit、invocation outcome、
   CPU time、wall time、memory profile。
3. **現行実装:** raw body / normalized input limit、同期 BPE、quota reserve、upstream
   in-flight 制御と処理順序。
4. **観測ゲート:** 原因を確定し、対策を選ぶために必要な証拠。
5. **原因別対策:** CPU、memory、並行負荷の各分岐。
6. **解決判定:** canary と quota 安全性の合格条件。

報告書にある「`NormalizedRequest.inputTextBytes` は未実装」という記述は削除する。
現行の `packages/shared/src/normalize.ts` は `inputTextBytes` を既に公開し、Responses では
`inputBytes = inputTextBytes + opaqueInputBytes` を維持している。したがって、BPE cutoff
採用時に必要なのは型・normalize の追加ではなく、推定経路、設定、proxy 統合、テストの
変更である。

## 観測ゲート

恒久対策を選ぶ前に、対象リクエストについて次を同じ request ID と revision に関連付ける。

- Worker deployment/version ID または commit SHA
- Workers プランと実効 `limits.cpu_ms` / memory limit
- raw body bytes、normalized input bytes、text bytes、opaque bytes
- exact BPE / conservative byte estimation の推定経路
- body read、parse、normalize、tokenize、Durable Object RPC、upstream の処理時間
- CPU time、wall time、invocation outcome
- canary 実行時の concurrency
- quota reserve の有無と upstream 到達有無

入力本文、tokenizer 対象文字列、認証素材は記録しない。D1 への監査書き込みは
best-effort を維持し、書き込み失敗で quota 判定を変更しない。

対策の選択条件は次のとおりとする。

| 観測結果 | 適用候補 |
| --- | --- |
| `exceededCpu`、tokenize が主要因 | BPE cutoff と conservative byte estimation |
| `exceededMemory`、一時 allocation が主要因 | raw / normalized limit の分離 |
| 単発では成功し、並行時だけ失敗 | BPE 前 tokenization admission |
| 複数条件が確認された | 確認された分岐だけを組み合わせる |

## CPU 対策

### 推定経路

CPU profiling で同期 BPE が主要因と確認された場合、normalized total bytes に対する
`BPE_MAX_INPUT_BYTES` を導入する。

- `inputBytes < BPE_MAX_INPUT_BYTES` では、従来どおり `o200k_base` の exact BPE を使う。
- `inputBytes >= BPE_MAX_INPUT_BYTES` かつ hard limit 未満では、BPE を実行せず、
  `inputTextBytes` を text tokenizer token 数の保守的上限として使う。
- `opaqueInputBytes` と message overhead は一度だけ加算する。
- `inputBytes` は cutoff 判定に使えるが、byte-based 経路の text base としては使わない。
  Responses の `inputBytes` は opaque bytes を既に含むためである。

`BPE_MAX_INPUT_BYTES` は任意の固定値ではなく、入力サイズ別 CPU profile と concurrency
試験から決定する。

### Request 全体の安全性

`inputTextBytes` は text tokenizer token 数の上限として扱うが、OpenAI が返す request
全体の `usage.input_tokens` の上限を単独では保証しない。Chat Completions と Responses の
受理する payload 形状ごとに、同一 payload の reserve 値と upstream usage を比較する。

`reservedInputTokens >= upstream usage.input_tokens` を確認できた形状だけを許可する。
確認できない形状は追加 safety margin を検証するか、reserve 前に HTTP 400
`invalid_request` で拒否する。サイズ超過ではないため HTTP 413 は使用しない。

## Memory 対策

`exceededMemory` と memory profile が原因を示した場合、現在同じ値を共有している raw body
と normalized input の上限を独立させる。

- raw body limit は body の読み取りと JSON parse 前の保護を担当する。
- normalized input limit は text と opaque data の正規化後サイズを保護する。
- 各 limit は同じ workload の memory profile と canary 結果から決定する。
- limit 超過は HTTP 413 `request_too_large` とし、reserve と upstream を実行しない。

加えて、request stream chunks、結合後 buffer、decoded string、JSON object、normalized text、
encoded token 配列の生存期間を計測する。同時に保持する必要がない中間表現を早期に解放し、
変更前後の peak allocation を比較する。`exceededMemory` outcome だけから allocation 箇所や
peak 値を推定しない。

## 並行負荷対策

単発では成功し、複数リクエストが BPE へ同時進入した場合だけ失敗することが確認された
場合、pool 単位の tokenization admission lease を追加する。

- model、policy、pool の解決後、BPE 前に lease を取得する。
- lease は quota reservation と別の state とし、取得・拒否で quota token を変更しない。
- BPE または byte-based 推定の完了直後に解放する。
- Worker が Error 1102 で中断し解放処理を実行できない場合に備え、lease は期限を持つ。
- 次回取得時に期限切れ lease を除去する。
- request ID による同一 lease の再取得は冪等に扱う。

admission を採用する場合は `MAX_TOKENIZATION_REQUESTS` と
`TOKENIZATION_LEASE_TTL_MS` を導入する。production 値は単発の推測で決めず、受理する最大
入力の tokenize wall time と concurrency profile から決定する。観測値が得られるまで
production の有効値は定義しない。

tokenization admission の上限到達時は HTTP 429 `rate_limit_error`、code
`tokenization_concurrency_exceeded`、route `reject:tokenization_concurrency` を返す。quota
reserve と upstream 呼び出しは実行しない。現行の upstream in-flight lease は、長時間
upstream request の保護として reserve 後に維持する。

## 処理フロー

```text
authenticate
→ raw body limit
→ JSON.parse
→ normalize + normalized input limit
→ model / policy / pool resolution
→ best-effort audit start
→ optional tokenization admission lease
→ exact BPE or conservative byte estimation
→ tokenization lease release
→ payload shape safety gate
→ quota reserve
→ upstream in-flight lease
→ upstream
→ settle / markUncertain / release
→ upstream in-flight lease release
```

tokenization admission を導入しない原因分岐では、その取得・解放だけを省略する。quota
reserve、upstream 到達判定、settlement の既存契約は変更しない。

## エラー契約

| 条件 | HTTP / code | Quota | Upstream |
| --- | --- | --- | --- |
| raw / normalized hard limit 超過 | 413 / `request_too_large` | 予約しない | 到達しない |
| 未検証 payload 形状 | 400 / `invalid_request` | 予約しない | 到達しない |
| tokenization admission 飽和 | 429 / admission code | 予約しない | 到達しない |
| 推定処理の予期しない失敗 | 500 / `internal_error` | 予約しない | 到達しない |
| reserve 後、upstream 未到達が確実 | 既存契約 | `release` | 到達しない |
| reserve 後、upstream 到達が不確実 | 既存契約 | `markUncertain` | 不確実 |

tokenization admission lease は quota state と分離するため、期限切れ回収や拒否によって
confirmed、reserved、uncertain token を変更してはならない。

## テスト方針

### 推定単体テスト

- cutoff の直前、境界、直後で exact / byte-based 経路を確認する。
- printable ASCII の既知反例、CJK、複数 message を固定 fixture にする。
- byte-based 値が text の tokenizer token 数を下回らないことを確認する。
- message overhead と `opaqueInputBytes` が一度だけ加算されることを確認する。

### Payload differential test

Chat Completions と Responses について、text-only、複数 message / item、tools、reasoning、
`function_call`、`function_call_output` を canary upstream へ送る。各形状で
`reservedInputTokens >= upstream usage.input_tokens` を確認する。未確認または不合格の形状は
許可リストへ含めない。

### Limit 境界テスト

- `Content-Length` あり・なしの raw body について、上限の直前、境界、1 byte 超過を確認する。
- normalized input についても独立した上限の直前、境界、1 byte 超過を確認する。
- 拒否時に normalize 後続処理、tokenize、reserve、upstream が実行されないことを確認する。

### Admission テスト

- 上限内取得、上限超過、同一 request ID の冪等取得、正常解放を確認する。
- 期限切れ lease と異常終了相当の lease が次回取得時に回収されることを確認する。
- admission 拒否と期限切れ回収で quota state が変化しないことを確認する。

### 負荷試験

約 74,000-token 級の同一 payload を concurrency 1、2、想定ピークで実行する。変更前後の
CPU time、wall time、memory profile、invocation outcome を比較する。単発結果だけで cutoff、
hard limit、admission 上限を決定しない。

## 解決判定

次の条件をすべて満たした場合だけ、インシデントを解決済みとする。

1. canary の deployment revision と実効 CPU / memory limit が記録されている。
2. 約 74,000-token 級の確認済み payload が想定 concurrency で成功する。
3. 対象 canary に `exceededCpu` と `exceededMemory` がない。
4. CPU time、wall time、memory profile が採用した limit 内に収まる。
5. 許可した全 payload 形状で予約値が upstream `usage.input_tokens` を下回らない。
6. 拒否経路で quota reserve と upstream 呼び出しが発生しない。
7. upstream 到達後の settle / uncertain / release 契約に回帰がない。

単発成功、outcome 未取得、または upstream usage と予約値を比較していない状態では
解決済みと判定しない。

## 変更範囲

観測結果に応じて、次の範囲から必要なものだけを変更する。

- `docs/troubleshooting-503-worker-resource-limits.md`: 事実、現行実装、観測ゲート、対策分岐の整理
- `packages/shared/src/estimate.ts`: CPU 対策が必要な場合の推定経路
- `packages/shared/src/errors.ts`: admission 導入時の専用エラー契約
- `apps/gateway-worker/src/proxy.ts`: 観測、設定解決、推定分岐、admission 統合
- `apps/gateway-worker/src/request-body.ts`: memory 対策で raw limit を独立させる場合
- `durable-objects/quota-controller/src/*`: admission 導入時の期限付き lease state
- shared / Worker / Durable Object tests: 推定、安全性、境界、lease、quota 非消費

原因分岐に該当しない変更は実施しない。
