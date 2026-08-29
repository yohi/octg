# OCTG — Deno Deploy を利用した大型入力 tokenization 外部化 要件ブリーフ

## 1. 対象リポジトリ

* Repository: `yohi/octg`
* Target branch: `master`
* 対象は現在の `master` 実装を基準とする。
* OCTG は Cloudflare Worker を OpenAI 互換 API Gateway とし、`TokenizerController` / `QuotaController` の Durable Objects、D1、Cloudflare AI Gateway を組み合わせている。現行 tokenization は Gateway から固定 ID `tokenizer:primary` の `TokenizerController` を呼び、`o200k_base` exact BPE を実行する構成である。([GitHub][1])

## 2. 背景・課題

Cloudflare の無料枠で OCTG を運用した場合、大きな入力に対する tokenization の CPU 処理時間が Worker / Durable Object のリソース制限に抵触し、Error 1102 等でリクエストが繰り返し失敗するケースがある。

現行 `SPEC.md` §16 はこの問題を既知の課題として扱い、CPU / memory / concurrency を観測したうえで原因別の対策を適用する方針を定義している。CPU 起因の場合の既存案は、大入力では exact BPE を実行せず conservative byte estimation に切り替える `BPE cutoff` である。約74,000-token級 payload が想定 concurrency で成功し、`exceededCpu` / `exceededMemory` が発生しないことなどが解決条件として定義されている。([GitHub][2])

今回、この CPU 対策として conservative estimation を採用するのではなく、**CPU負荷が高い大型入力の exact BPE tokenization を Deno Deploy に外部化する**。

## 3. 目的

Cloudflare を OCTG の主系として維持したまま、CPU負荷の高い tokenization のみ Deno Deploy へ逃がすことで、Cloudflare 無料枠の CPU 制限による大型リクエストの失敗を改善する。

同時に以下を維持する。

* tokenization 結果の exactness
* quota reservation の意味および既存の予算保護
* fail-closed 性
* OpenAI 互換の公開 API 契約
* 既存 Cloudflare-only deployment との後方互換性
* prompt / credential の既存プライバシー原則

## 4. 現状の関連フロー

現在の主要フローは以下。

`Client`
→ Gateway Worker
→ 認証 / policy / model / request normalization
→ `QuotaController.getState()`
→ `tokenizeInput(env.TOKENIZER_CONTROLLER, …)`
→ `TokenizerController`
→ token budget 算術
→ quota reservation
→ upstream

`proxy.ts` は tokenization に `inputText`, `messageCount`, `opaqueInputBytes` を渡している。tokenizer が unavailable の場合は `internal_error` として終了し、quota reservation / upstream に進まない。([GitHub][3])

`apps/gateway-worker/src/tokenizer.ts` は固定 ID `tokenizer:primary` の RPC を行い、RPC exception や不正な結果を `unavailable` として fail-closed に変換している。([GitHub][4])

現行 exact token 算定は概念的に以下である。

```text
base = o200k_base.encode(inputText).length

estimated_input =
    base
    + opaqueInputBytes
    + (messageCount * 4)
    + 3
```

`TokenizerController` は `tiktoken/lite` と `o200k_base` を利用している。encoder initialization / encode の通常 `Error` に限り、既存挙動として conservative bytes fallback が存在する。([GitHub][2])

## 5. 期待する新しい挙動

### 5.1 基本方針

Deno integration は **opt-in** とする。

Deno integration が設定されていない deployment は、現在と同じ Cloudflare-only の tokenization 経路を維持する。

Deno integration が有効な deployment では、正規化済み tokenization 対象文字列の UTF-8 byte size、すなわち **`inputTextBytes`** を基準として実行先を決定する。

```text
inputTextBytes < configured threshold
    → 既存 TokenizerController

inputTextBytes >= configured threshold
    → Deno Deploy
```

境界値 `inputTextBytes == threshold` は Deno Deploy 側とする。

### 5.2 対象 endpoint

以下の双方を対象とする。

* `POST /v1/chat/completions`
* `POST /v1/responses`

クライアントや endpoint ごとに異なる閾値を持たせず、Deno の有効化・閾値は deployment-wide とする。

OCTG の既存要件でもこの2 endpoint は主要な OpenAI compatibility 対象である。([GitHub][5])

## 6. Deno Deploy 側の責務

今回 Deno Deploy に移すのは、**`inputText` に対する `o200k_base` exact BPE の base token 数算出だけ**とする。

Deno 側へ移さないもの：

* `opaqueInputBytes` の加算
* message overhead
* output token 上限計算
* safety margin
* quota state
* quota reservation / settlement
* client policy 判定
* model 判定
* upstream 呼び出し

これらは Cloudflare 側の既存責務として維持する。

同一の `inputText` に対し、Deno 経路の exact BPE token 数は既存 `TokenizerController` の exact BPE token 数と一致しなければならない。

近似値や conservative estimation は Deno 経路では許容しない。

## 7. Deno Deploy への送信データ

Deno Deploy には exact BPE tokenization に必要な**最小限のデータのみ**を送る。

送信してはならないものには少なくとも以下を含む。

* 元の OpenAI request body 全体
* client policy
* quota state
* quota reservation 情報
* OpenAI API key
* Cloudflare AI Gateway 用 credential
* `octg_sk_*` client credential

request correlation や検証に必要な最小限の metadata は許容する。

Deno から返す情報も、exact BPE token 数と処理上必要な最小限の metadata に限定する。

具体的な wire schema は今回の要件では固定せず、設計フェーズで判断する。

## 8. 認証・プライバシー

Deno tokenizer endpoint は **OCTG から認証された要求のみ**処理しなければならない。

認証には Deno integration 専用の credential を使用し、以下を流用しない。

* `octg_sk_*`
* OpenAI credential
* Cloudflare / AI Gateway 用 credential

具体的な認証方式は設計フェーズで決定する。

Deno 側では以下を永続化または application log に保存してはならない。

* prompt
* `inputText`
* 元 request body
* credential / Authorization material

現行 OCTG の resource observation も本文ではなく byte size、stage、duration、outcome 等を記録する方針である。([GitHub][2])

## 9. 障害時挙動

Deno 対象と判定された tokenization は **1 request につき1回のみ** Deno Deploy を呼び出す。

以下の場合は retry しない。

* timeout
* network / communication failure
* Deno の 5xx
* malformed / invalid response
* その他 tokenization を確定できない失敗

その場合：

* Cloudflare `TokenizerController` へ fallback しない
* conservative estimation へ fallback しない
* quota reservation を実行しない
* upstream を呼び出さない
* fail-closed とする

公開 API 上は既存 tokenization failure と同様に：

```text
HTTP 500
type: api_error
code: internal_error
```

として扱う。

Deno 固有の障害内容は公開 API contract に追加せず、内部 observability で識別可能にする。

## 10. 既存 TokenizerController の互換性

`inputTextBytes < threshold` の Cloudflare 経路は既存挙動を維持する。

特に、現行 `TokenizerController` に存在する encoder initialization / encode の通常 `Error` に対する conservative bytes fallback は今回廃止しない。

これは **Cloudflare 側の既存 fallback** として維持する。

一方、Deno 経路にはこの fallback を導入しない。

## 11. Configuration 要件

### Deno 未設定

Deno 関連設定が完全に存在しない場合：

* Deno integration は disabled
* 全 tokenization は従来どおり `TokenizerController`
* 既存 deployment に追加設定を要求しない

### Deno 有効時

Deno integration を利用する場合、少なくとも概念上以下が必要になる。

* Deno endpoint
* Deno 専用 authentication material
* `inputTextBytes` routing threshold
* Deno tokenization timeout

具体的な環境変数名や設定配置方法は設計フェーズで決定する。

### 不完全設定

Deno 関連設定が一部だけ存在する状態を、黙って「Deno disabled」と解釈してはならない。

不完全・不正な構成は明示的な configuration error として扱い、Deno 対象となる request を暗黙に `TokenizerController` へ fallback させない。

configuration error を deployment 時に拒否するか request 時に拒否するか等の具体的方式は設計判断とする。

## 12. 閾値要件

ルーティング閾値は **`inputTextBytes`** に対して適用する。

Deno 有効時、閾値は：

* 明示設定を必須とする
* 正の整数であること
* 実効 `MAX_INPUT_BYTES` 以下であること

を要求する。

現在の deployment の `MAX_INPUT_BYTES` は `1,048,576` bytes であり、raw body と normalized input の上限として使用されている。([GitHub][2])

閾値の具体値は要件段階では固定しない。

入力サイズ別 CPU profile と canary / concurrency 試験を根拠として決定する。

## 13. Timeout 要件

Deno tokenization には有限 timeout を必須とする。

* deployment-wide に設定可能であること
* 正の有限値であること
* 具体値は約74,000-token級 payload を含む canary / 実測結果から決定すること

timeout 発生時は §9 の fail-closed 契約に従う。

## 14. Production / Preview 分離

Production と Preview は、それぞれ独立した Deno tokenizer を利用する。

少なくとも以下を共有しない。

* endpoint
* authentication material

Preview から Production tokenizer、Production から Preview tokenizer を利用しない。

これは既存 OCTG が Worker / D1 / Durable Object / policy / registry / reconciliation state を Production / Preview 間で共有しない方針と整合させる。([GitHub][5])

## 15. Deno Deploy の所有モデル

各 OCTG deployment の利用者が、**自分自身の Deno Deploy project をデプロイ・所有・運用する**。

OCTG 運営側が提供する共有 tokenizer service は今回提供しない。

Deno tokenizer の source code と、利用者が再現可能な deployment / configuration documentation は `octg` repository 内に含める。

具体的な repository directory structure は設計フェーズで決定する。

## 16. コスト条件

Deno tokenizer は **Deno Deploy Free plan だけでデプロイ・利用可能**であることを前提とする。

有料機能・有料 plan を必須条件としてはならない。

ただし、

* 任意の traffic volume が常に無料枠内に収まること
* 無料枠の枯渇が絶対に発生しないこと

までは保証対象としない。

Free plan の利用枠枯渇・service pause 等で tokenization が利用できない場合も fail-closed とする。

## 17. 公開 API 互換性

今回の変更によってクライアント向け API contract を変更しない。

変更しないもの：

* request format
* response format
* authentication method
* base URL 利用方法
* tokenizer 実行先を選択する client parameter

クライアントは、その request が `TokenizerController` と Deno Deploy のどちらで処理されたかを意識する必要がない。

tokenizer provider を client から指定する API は追加しない。

## 18. Observability 要件

各 tokenization request について、prompt 内容を記録せず、少なくとも以下を確認可能にする。

* tokenization 実行先

  * Cloudflare `TokenizerController`
  * Deno Deploy
* `inputTextBytes`
* tokenization duration
* success / failure
* failure category
* request ID / revision との関連付け
* quota reservation の有無
* upstream 到達有無

Deno の timeout、communication failure、5xx、malformed response 等は、公開 API code を増やさず内部 observability 上で区別可能にする。

既存 `resource-observation.ts` はすでに `inputBytes`, `inputTextBytes`, `opaqueInputBytes`, `estimationPath`, `durationMs`, `quotaReserved`, `upstreamReached` 等を記録できる。([GitHub][6])

## 19. 成功条件・受け入れ条件

以下をすべて満たすこと。

1. Deno 設定が完全に未設定の場合、従来の `TokenizerController` 経路のみで動作する。
2. Deno 有効時、`inputTextBytes < threshold` は `TokenizerController` を利用する。
3. Deno 有効時、`inputTextBytes == threshold` は Deno Deploy を利用する。
4. Deno 有効時、`inputTextBytes > threshold` は Deno Deploy を利用する。
5. `/v1/chat/completions` と `/v1/responses` の双方で同じ routing rule が成立する。
6. 同一 `inputText` に対する Deno の `o200k_base` exact BPE token 数が既存 `TokenizerController` の exact BPE token 数と一致する。
7. Deno 経路でも最終 quota 計算の意味が既存と変わらない。
8. Deno timeout 時は retry しない。
9. Deno communication failure 時は retry しない。
10. Deno 5xx 時は retry しない。
11. Deno malformed / invalid response 時は retry しない。
12. 上記 Deno failure では `TokenizerController` へ fallback しない。
13. 上記 Deno failure では conservative estimation を利用しない。
14. 上記 Deno failure では quota reservation が発生しない。
15. 上記 Deno failure では upstream に到達しない。
16. Deno failure の公開 API response は既存の `500 / api_error / internal_error` contract を維持する。
17. Deno 関連設定が部分的・不正な場合、黙って Cloudflare-only mode に戻らない。
18. routing threshold の不正値を有効な Deno configuration として受理しない。
19. timeout の不正値を有効な Deno configuration として受理しない。
20. Deno endpoint は認証なしの tokenization request を処理しない。
21. prompt / `inputText` / credential が Deno の永続 storage または application log に残らない。
22. 元 request body、client policy、quota state、OpenAI credential 等が Deno に送られない。
23. tokenization provider、`inputTextBytes`、duration、success/failure、failure category を本文なしで観測できる。
24. 約 **74,000-token級の確認済み payload** が Deno 経路で `target concurrency` において成功する。
25. 上記 canary で Cloudflare 側に `exceededCpu` が発生しない。
26. quota reservation / settlement / uncertain / release 等の既存 quota contract に回帰がない。
27. OpenAI 互換の client-facing API contract に回帰がない。

既存 §16.6 も、約74,000-token級 payload の concurrency 下での成功、resource limit 超過の不存在、quota/upstream contract の維持を解決条件としている。([GitHub][2])

## 20. `target concurrency` の決定条件

具体的な concurrency 数は現時点では固定しない。

実運用または canary で観測された**大型 request の最大同時実行数**を基準として `target concurrency` を確定する。

根拠のない任意の concurrency 数を要件として固定しない。

## 21. Documentation 要件

repository 内の利用者向け documentation に少なくとも以下を含める。

* Deno tokenizer の deployment 方法
* Deno integration の有効化条件
* 必須 configuration
* routing threshold の意味
* threshold を実測から決める方法
* timeout の意味
* timeout を実測から決める方法
* Production / Preview の分離
* Deno disabled 時の挙動
* 不完全 configuration 時の挙動
* Deno failure 時の挙動
* retry / fallback を行わないこと
* Free plan 前提と保証範囲
* prompt / credential の取り扱い

## 22. 今回の対象外

以下は今回の改修に含めない。

* Cloudflare の完全な置き換え
* Gateway 全体の Deno Deploy 移行
* `QuotaController` の外部化
* quota reservation / settlement の再設計
* upstream routing の外部化
* Deno 以外の external tokenizer provider 対応
* 複数 external provider の abstraction を必須化すること
* client 単位の tokenizer routing
* endpoint 単位の異なる threshold
* client から tokenizer provider を選択する API
* OCTG 運営者による共有 Deno tokenizer service
* Deno failure 時の Cloudflare exact BPE fallback
* Deno failure 時の conservative estimation
* `SPEC.md` §16.2 の conservative BPE cutoff を今回の CPU 対策として実装すること
* §16.3 の raw / normalized memory limit 分離
* §16.4 の tokenization admission lease
* 無関係なリファクタリング
* 将来 provider のためだけの拡張

§16.3 / §16.4 は、実測でそれぞれ memory / concurrency が独立した原因と確認された場合の別改修として残す。([GitHub][2])

## 23. 関連する既存コード

主な影響境界として確認済みなのは以下。

* `apps/gateway-worker/src/proxy.ts`

  * request normalization 後の tokenization 呼び出し
  * `tokenizeInput(...)`
  * tokenization failure → `internal_error`
  * tokenization 後の token budget / reservation 境界
    ([GitHub][3])

* `apps/gateway-worker/src/tokenizer.ts`

  * `tokenizeInput`
  * `TokenizerOutcome`
  * `tokenizer:primary`
  * RPC result validation
  * RPC failure の fail-closed conversion
    ([GitHub][4])

* `durable-objects/tokenizer-controller/src/estimator.ts`

  * `tiktoken/lite`
  * `o200k_base`
  * exact BPE
  * existing conservative fallback
    ([GitHub][7])

* `durable-objects/tokenizer-controller/src/contracts.ts`

  * 現行 tokenization contract の境界
    ([GitHub][8])

* `apps/gateway-worker/src/resource-observation.ts`

  * resource stage / duration / input byte size / estimation path / quota / upstream observation
    ([GitHub][6])

* `apps/gateway-worker/wrangler.jsonc`

  * `TOKENIZER_CONTROLLER`
  * `MAX_INPUT_BYTES`
  * deployment configuration
    ([GitHub][9])

* `README.md`

  * current architecture / template deployment documentation
    ([GitHub][1])

* `SPEC.md`

  * §5.4 token estimation
  * §16 Worker resource observation / conditional mitigation
  * §16.6 resolution criteria
    ([GitHub][2])

## 24. 既決事項

今回のヒアリングで以下は確定済み。

* Cloudflare は主系として維持する。
* 外部化対象は tokenization のみ。
* Deno Deploy のみを今回正式対応する。
* 大入力のみ Deno へ送る。
* routing criterion は `inputTextBytes`。
* threshold 以上を Deno とする。
* Deno は exact `o200k_base` BPE。
* Deno failure は fail-closed。
* Deno failure 時の retry はしない。
* Deno failure 時の Cloudflare fallback はしない。
* Deno failure 時の conservative fallback はしない。
* Deno の責務は base exact BPE count のみ。
* Deno integration は opt-in。
* Deno 未設定の既存 deployment は変更しない。
* Deno Free plan を前提とし、有料機能を必須にしない。
* Deno endpoint は認証必須。
* 専用 credential を使用する。
* prompt 本文を Deno に保存・log しない。
* 最小限のデータだけ Deno に送る。
* Production / Preview を分離する。
* 各 OCTG 利用者が自分の Deno project を所有する。
* source と deployment documentation は同 repository に含める。
* client-facing API は変更しない。
* `/v1/chat/completions` と `/v1/responses` の双方が対象。
* configuration は deployment-wide。
* threshold は明示設定必須。
* timeout は有限かつ明示設定可能。
* threshold / timeout の具体値は実測で決める。
* 約74,000-token級 payload の成功を必須成功条件とする。
* `target concurrency` は実測から決定する。
* §16.3 / §16.4 は今回対象外。

## 25. 未決事項 — brainstorming / 設計フェーズへ委ねる

以下は**要件として未確定なのではなく、要件を満たすための設計判断**なので、本ブリーフでは決めない。

* Deno tokenizer の repository 内 directory / package 構成
* Cloudflare ↔ Deno の具体的 request / response schema
* Deno endpoint の URL structure
* authentication mechanism
* secret の具体的管理方法
* configuration variable の具体的名称
* configuration validation の実施箇所
* timeout 制御の具体的方式
* HTTP client の具体的実装方式
* Deno Deploy の具体的 deployment workflow
* observability field / event name の具体的名称
* test implementation / mock strategy
* exact BPE library の Deno 上での具体的利用方式
* Deno service 内の component / module 分割

これらは `superpowers brainstorming` および後続の設計工程で判断する。

## 26. 実測後に値だけ確定する事項

以下は設計案ではなく、**実測結果がなければ確定できない operational requirement value** として未確定のまま残す。

* `inputTextBytes` routing threshold
* Deno tokenization timeout
* 約74,000-token級 payload の `target concurrency`

これらは CPU / wall-time profile、canary、および実運用の大型 request concurrency を根拠として確定する。

[1]: https://github.com/yohi/octg "GitHub - yohi/octg · GitHub"
[2]: https://github.com/yohi/octg/blob/master/SPEC.md "octg/SPEC.md at master · yohi/octg · GitHub"
[3]: https://github.com/yohi/octg/blob/master/apps/gateway-worker/src/proxy.ts "octg/apps/gateway-worker/src/proxy.ts at master · yohi/octg · GitHub"
[4]: https://github.com/yohi/octg/blob/master/apps/gateway-worker/src/tokenizer.ts "octg/apps/gateway-worker/src/tokenizer.ts at master · yohi/octg · GitHub"
[5]: https://github.com/yohi/octg/blob/master/REQUIREMENTS.md "octg/REQUIREMENTS.md at master · yohi/octg · GitHub"
[6]: https://github.com/yohi/octg/blob/master/apps/gateway-worker/src/resource-observation.ts "octg/apps/gateway-worker/src/resource-observation.ts at master · yohi/octg · GitHub"
[7]: https://github.com/yohi/octg/blob/master/durable-objects/tokenizer-controller/src/estimator.ts "octg/durable-objects/tokenizer-controller/src/estimator.ts at master · yohi/octg · GitHub"
[8]: https://github.com/yohi/octg/blob/master/durable-objects/tokenizer-controller/src/contracts.ts "octg/durable-objects/tokenizer-controller/src/contracts.ts at master · yohi/octg · GitHub"
[9]: https://github.com/yohi/octg/blob/master/apps/gateway-worker/wrangler.jsonc "octg/apps/gateway-worker/wrangler.jsonc at master · yohi/octg · GitHub"
