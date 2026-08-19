# OCTG Tokenizer Durable Object 導入 要件定義書

# 1. 文書概要

### 1.1 目的

本要件定義は、OCTG（OpenAI Complimentary Token Gateway）において確認された Cloudflare Workers
Error 1102 を解消するため、現在 Gateway Worker 内で実行している BPE tokenization を専用 Durable
Object（以下 `TokenizerController`）へ移管するための要件を定義する。

本変更では以下を同時に満たすことを必須とする。

1. **Cloudflare Workers Free Plan を維持する**
2. **OpenAI 無料枠の厳密な quota 制御を維持する**
3. **既存の Reservation / Settlement / Fail-Closed 設計を変更しない**
4. **大規模入力でも exact BPE tokenization を原則維持する**
5. **Tokenizer障害時に有料リクエストへ流出しない**
6. **既存OpenAI互換APIの外部仕様を変更しない**

---

# 2. 背景

## 2.1 確認された障害

約74,000 token級の `/v1/responses` リクエストにおいて、Cloudflare Worker
が以下のエラーで終了する事象が確認された。

```text
Worker exceeded CPU time limit.
Error 1102
```

Cloudflare Observability の同一 invocation / request ID を相関した結果、処理順序は以下であった。

```text
body_read
  └─ finish success

parse
  └─ finish success

normalize
  └─ finish success

quota_get_state
  └─ finish success

tokenize
  └─ start

[ Worker exceeded CPU time limit ]

tokenize
  └─ finish なし

quota_reserve
  └─ 未到達

upstream
  └─ 未到達
```

したがって、今回の1102については、

> **Gateway Worker の `tokenize` stage 内で CPU limit を超過した**

ことを原因として確定する。

現行実装では `tokenize` stage 内で `estimateInputTokens()` を実行しており、その中で `js-tiktoken` の
`o200k_base` encoding を用いている。

現行 Gateway は token estimation 後に safety margin、output upper bound を算出し、その後初めて
QuotaController の `reserve()` を呼び出す。

したがって tokenization を別実行環境へ移しても、

```text
estimate
→ reserve
→ upstream
→ settle / markUncertain
```

という OCTG の基本契約を維持できる。

---

# 3. 技術的前提

Cloudflare の現行仕様では SQLite-backed Durable Objects の CPU time は **1 request
あたりデフォルト30秒**であり、Workers Free Plan でも SQLite-backed Durable Objects を利用できる。

また、compatibility date `2024-04-03` 以降では Durable Object の public method を Worker
から RPC として直接呼び出せる。OCTG の compatibility date は既に `2026-08-01` であるため、本方式を利用可能である。

Workers Free Plan における Durable Objects の無料枠は現時点で以下である。

* 100,000 requests/day
* 13,000 GB-s/day
* 超過時はその種類の追加処理が失敗する
* Free Plan の quota は 00:00 UTC にリセットされる

OCTG の用途では、Free枠を超過した場合も **有料フォールバックせず fail-closed** とする。

---

# 4. 変更の基本方針

## 4.1 Target Architecture

```text
Client
  │
  ▼
Cloudflare Gateway Worker
  │
  ├─ Authentication
  ├─ Body Read
  ├─ JSON Parse
  ├─ Normalize
  ├─ Model / Policy Resolution
  ├─ Quota getState
  │
  │
  │ RPC
  ▼
TokenizerController Durable Object
  │
  ├─ o200k_base initialization
  ├─ exact BPE encode
  └─ input token estimation
  │
  ▼
Gateway Worker
  │
  ├─ Safety Margin
  ├─ Output Decision
  └─ Reservation Amount Calculation
  │
  ▼
QuotaController Durable Object
  │
  └─ atomic reserve
  │
  ▼ permit
Cloudflare AI Gateway
  │
  ▼
OpenAI API
  │
  ▼
actual usage
  │
  ▼
QuotaController
  └─ settle / markUncertain
```

---

# 5. コア設計原則

## DP-01. QuotaController と TokenizerController を分離する

`TokenizerController` は、

> CPU-intensive な token estimation

のみを担当する。

既存 `QuotaController` は引き続き、

> quota の authoritative state

のみを担当する。

TokenizerController から QuotaController を直接呼び出してはならない。

---

## DP-02. Tokenizer 成功前に reservation を行わない

必ず、

```text
normalize
→ TokenizerController
→ token result
→ quota calculation
→ reserve
```

の順序とする。

以下は禁止する。

```text
reserve
→ tokenize
```

これにより TokenizerController 障害時に不要な reservation を残さない。

---

## DP-03. Tokenizer 障害は Fail-Closed とする

以下の場合、

* RPC failure
* Durable Object CPU limit exceeded
* Durable Object unavailable
* invalid response
* tokenizer internal exception
* malformed result

Gateway Worker は、

```text
quota reserve: しない
upstream: 呼ばない
paid fallback: しない
```

を保証する。

---

## DP-04. Gateway Worker で exact BPE を実行しない

production path では、

```ts
encoding.encode(...)
```

を Gateway Worker から直接実行してはならない。

これを静的に分離できる構成とする。

---

## DP-05. TokenizerDO に入力内容を永続化しない

TokenizerController は、

* prompt
* messages
* input text
* API key
* client secret

を Durable Object Storage、D1、Logs 等に保存してはならない。

TokenizerController は **compute-only Durable Object** とする。

---

# 6. 機能要件

## FR-01. TokenizerController の新設

以下を新規作成する。

```text
durable-objects/
└── tokenizer-controller/
    ├── package.json
    ├── tsconfig.json
    ├── src/
    │   └── tokenizer-controller.ts
    └── test/
```

ルートリポジトリは既に `durable-objects/*` を npm workspace
として認識する構成になっているため、新規workspaceとして追加可能である。

既存 `quota-controller` workspace の構成を基本形として踏襲する。

---

# 7. Tokenizer RPC

## FR-02. RPC Interface

TokenizerController は以下相当の public RPC method を公開する。

```ts
interface TokenizeRequest {
  requestId: string;
  inputText: string;
  messageCount: number;
  opaqueInputBytes: number;
}

interface TokenizeResult {
  estimatedInputTokens: number;
  estimationPath: "exact_bpe" | "conservative_bytes";
}

class TokenizerController extends DurableObject {
  async estimate(request: TokenizeRequest): Promise<TokenizeResult>;
}
```

RPC引数には quota、client policy、API key 等を含めない。

---

# 8. Token estimation

## FR-03. 現行 semantics の維持

正常系では現在の計算方式と同一結果を返すこと。

概念上、

```text
BPE(inputText)
+ opaqueInputBytes
+ message overhead
```

を計算する。

既存実装との互換性を維持するため、通常パスでは現行 `o200k_base` を利用する。

---

## FR-04. Encoding の lazy initialization

TokenizerController は encoding を request 毎に無条件再生成してはならない。

概念実装：

```ts
private encoding?: Tiktoken;

private getEncoding(): Tiktoken {
  this.encoding ??= getEncoding("o200k_base");
  return this.encoding;
}
```

Durable Object instance が生存している間は encoding instance を再利用する。

DO eviction 後の再初期化は許容する。

---

## FR-05. Conservative fallback

`getEncoding()` または `encode()` が通常のJavaScript例外を返した場合、現行実装との安全性互換を維持するため、明示的な
conservative fallback を利用可能とする。

結果には必ず、

```text
estimationPath = conservative_bytes
```

を設定する。

BPE成功時は、

```text
estimationPath = exact_bpe
```

とする。

**CPU limitによるDO強制終了など RPC 自体が成立しないケースでは fallback を Gateway Worker 側で実行しない。**

その場合は fail-closed とする。

---

# 9. Gateway Worker integration

## FR-06. Tokenizer binding

Gateway Worker の `Env` に以下を追加する。

```ts
readonly TOKENIZER_CONTROLLER:
  DurableObjectNamespace<TokenizerController>;
```

現在の Gateway Worker は `QuotaController` を同一Workerからexportし、Durable Object
bindingとして利用している。

同じパターンで `TokenizerController` をexportする。

---

## FR-07. Durable Object migration

既存 migration を変更してはならない。

新しい migration を追加する。

概念例：

```json
{
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["QuotaController"]
    },
    {
      "tag": "v2",
      "new_sqlite_classes": ["TokenizerController"]
    }
  ]
}
```

Workers FreeではSQLite-backed Durable Objectsが必要となる。

---

# 10. Object identity

## FR-08. MVP は single tokenizer object とする

初期実装では、

```text
tokenizer:primary
```

という固定logical objectを利用する。

Gateway Worker は全tokenization requestについて同一 TokenizerController を取得する。

概念例：

```ts
env.TOKENIZER_CONTROLLER.get(
  env.TOKENIZER_CONTROLLER.idFromName("tokenizer:primary")
);
```

### 理由

MVPでは、

* tokenization の並列実行を抑制
* CPU負荷の予測容易性
* sharding競合の排除
* 実装複雑性の削減

を優先する。

---

## FR-09. Sharding は初期スコープ外

以下は本変更では実装しない。

```text
tokenizer:0
tokenizer:1
tokenizer:2
...
```

ただし将来の拡張を阻害しないよう、

```ts
tokenizerIdOf(...)
```

等のobject ID決定処理を1か所に集約することが望ましい。

---

# 11. Gateway処理フロー

## FR-10. 新しい request flow

処理順序を以下とする。

```text
authenticate
↓
body_read
↓
parse
↓
normalize
↓
model classification
↓
policy
↓
quota_get_state
↓
tokenizer_rpc
↓
safetyMargin
↓
upperBound
↓
output decision
↓
quota_reserve
↓
in-flight admission
↓
upstream
↓
settle / markUncertain / release
```

QuotaController の既存 lifecycle は変更しない。

---

# 12. Fail-Closed behavior

## FR-11. Tokenizer RPC failure

Tokenizer RPC が成功しなかった場合、

```text
HTTP request
    ↓
Tokenizer failure
    ↓
internal / service unavailable response
```

とし、

```text
quotaReserved = false
upstreamReached = false
```

を保証する。

---

## FR-12. Local BPE fallback 禁止

以下は禁止する。

```text
TokenizerDO failure
    ↓
Gateway Workerでjs-tiktoken
    ↓
1102再発
```

---

## FR-13. Upstream fallback 禁止

以下も禁止する。

```text
TokenizerDO failure
    ↓
token数不明
    ↓
とりあえずOpenAIへ送信
```

Tokenizer failure は必ず upstream 未到達で終了する。

---

# 13. Observability

## FR-14. Gateway stage

既存 `octg.resource_stage` を維持する。現在のstage型には既に `tokenize` および `estimationPath`
が定義されている。

変更後は、

```text
tokenize start
↓
TokenizerDO RPC
↓
tokenize finish
```

とする。

`finish` には最低限以下を記録する。

```json
{
  "event": "octg.resource_stage",
  "stage": "tokenize",
  "phase": "finish",
  "outcome": "success",
  "estimationPath": "exact_bpe"
}
```

---

## FR-15. TokenizerDO内部stage

TokenizerController 内部でも以下を観測可能にする。

```text
tokenizer_init start
tokenizer_init finish

tokenizer_encode start
tokenizer_encode finish
```

イベント例：

```json
{
  "event": "octg.tokenizer_stage",
  "requestId": "...",
  "stage": "tokenizer_encode",
  "phase": "finish",
  "durationMs": 123
}
```

これにより将来、

```text
getEncoding
```

と

```text
encoding.encode
```

のCPU負荷を分離できるようにする。

---

## FR-16. ログ禁止情報

以下をログへ出力してはならない。

* inputText
* prompt
* message content
* request body
* Authorization header
* API key
* raw tokenizer output
* tokenizer対象文字列

ログ可能なのは、

* requestId
* revisionId
* phase
* duration
* byte count
* token count
* estimationPath
* success / failure category

等の非機密metadataのみとする。

---

# 14. Dependency isolation

## FR-17. js-tiktoken の責務移動

現在 `@octg/shared` が `js-tiktoken` に依存している。

本変更では原則として、

```text
@octg/shared
```

から exact BPE 実行責務を除去し、

```text
@octg/tokenizer-controller
```

へ移す。

目標依存関係：

```text
@octg/shared
    └─ types / normalize / quota arithmetic
    └─ (js-tiktoken を依存から除去する)

@octg/tokenizer-controller
    └─ js-tiktoken
    └─ @octg/shared には依存しない
        (必要な型のみを含む contracts-only package を新設する場合は別途検討)

gateway-worker
    ├─ @octg/shared
    ├─ @octg/quota-controller
    └─ @octg/tokenizer-controller
```

`packages/shared/src/index.ts` は現在 `estimate.ts` をre-exportしているため、BPE処理とquota
arithmeticを分離する。

例えば、

```text
estimate.ts
    safetyMargin()
    upperBoundOf()
    decideOutput()

tokenizer-controller
    exact token estimation
```

とする。

---

# 15. Security / Privacy

## NFR-01. 入力の非永続化

TokenizerController は storage API を application data の保存に使用しない。

SQLite-backed DO として登録するが、

> SQLiteをtokenizer cacheやprompt storageとして使用してはならない。

---

## NFR-02. 外部endpointを持たない

TokenizerController は Client から直接呼び出せない。

アクセス経路は、

```text
Gateway Worker
→ Durable Object binding
```

のみに限定する。

Durable Objects は Worker binding を介してアクセスする設計がCloudflareの標準方式である。

---

# 16. Cost requirements

## NFR-03. Workers Free 維持

本変更を理由として Workers Paid Plan を必須としてはならない。

---

## NFR-04. DO Free quota超過時

Durable Object Free quota を使い切った場合、

```text
Tokenizer RPC failure
↓
Fail Closed
```

とする。

以下は禁止する。

```text
Free DO quota exceeded
↓
有料環境へfallback
```

Free Planではfree-tier上限超過後の該当処理は失敗するため、この性質を0円防壁として利用する。

---

## NFR-05. RPC call数

通常のOpenAI requestあたり、

```text
TokenizerController RPC = 原則1回
```

とする。

不要な複数回tokenizationを行わない。

---

# 17. Performance requirements

## NFR-06. Gateway CPU isolation

74k-token級 accepted fixture において、

```text
Gateway Worker:
$workers.outcome != exceededCpu
```

を必須とする。

---

## NFR-07. Tokenizer completion

同fixtureについて、

```text
tokenize start
tokenize finish
```

が同一request IDで確認できること。

---

## NFR-08. Existing input size limits

既存 `MAX_INPUT_BYTES` 等のinput validationを迂回しない。

現在 Gateway Worker は parse / normalize を Tokenization より前に実施しているため、この順序を維持する。

---

# 18. Error semantics

Tokenizer関連障害について、OpenAI互換error responseを追加することを推奨する。

概念例：

```json
{
  "error": {
    "message": "Token estimation service unavailable.",
    "type": "server_error",
    "code": "tokenizer_unavailable"
  },
  "request_id": "req_..."
}
```

HTTP status は、

```text
503 Service Unavailable
```

を推奨する。

ただし既存 `errInternal()` とのAPI互換性を優先する場合は、初期実装では既存内部エラーを使用してもよい。

**いずれの場合もquota/upstream semanticsを変更してはならない。**

---

# 19. テスト要件

## T-01. Token estimation parity

旧 `estimateInputTokens()` と TokenizerController の結果が同じであることをfixtureで確認する。

対象：

* empty string
* ASCII
* 日本語
* emoji
* source code
* JSON
* long English text
* long Japanese text
* mixed Unicode
* opaque input
* multiple messages

---

## T-02. 74k-token regression fixture

今回1102を再現したものと同等規模のfixtureを用意する。

production payloadそのものをrepositoryへ保存してはならない。

synthetic / sanitized fixtureを利用する。

---

## T-03. Fail-Closed test

Tokenizer RPCを故意に失敗させ、

```text
reserve calls = 0
upstream calls = 0
```

であることを検証する。

---

## T-04. Invalid Tokenizer result

例えば、

```text
NaN
negative
unsafe integer
missing field
```

等を返した場合に、

```text
reserve = 0
upstream = 0
```

となることを検証する。

---

## T-05. DO CPU failure simulation

TokenizerController failureをmockし、

Gatewayがlocal BPEへfallbackしないことを検証する。

---

## T-06. Quota lifecycle regression

以下既存behaviorが変更されていないこと。

```text
reserve success
→ upstream success
→ settle

reserve success
→ upstream uncertain
→ markUncertain

known pre-upstream failure
→ release

reserve failure
→ upstream未到達
```

---

# 20. Canary requirements

production deploy 後、既存の worker resource limits canary を利用して検証する。

現在のトラブルシュート文書では、74k-token級payloadについて concurrency
1、2、operator指定peakでのcanary検証を要求している。

今回も同じ基準を使用する。

実行条件：

```text
concurrency = 1
concurrency = 2
concurrency = expected peak
```

---

# 21. Acceptance Criteria

以下を**すべて**満たした場合に本変更を完了とする。

## AC-01

74k-token級fixtureが Gateway Worker で Error 1102 を発生させない。

## AC-02

Gateway invocation に、

```text
exceededCpu
```

が存在しない。

### AC-03

同一request IDについて、

```text
tokenize start
tokenize finish
```

の双方が存在する。

### AC-04

TokenizerController 内で、

```text
tokenizer_encode start
tokenizer_encode finish
```

が確認できる。

### AC-05

tokenization成功後にのみ、

```text
quota_reserve
```

へ到達する。

### AC-06

reservation成功後にのみ upstream OpenAI request が発生する。

### AC-07

OpenAI success時に actual usage で `settle()` される。

### AC-08

Tokenizer failure時、

```text
quota reserve = 0
upstream call = 0
```

となる。

### AC-09

既存の Fail-Closed / markUncertain semantics に変更がない。

### AC-10

ログへprompt / payload / API keyが保存されない。

### AC-11

concurrency 1 / 2 / expected peak のcanaryを通過する。

### AC-12

```bash
npm test
npm run typecheck
```

が成功する。

### AC-13

Workers Free Plan のままproduction canaryを完了できる。

---

# 22. 想定変更ファイル

最低限、以下の変更を想定する。

```text
durable-objects/
└── tokenizer-controller/
    ├── package.json                 NEW
    ├── tsconfig.json                NEW
    ├── src/
    │   └── tokenizer-controller.ts  NEW
    └── test/
        └── ...                      NEW

apps/gateway-worker/
├── src/
│   ├── index.ts                     MODIFY
│   ├── proxy.ts                     MODIFY
│   ├── tokenizer.ts                 NEW
│   └── resource-observation.ts      MODIFY
├── test/
│   └── ...                          MODIFY / NEW
└── wrangler.jsonc                   MODIFY

packages/shared/
├── package.json                     MODIFY
└── src/
    ├── estimate.ts                  MODIFY
    └── index.ts                     MODIFY

docs/
└── troubleshooting-503-worker-resource-limits.md
                                     MODIFY

README.md                            MODIFY
package-lock.json                    MODIFY
```

---

# 23. 実装タスク

## Phase 1 — Tokenizer package

1. `@octg/tokenizer-controller` workspace作成
2. `js-tiktoken` 依存移動
3. `TokenizerController` 実装
4. RPC request / response validation実装
5. exact BPE実装
6. explicit conservative fallback実装
7. unit test実装

---

## Phase 2 — Gateway integration

1. TokenizerController export追加
2. Env binding追加
3. Wrangler Durable Object binding追加
4. `v2` SQLite migration追加
5. Tokenizer RPC client追加
6. `proxy.ts` のlocal tokenization削除
7. Fail-Closed error handling追加

---

## Phase 3 — Observability

1. Gateway `tokenize start/finish`維持
2. `estimationPath`記録
3. Tokenizer `init` stage追加
4. Tokenizer `encode` stage追加
5. safe byte/token metadata追加
6. payload非記録確認

---

## Phase 4 — Regression

1. existing unit tests
2. tokenizer parity tests
3. quota lifecycle tests
4. RPC failure tests
5. large input tests
6. concurrency tests

---

## Phase 5 — Production Canary

1. revision ID取得
2. 74k-token級fixture実行
3. concurrency 1
4. concurrency 2
5. expected peak
6. Gateway CPU outcome確認
7. Tokenizer stage確認
8. reserve確認
9. upstream確認
10. settle確認

---

# 24. Rollback

問題発生時に旧 local BPE へ自動 fallback してはならない。

rollback は **deployment 単位** で行う。v2 Durable Object 移行と TokenizerDO 機能の有効化は分離する。

1. まず、TokenizerController クラス・migration・binding を含むが TokenizerDO 呼び出しを無効化した **v2
互換 revision** をデプロイする。
2. 検証後、TokenizerDO 呼び出しを有効化した **v2 機能有効 revision** をデプロイする。

TokenizerDO 有効化後に問題が発生した場合の rollback 先は、同じ v2 互換 revision である。pre-v2 の旧 revision
へ rollback すると今回確認済みの 1102 問題が再発するため、それは最後の手段（emergency measure）に限る。

v2 デプロイそのものが失敗した場合（例: `v2` migration の適用失敗、`TokenizerController`
クラスの登録失敗、または v2 互換 revision 自体が正常にデプロイできない場合）、
rollback 先が存在しないため **forward-fix** を行う。

forward-fix の手順:

1. 影響を受けた Worker / Durable Object のエラーログを収集し、失敗カテゴリーを特定する。
2. 既存の `v1` revision（TokenizerDO 未搭載）が稼働中であることを確認し、
   既存トラフィックへの影響を監視する。必要に応じて `v1` revision への緊急 rollback を検討する。
3. `v2` migration または `TokenizerController` 実装の修正を行い、
   ローカルおよびステージング環境で `npm test` と `npm run typecheck` が成功することを確認する。
4. 修正版を **新しい deployment** として再デプロイする。同じ `v2` migration tag を
   書き換えず、必要に応じて `v3` 以降の migration tag として追加修正を適用する。
5. デプロイ後、canary トラフィックで `TokenizerController` の RPC 呼び出しと
   quota lifecycle が正常であることを検証する。

詳細な対応フロー、連絡先、escalation 条件は
`docs/runbooks/incident-v2-deployment-failure.md` を参照する。

---

# 25. 本変更の対象外

以下は別Issue / 別要件とする。

* modelごとのtokenizer最適化
* tokenizer sharding
* tokenizer result cache
* prompt hash cache
* D1 token cache
* Workers Paid移行
* Deno等への移植
* OpenAI Usage API reconciliation変更
* QuotaController redesign
* AI Gateway Spend Limit変更
* paid fallback実装
* quota upper-boundアルゴリズムそのものの再設計

特に、

> 「現在のtoken estimationがOpenAI actual usageに対する数学的hard upper boundになっているか」

という問題は重要だが、**今回の1102対策とは分離して扱う。**

本変更の目的は、

> **既存token estimation semanticsを維持したまま、そのCPU-intensive部分をGateway
Workerから隔離すること**

である。

---

# 26. 完了後のTarget State

最終的に以下の状態を成立させる。

```text
                  OCTG Gateway Worker
                  ───────────────────
Client ─────────► auth
                  parse
                  normalize
                     │
                     │ internal RPC
                     ▼
             ┌──────────────────┐
             │ Tokenizer DO     │
             │                  │
             │ exact BPE        │
             │ o200k_base       │
             │ CPU isolation    │
             └────────┬─────────┘
                      │
                estimated tokens
                      │
                      ▼
             OCTG Gateway Worker
                      │
             margin / upper bound
                      │
                      ▼
             ┌──────────────────┐
             │ QuotaController  │
             │                  │
             │ authoritative    │
             │ atomic reserve   │
             └────────┬─────────┘
                      │ permit only
                      ▼
                AI Gateway
                      │
                      ▼
                   OpenAI
                      │
                  actual usage
                      │
                      ▼
               settle / uncertain
```

この構成により、

**「Gateway Workerの10ms CPU制約」**

と、

**「厳密なquota admission control」**

を分離する。

OCTG の中核である、

> **Reservation → Settlement → Fail-Closed → No Paid Fallback**

は一切弱めず、tokenizationだけをCPU余裕の大きいDurable Objectへ移管する。

これを本変更の最終アーキテクチャとする。
