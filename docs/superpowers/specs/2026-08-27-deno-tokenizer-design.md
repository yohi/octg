# 大型入力の exact BPE tokenization を Deno Deploy へ外部化する設計

**作成日:** 2026-08-27  
**状態:** 指摘反映済み・利用者レビュー待ち  
**根拠:** `REQUIREMENTS_2026-08-27.md`

## 1. 目的と対象範囲

Cloudflare Worker を主系の OpenAI 互換 API Gateway として維持しつつ、正規化済み
`inputText` が大きい request の base exact BPE count だけを Deno Deploy に委譲する。
これにより、Worker と `TokenizerController` の CPU 制限に起因する大型入力の失敗を抑える。

今回の対象は `POST /v1/chat/completions` と `POST /v1/responses` である。Deno は
`o200k_base` による base token count 以外を担当しない。以下は引き続き Cloudflare
側の責務とする。

- `opaqueInputBytes`、message overhead、固定加算を含む入力 token 見積り
- output token 上限と token budget の算術
- quota state、reservation、settlement、release、uncertain
- client policy、model 判定、認証、upstream 呼出し

Cloudflare 全体の Deno 移行、quota の外部化、複数 tokenizer provider の抽象化、
client または endpoint ごとの threshold、Deno 失敗時の fallback は対象外である。

## 2. 確定した意思決定

| 項目 | 決定 |
| --- | --- |
| 実行先の選択 | `< threshold` は DO、`>= threshold` は Deno |
| 導入方法 | Deno integration は opt-in。完全未設定時は Cloudflare-only |
| 呼出し元 | Gateway Worker が Deno tokenizer を直接呼び出す |
| Deno の責務 | `inputText` の `o200k_base` base exact BPE count のみ |
| 認証 | Production / Preview ごとに異なる専用 shared Bearer secret |
| 不完全設定 | 認証済みの全 `/v1` request を generic 500 で fail-closed |
| Deno 失敗 | retry、`TokenizerController` fallback、conservative fallback なし |
| 公開エラー | 既存の `500 / api_error / internal_error` を維持 |
| 観測 | provider と低カーディナリティ failure category を本文なしで追加 |
| Production / Preview | endpoint、Bearer secret、Deno Deploy application を完全に分離 |

`threshold`、timeout、target concurrency の具体値は本設計では定めない。74,000-token
級 payload の CPU / wall-time profile と canary の結果から運用時に決定する。

## 3. 構成と責務境界

新たに deploy 可能な Deno application を `apps/deno-tokenizer` に置く。これは
Gateway Worker と同じ repository で管理するが、利用者自身が所有する Deno Deploy
application としてデプロイする。

```text
Client
  -> Gateway Worker
     -> authentication / configuration validation / normalization
     -> inputTextBytes routing
        -> TokenizerController (small input)
        -> Deno tokenizer (large input)
     -> input-token arithmetic / quota reservation / upstream
```

`apps/deno-tokenizer` は次の責務単位で分ける。

- `src/main.ts`: Deno Deploy entrypoint
- `src/http.ts`: method、content type、request / response schema、HTTP status
- `src/config.ts`: Deno 側 secret と input byte ceiling の検証
- `src/encoder.ts`: pin 済みの `tiktoken/lite` と `o200k_base` による exact BPE count
- `test/`: Deno native test による HTTP、認証、exactness、no-log の検証

Gateway Worker 側には、Deno 用 configuration parser と HTTP client を追加する。将来の
provider に備えた interface や strategy は作らない。現在 `TokenizerController` 内にある
入力 token 見積りの安全な算術は `packages/shared` へ移し、Deno 成功経路と既存 DO 経路で
同一実装を利用する。shared package は encoder を依存に持たない。

## 4. 設定と環境分離

### 4.1 実効 input byte ceiling

`MAX_INPUT_BYTES` は既存 Gateway Worker の入力上限の取得元であり、raw body と
normalized input を別々に制限する。`packages/shared` に shared resolver を置き、Worker と
Deno tokenizer はそれぞれの runtime environment の `MAX_INPUT_BYTES` を同じ規則で解決する。

```text
effectiveInputBytes = min(
  positiveSafeInteger(MAX_INPUT_BYTES) または 1_048_576,
  MAX_INPUT_TEXT_BYTES,
)
```

`MAX_INPUT_BYTES` が未設定、不正値、0、負数、小数、または安全整数外の場合は
`MAX_NORMALIZED_INPUT_BYTES`（1,048,576 bytes）へ解決する。上限は既存
`MAX_INPUT_TEXT_BYTES`（`16 * 1024 * 1024 - 65_536` bytes）で clamp する。この既存規則を
変更しない。

Deno Deploy の `MAX_INPUT_BYTES` には対応する Worker と同じ raw configuration value を設定する。
両環境は同じ shared resolver により同じ実効値を得るため、別名の
`DENO_TOKENIZER_MAX_INPUT_BYTES` は導入しない。runbook は値の同期手順と、deployment 時に
両環境の resolved value を照合する手順を定義する。

### 4.2 Gateway の Deno integration 設定

Gateway Worker の Deno integration は以下の値で構成する。

| 設定 | 種別 | 制約 |
| --- | --- | --- |
| `DENO_TOKENIZER_ENDPOINT` | variable | 絶対 HTTPS URL |
| `DENO_TOKENIZER_AUTH_TOKEN` | secret | 空でない専用 Bearer secret |
| `DENO_TOKENIZER_THRESHOLD_BYTES` | variable | 実効 ceiling 以下の正の安全整数 |
| `DENO_TOKENIZER_TIMEOUT_MS` | variable | runtime timer の範囲内にある正の有限整数 |

4 値がすべて未設定なら integration は disabled とする。いずれかだけが欠ける場合、または
endpoint / threshold / timeout が不正な場合は configuration invalid とする。認証成功後、
各 `/v1` handler は通常処理の前にこの状態を検査する。したがって未認証 request の
既存 401 / 403 契約を変えず、認証済み request は入力サイズや endpoint にかかわらず
generic 500 で fail-closed になる。

Deno application は以下を持つ。

| 設定 | 種別 | 制約 |
| --- | --- | --- |
| `OCTG_TOKENIZER_AUTH_TOKEN` | secret | 対応する Worker とだけ共有する値 |
| `MAX_INPUT_BYTES` | variable | Gateway と同一の raw configuration value |

Production と Preview には別々の Deno Deploy application、endpoint、secret を用意する。
同一 secret を再利用せず、Preview から Production endpoint を呼び出さない。Deno Deploy
では secret を secret として登録し、Production と Development の contexts を混在させない。

## 5. Deno HTTP 契約

Deno は `POST /tokenize` と `GET /health` を受け付ける。`GET /health` は公開
liveness check として認証を要求せず、HTTP 200 と次の JSON を返す。

```json
{"status":"ok"}
```

`POST /tokenize` は認証必須の tokenization endpoint である。Deno は path と method を
認証前に判定し、未知の path は 404、既知の path に対する不正な method は 405 とする。
Worker は tokenization request に対して HTTPS で次だけを送る。

```http
Authorization: Bearer <DENO_TOKENIZER_AUTH_TOKEN>
Content-Type: application/json
```

```json
{"inputText":"normalized text"}
```

元 OpenAI request body、client policy、quota state、reservation 情報、request ID、
OpenAI credential、Cloudflare credential、`octg_sk_*` は送らない。Worker の resource
observation が request ID と revision を相関するため、Deno wire contract に metadata を
追加しない。

`POST /tokenize` の成功応答は HTTP 200 と次の JSON だけである。

```json
{"baseTokenCount":123}
```

`baseTokenCount` は負でない安全整数でなければならない。Deno は `POST /tokenize` について
content type、JSON shape、UTF-8 input byte ceiling、認証を検証し、認証失敗時は encode を
実行しない。
サイズ検証は次の二段階に分ける。

1. **raw JSON envelope:** Worker は whitespace を含めない canonical
   `JSON.stringify({ inputText })` を送る。Deno は raw body ceiling を
   `6 * effectiveInputBytes + 16` bytes として導出する。`Content-Length` がこの値を超える場合は
   read 前に拒否する。欠落または偽装（宣言値より大きい）header の場合は bounded stream read で
   同じ ceiling を強制する。数値として解釈できない不正な `Content-Length` は read 前に HTTP 400 で
   拒否する。
   この ceiling は JSON escape による raw body の増加を許容するためのものであり、inputText の
   上限判定には用いない。
2. **parsed `inputText`:** JSON shape の検証後に `TextEncoder` で UTF-8 byte length を測定し、
   `inputTextBytes > effectiveInputBytes` の場合だけ拒否する。等値は受理するため、
   `inputTextBytes == DENO_TOKENIZER_THRESHOLD_BYTES` の正当な Deno routing を妨げない。

Bearer secret は constant-time comparison で比較する。Deno は prompt、認証値、元 request body、
encoder error を永続化または application log に出力しない。

## 6. Gateway routing と quota 境界

既存の request 順序を維持する。

1. 認証と Deno configuration validation を実行する。
2. request body を読み、既存どおり正規化して `inputTextBytes` を得る。
3. model と policy を判定し、`QuotaController.getState()` を読む。
4. reservation より前に tokenization provider を選択する。
5. tokenization 成功時だけ token budget を解決し、既存の reservation / admission / upstream
   / settlement 経路へ進む。

Deno が選ばれる場合、Worker は request ごとに一度だけ `fetch` する。timeout は request
ローカルの `AbortSignal` で制御し、redirect と retry を許可しない。Cloudflare Workers は
Fetch 標準の `redirect: "error"` を受け付けないため、実装では `redirect: "manual"` を使い、
redirect を追従させない。timer は `fetch` 開始前から
HTTP response body の読取り、JSON decode、schema validation が完了するまで維持する。したがって
HTTP 200 の header 受信後に body stream が停止しても、`DENO_TOKENIZER_TIMEOUT_MS` 経過後に
abort して `timeout` として扱う。HTTP 200、JSON content type、および有効な
`baseTokenCount` だけを成功として受理する。

Worker は次の式を shared helper で安全に計算する。

```text
estimatedInputTokens =
  baseTokenCount + opaqueInputBytes + (messageCount * 4) + 3
```

小入力の `TokenizerController` 経路は変更しない。その経路にある encoder initialization /
encode の通常 `Error` に対する conservative bytes fallback は維持する。一方、Deno 経路の
`estimationPath` は成功時に常に `exact_bpe` であり、近似値を生成しない。

## 7. 失敗時の契約

| 条件 | Worker の内部 failure category | 公開結果 | 後続処理 |
| --- | --- | --- | --- |
| 設定不正 | `configuration` | generic 500 | なし |
| timeout | `timeout` | generic 500 | なし |
| 通信失敗 | `network` | generic 500 | なし |
| Deno non-2xx | `upstream_status` | generic 500 | なし |
| JSON / schema 不正 | `malformed_response` | generic 500 | なし |
| token 算術不正 | `arithmetic` | generic 500 | なし |

generic 500 は既存の `type: api_error`、`code: internal_error` を使う。Deno 固有の理由は
クライアント本文、HTTP header、error code に露出しない。Deno failure は
`TokenizerController` または conservative estimation へ切り替えない。

## 8. Observability と監査

既存の `octg.resource_stage` の tokenization event に次の allowlist field を追加する。

- `tokenizationProvider`: `cloudflare_do` または `deno`
- `tokenizationFailureCategory`: configuration、timeout、network、upstream_status、
  malformed_response、arithmetic のいずれか

既存の request ID、revision、`inputTextBytes`、duration、outcome、`quotaReserved`、
`upstreamReached` を維持する。resource event、D1 audit、Deno application log のいずれにも
prompt、authorization、credential、元 request body、任意の exception message を残さない。

## 9. テストと canary

Deno application は Deno native test で次を検証する。

- 認証なし・誤った認証では tokenization されない
- raw `Content-Length` による早期拒否と bounded stream read を検証する
- JSON escape により raw body が増えても、inputText が上限以下なら受理する
- parsed `inputText` の UTF-8 byte length が実効上限と等しい場合は受理し、超過時だけ拒否する
- method、content type、JSON schema の不正を拒否する
- 既知 fixture と 74,000-token 級 fixture の exact BPE count が既存
  `TokenizerController` の count と一致する
- application log に `inputText` または authorization material が出ない

Gateway Worker の Vitest suite は次を検証する。

- 全未設定では既存 `TokenizerController` 経路だけを使う
- 完全設定時の `< threshold`、`== threshold`、`> threshold` の route
- chat completions と responses の両方に同じ route を適用する
- response body を停止した HTTP 200 で timeout が bounded time 内に generic 500 となる
- timeout、network、non-2xx、malformed response、算術失敗で呼出しが一回だけである
- 上記の失敗で fallback、reservation、in-flight admission、upstream がない
- provider、failure category、byte size、duration、quota / upstream flag の観測値
- shared arithmetic と Deno count が既存の quota 計算を変えない
- shared resolver の既定値、無効値 fallback、`MAX_INPUT_TEXT_BYTES` による clamp、threshold の
  有効 / 無効判定、Worker と Deno の resolved value 一致

運用 canary は、実測から threshold、timeout、target concurrency を確定した後に実施する。
74,000-token 級の確認済み payload を target concurrency で流し、Deno success、Cloudflare 側の
`exceededCpu` 不在、quota lifecycle、upstream 到達、OpenAI 互換応答を request ID と revision
で相関して確認する。

## 10. 利用者向け運用文書

README から参照する Deno tokenizer runbook を追加する。runbook には以下を含める。

- Deno Deploy application を Production / Preview ごとに作成し、`deno deploy` または
  Deno Deploy dashboard で `apps/deno-tokenizer` を deployment source とする方法
- `OCTG_TOKENIZER_AUTH_TOKEN` を Deno secret と
  `DENO_TOKENIZER_AUTH_TOKEN` を Cloudflare Worker secret として安全に設定する方法
- endpoint、threshold、timeout、`MAX_INPUT_BYTES` の設定と resolved value の整合性
- Deno disabled、partial / invalid configuration、Deno failure の挙動
- retry / fallback を実施しないこと
- Free plan 前提と、利用枠枯渇・service pause では fail-closed になる保証範囲
- prompt と credential を保存・ログ出力しない設計
- threshold、timeout、target concurrency を profile と canary から決める手順

ロールバック時は、Deno integration より前の Worker revision へ戻してから関連設定を除去する。
設定を一つずつ消して同一 revision を動かすと partial configuration となり、意図どおり
fail-closed になるためである。

## 11. 完了基準

実装は `REQUIREMENTS_2026-08-27.md` の受け入れ条件を満たすことに加え、Deno Deploy Free plan
上の独立した Production / Preview application で再現可能に deployment できなければならない。
具体的な operational value を未計測のまま既定値として固定してはならない。
