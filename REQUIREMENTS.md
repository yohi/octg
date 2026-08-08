# OpenAI Complimentary Token Gateway（OCTG）要件定義書

**Version:** 1.0
**作成日:** 2026-08-09
**対象環境:** Cloudflare Workers / Durable Objects / D1 / AI Gateway / OpenAI API
**OpenAI Usage Tier:** Tier 3

---

# 1. 概要

## 1.1 目的

OpenAI API の Data Sharing Program により提供される Tier 3 向け Complimentary Tokens を最大限利用しながら、意図しない通常課金を可能な限り防止する OpenAI 互換 API Gateway を構築する。

本システムを OpenAI API への共通入口とし、OpenCode、自作 AI Agent、MCP 関連ツール、各種アプリケーション等から直接 OpenAI API Key を使用する必要をなくす。

主目的は以下とする。

1. Tier 3 Complimentary Tokens の利用最大化
2. 無料枠超過による意図しない課金の抑制
3. 複数クライアント間での日次無料枠の一元管理
4. OpenAI API 互換性の維持
5. 利用量・モデル・クライアント別の可視化
6. 無料枠終了時の明示的な fallback 制御
7. OpenAI API Key の集中管理
8. 将来的な Anthropic / Gemini / Workers AI 等への拡張

---

# 2. OpenAI Complimentary Tokens の前提

Tier 3〜5 では、対象モデルが2つの独立した日次プールに分かれる。

| Pool               |           Tier 3 日次上限 |
| ------------------ | --------------------: |
| STANDARD / 1M Pool |  1,000,000 tokens/day |
| MINI / 10M Pool    | 10,000,000 tokens/day |

input tokens と output tokens の合計で消費する。

現在の主な対象モデルは以下。

### STANDARD_POOL

* `gpt-5.6-sol`
* `gpt-5.5-2026-04-23`
* `gpt-5.4-2026-03-05`
* `gpt-5.2-2025-12-11`
* `gpt-5.1-*`
* `gpt-5-*`
* `gpt-4.1-2025-04-14`
* `gpt-4o-*`
* `o3-2025-04-16`
* 対象となる o1 系

### MINI_POOL

* `gpt-5.6-terra`
* `gpt-5.6-luna`
* `gpt-5.4-mini-2026-03-17`
* `gpt-5.4-nano-2026-03-17`
* `gpt-5.1-codex-mini`
* `gpt-5-mini-2025-08-07`
* `gpt-5-nano-2025-08-07`
* `gpt-4.1-mini-2025-04-14`
* `gpt-4.1-nano-2025-04-14`
* `gpt-4o-mini-2024-07-18`
* `o4-mini-2025-04-16`
* `codex-mini-latest`

正確な対象モデルは OpenAI が変更できるため、コードへの固定実装ではなく Model Registry による設定管理とする。

OpenAI は対象モデル、Tier 3〜5 の 1M/10M 枠、input/output の合算、00:00 UTCの日次リセットを公式に定めている。日本時間では毎日09:00に相当する。

---

# 3. 最重要課金ルール

OpenAI は各リクエスト開始時にその日の累積トークン数を確認する。

例えば、

```text
現在使用量       975,000
次のrequest       30,000
-------------------------
合計           1,005,000
```

の場合、

```text
超過 5,000 tokens のみ課金
```

ではなく、

```text
30,000 tokens のリクエスト全体が課金
```

となる。

したがって本システムでは、

> 「使った後に上限を確認する」

のではなく、

> 「リクエスト送信前に、そのリクエストが無料枠内に収まることを予約する」

方式を必須とする。

OpenAI自身が、1リクエストによって日次上限を超える場合にはそのリクエスト全体を通常料金で課金すると明記している。

---

# 4. Complimentary Token 対象外

少なくとも以下は無料枠として計上しない。

* Fine-tuned model
* Fine-tuning training
* Evals
* Tool use
* Model Registry で対象確認できないモデル
* Data Sharing が有効ではない OpenAI Project の通信

OpenAI は fine-tuned models、fine-tuning、evals、tool use を Complimentary Tokens 対象外としている。

不明なリクエストを無料枠として扱うことは禁止する。

原則：

```text
Unknown = Paid
```

とする。

---

# 5. システムアーキテクチャ

```text
OpenCode
Claude/OpenAI SDK clients
MCP
AI Agents
Custom Applications
        │
        │ OpenAI-compatible API
        ▼
┌───────────────────────────┐
│ Cloudflare Worker         │
│ api.example.com/v1        │
│                           │
│ Authentication            │
│ Request normalization     │
│ Model classification      │
│ Tool-use detection        │
│ Token estimation          │
│ Routing policy            │
└────────────┬──────────────┘
             │
             ▼
┌───────────────────────────┐
│ Durable Object            │
│ QuotaController           │
│                           │
│ STANDARD 1,000,000/day    │
│ MINI    10,000,000/day    │
│                           │
│ reservation               │
│ settlement                │
│ concurrency control       │
└────────────┬──────────────┘
             │ permit
             ▼
┌───────────────────────────┐
│ Cloudflare AI Gateway     │
│                           │
│ OpenAI BYOK               │
│ Logs                      │
│ Analytics                 │
│ Metadata                  │
│ Caching                   │
│ Spend Limits              │
│ Dynamic Routing           │
└────────────┬──────────────┘
             │
             ▼
┌───────────────────────────┐
│ OpenAI                    │
│                           │
│ Project: shared-free      │
│ Data Sharing = ON         │
└───────────────────────────┘


Worker / Durable Object
        │
        └──────────────► D1
                         │
                         ├─ usage history
                         ├─ applications
                         ├─ model registry
                         ├─ policies
                         └─ reconciliation
```

Cloudflare AI Gateway は OpenAI の BYOK をサポートし、provider key を Secrets Store に保存できる。

---

# 6. コンポーネント責務

## 6.1 Cloudflare Worker

Worker は外部クライアントから見える唯一の API Endpoint とする。

主な責務：

* Client Authentication
* OpenAI API compatibility
* Request validation
* Model normalization
* Model Pool 判定
* Complimentary eligibility 判定
* Tool-use 判定
* Token usage 上限推定
* Durable Object への reservation 要求
* AI Gateway への proxy
* Streaming relay
* usage extraction
* Durable Object settlement
* response header 付加
* D1への非同期履歴保存

Worker 自身は無料枠カウンターの authoritative state を保持してはならない。

---

# 7. Durable Object / QuotaController

## 7.1 役割

無料枠管理の唯一の authoritative source とする。

Cloudflare Durable Objects は、同一 Object が stateful coordination を行える単一スレッドの実行モデルを持ち、SQLite-backed Durable Object Storage は transactional かつ strongly consistent である。

そのため複数AI Agentから同時にリクエストされた場合でも、

```text
Agent A ─┐
Agent B ─┼─► QuotaController
Agent C ─┘
```

として無料枠の競合を防止する。

---

# 8. Quota State

各 UTC 日について最低限以下を保持する。

```typescript
interface PoolState {
    utcDay: string;

    limit: number;

    confirmedTokens: number;

    reservedTokens: number;

    uncertainTokens: number;

    requestCount: number;

    updatedAt: string;
}
```

Tier 3 初期設定：

```text
STANDARD.limit = 1_000_000
MINI.limit     = 10_000_000
```

利用可能量：

```text
remaining =
    limit
    - confirmedTokens
    - reservedTokens
    - uncertainTokens
```

---

# 9. Reservation / Settlement

本システムの中心機能とする。

## 9.1 Reservation

OpenAIへ送信する前に、

```text
estimated_input
+
maximum_possible_output
+
safety_margin
```

を予約する。

例：

```text
STANDARD

confirmed = 850,000
reserved  =       0
remaining = 150,000

request:

estimated input = 20,000
max output      = 30,000
safety margin   =  2,000

reservation     = 52,000
```

予約成功後：

```text
confirmed = 850,000
reserved  =  52,000
remaining =  98,000
```

その後に限り OpenAIへ送信する。

---

# 10. Settlement

OpenAI レスポンスから実 usage を取得する。

例：

```json
{
  "input_tokens": 18320,
  "output_tokens": 11420
}
```

実消費：

```text
29,740
```

であれば、

```text
reserved  -= 52,000
confirmed += 29,740
```

とする。

結果：

```text
confirmed = 879,740
reserved  = 0
```

reservation と settlement は `request_id` により idempotent とする。

---

# 11. Token Estimation

OpenAI が最終的に算出する token 数を Cloudflare 側で完全に保証することはできない。

したがって estimation は二段階とする。

### 通常時

model 対応 tokenizer を使用して input tokens を推定。

### 境界付近

より保守的な safety margin を追加する。

例：

```text
remaining > 20%:
    safety = max(256, estimatedInput * 0.02)

remaining <= 20%:
    safety = max(512, estimatedInput * 0.05)

remaining <= 5%:
    strict mode
```

モデル tokenizer の仕様が未知の場合、

```text
request UTF-8 bytes
```

等から十分に保守的な上限値を使用する。

---

# 12. Output Token 制御

無料枠境界で `max_output_tokens` が大きすぎる場合に対応する。

例えば、

```text
remaining        = 40,000
estimated_input  = 15,000
requested output = 40,000
```

の場合、そのまま実行してはならない。

Client Policy に応じて以下のいずれかを実施する。

### CLAMP

```text
max_output_tokens
=
remaining
- estimated_input
- safety_margin
```

まで自動縮小。

### REJECT

リクエストを `429` で拒否。

### FALLBACK

10M Pool 等の別モデルへ変更。

デフォルトは `REJECT` とする。

クライアント要求を暗黙的に変更する CLAMP/FALLBACK は opt-in とする。

---

# 13. Streaming 対応

以下を対応対象とする。

* `/v1/responses`
* `/v1/chat/completions`
* streaming responses

Streaming の場合でも、

```text
reserve
    ↓
OpenAI request
    ↓
SSE pass-through
    ↓
final usage取得
    ↓
settle
```

を行う。

クライアント切断時でも、すでに upstream request が OpenAI に到達している場合は課金が発生する可能性があるため、単純に reservation を解放してはならない。

---

# 14. Uncertain Reservation

以下の場合、

```text
reservation → release
```

としてはならない。

* OpenAI送信後の network error
* Worker runtime 異常終了
* streaming途中切断
* usage情報取得失敗
* AI Gateway response parse failure

この場合：

```text
reserved
    ↓
uncertain
```

へ移動する。

```text
confirmed = 800k
uncertain = 80k

effective usage = 880k
```

として fail-closed で処理する。

OpenAI Usage API による reconciliation または日次リセットまで予約を保持する。

---

# 15. 日次リセット

OpenAI の日次 quota は

```text
00:00 UTC
```

でリセットされる。

日本時間：

```text
09:00 JST
```

QuotaController は Cron だけに依存してはならない。

各 reservation 実行時に、

```text
currentUtcDay != storedUtcDay
```

を確認し、自動的に新しい日へ rollover する。

これにより Cron 障害による quota 未リセットを防止する。

---

# 16. Model Registry

対象モデルをコードへ直接ハードコードしない。

最低限以下を管理する。

```typescript
interface ModelDefinition {
    model: string;

    provider: "openai";

    complimentary:
        | "STANDARD"
        | "MINI"
        | "NONE";

    toolEligible: boolean;

    enabled: boolean;

    fallbackModel?: string;

    updatedAt: string;
}
```

不明モデル：

```text
complimentary = NONE
```

として扱う。

OpenAI の対象モデル変更時に Worker の本体コードを変更せず更新できること。

---

# 17. Tool Use 判定

OpenAI は Tool use を無料枠の対象外としている。

したがって Responses / Chat Completions request に、

```text
tools
tool_choice
built-in tool configuration
```

等の対象機能が存在する場合、保守的に

```text
PAID_ONLY
```

として扱うモードを用意する。

より詳細な OpenAI の課金仕様が確認できる場合は、後から判定ロジックを細分化できる設計とする。

---

# 18. OpenAI Project 分離

推奨構成として OpenAI Project を2つ用意する。

## Project A

```text
openai-shared-free
```

設定：

```text
Data Sharing = ON
```

用途：

* Complimentary Token 対象 inference

---

## Project B

```text
openai-private-paid
```

設定：

```text
Data Sharing = OFF
```

用途：

* Tool use
* Complimentary 非対象モデル
* 無料枠超過後の paid fallback
* private traffic

これにより、

```text
無料枠対象なので共有する通信
```

と

```text
無料メリットがないので共有しない通信
```

を明確に分離できる。

これは必須要件ではなく推奨構成とする。

---

# 19. Cloudflare AI Gateway

AI Gateway は quota の authoritative source としない。

役割を以下に限定する。

* OpenAI BYOK
* Secrets Store
* Request logging
* Analytics
* Cost visibility
* Custom metadata
* Cache
* Secondary Spend Limit
* Optional Dynamic Routing
* Provider abstraction

Cloudflare AI Gateway は OpenAI provider 用の `/chat/completions` および `/responses` endpoint を持つため、OpenAI APIとの統合が可能。

---

# 20. AI Gateway Spend Limits

Spend Limits は二重防御として使用可能とする。

ただし authoritative quota として使用してはならない。

理由：

Cloudflare Spend Limits は request 完了後の cost を集計し、**eventually consistent** であるため、並列リクエストによって短時間 limit を超える可能性がある。Cloudflare自身がこの制約を明記している。

したがって、

```text
Durable Object
    ↓
primary hard guard

AI Gateway Spend Limit
    ↓
secondary guard
```

とする。

---

# 21. Custom Cost による仮想 Token Meter

任意機能として利用可能。

Cloudflare AI Gateway は `cf-aig-custom-cost` により input/output の token 単価を request 単位で上書きできる。

例えば STANDARD：

```text
$0.000001 / token
```

と設定すると、

```text
1,000,000 tokens = virtual $1
```

MINI：

```text
$0.0000001 / token
```

なら、

```text
10,000,000 tokens = virtual $1
```

となる。

これを AI Gateway の可視化・二重防御として使用できる。

ただし quota 判定には使用しない。

---

# 22. Dynamic Routing

Cloudflare AI Gateway は conditional routing、rate/budget limits、fallback models 等を Dynamic Routes として設定できる。

本システムでは以下に限定して使用可能。

```text
paid overflow
        ↓
OpenAI mini
        ↓
Workers AI
        ↓
other provider
```

無料枠残量判定そのものは Durable Object で行う。

---

# 23. Custom Metadata

AI Gateway に以下を付加する。

```text
client_id
pool
eligibility
route
request_id
```

Cloudflare AI Gateway は1 requestあたり最大5個の custom metadata を保存できるため、この5項目を標準とする。

---

# 24. Client Authentication

利用者へ OpenAI API Key を渡さない。

クライアント専用キーを発行する。

例：

```text
octg_sk_xxxxxxxxxxxxx
```

クライアント：

```bash
OPENAI_BASE_URL=https://ai.example.com/v1
OPENAI_API_KEY=octg_sk_xxxxxxxxx
```

Worker が認証後、OpenAI の実キーを持つ AI Gateway へ転送する。

Client key は plaintext で D1 に保存しない。

保存する場合は hash / keyed hash とする。

---

# 25. OpenAI Compatibility

最低限以下を提供する。

```text
POST /v1/responses
POST /v1/chat/completions
GET  /v1/models
```

将来対応：

```text
/v1/embeddings
/v1/audio/*
/v1/images/*
```

ただし Complimentary Token Controller の対象とするのは公式に対象確認できる endpoint のみとする。

---

# 26. Client Policy

クライアント単位で以下を設定可能とする。

```typescript
interface ClientPolicy {
    clientId: string;

    allowedModels: string[];

    overflowMode:
        | "REJECT"
        | "FALLBACK_MINI"
        | "PAID_SHARED"
        | "PAID_PRIVATE"
        | "WORKERS_AI";

    outputLimitMode:
        | "REJECT"
        | "CLAMP";

    maxPaidUsdPerDay: number;

    cacheEnabled: boolean;
}
```

---

# 27. 推奨デフォルトポリシー

安全性重視のデフォルト：

```text
overflowMode     = REJECT
outputLimitMode  = REJECT
maxPaidUsdPerDay = 0
```

つまり、

> 無料枠を超える可能性がある場合は実行しない

を標準動作とする。

Paid fallback は明示的な opt-in を必須とする。

---

# 28. Pool 使用ポリシー

## STANDARD

```text
0〜80%
    NORMAL

80〜95%
    CAUTION

95〜100%
    STRICT
```

### NORMAL

通常 reservation。

### CAUTION

safety margin 増加。

大規模 request に warning。

### STRICT

最大出力を含む conservative upper bound が remaining 以下の場合だけ permit。

---

## MINI

同様に：

```text
0〜90%   NORMAL
90〜98%  CAUTION
98〜100% STRICT
```

MINI は10Mあるため STANDARD より余裕を持つ。

---

# 29. Response Headers

クライアントへ以下を返す。

```text
X-OCTG-Pool
X-OCTG-Quota-Limit
X-OCTG-Quota-Used
X-OCTG-Quota-Remaining
X-OCTG-Quota-Reset
X-OCTG-Route
X-OCTG-Request-Id
```

例：

```text
X-OCTG-Pool: standard
X-OCTG-Quota-Limit: 1000000
X-OCTG-Quota-Used: 742351
X-OCTG-Quota-Remaining: 257649
X-OCTG-Quota-Reset: 2026-08-10T00:00:00Z
```

---

# 30. Quota API

ユーザーが状態確認できる endpoint を用意する。

```text
GET /quota
```

例：

```json
{
  "utc_day": "2026-08-09",
  "reset_at": "2026-08-10T00:00:00Z",
  "pools": {
    "standard": {
      "limit": 1000000,
      "confirmed": 742351,
      "reserved": 48000,
      "uncertain": 0,
      "remaining": 209649,
      "usage_percent": 79.04
    },
    "mini": {
      "limit": 10000000,
      "confirmed": 4283551,
      "reserved": 120000,
      "uncertain": 0,
      "remaining": 5596449,
      "usage_percent": 44.04
    }
  }
}
```

---

# 31. Admin API

最低限：

```text
GET /admin/quota
GET /admin/usage
GET /admin/clients
GET /admin/models

PUT /admin/clients/:id/policy
PUT /admin/models/:model

POST /admin/reconcile
```

Admin API は Cloudflare Access 等による追加認証を必須とする。

---

# 32. D1

D1 は authoritative quota management には使用しない。

用途：

* audit
* usage history
* aggregation
* client configuration
* model registry
* routing policy
* reconciliation history

---

# 33. D1 Schema

概念スキーマ：

```text
clients
-------
id
name
key_hash
enabled
created_at


client_policies
---------------
client_id
overflow_mode
output_limit_mode
max_paid_usd_day
cache_enabled


model_registry
--------------
model
provider
complimentary_pool
enabled
fallback_model
updated_at


requests
--------
request_id
utc_day
client_id
requested_model
upstream_model
pool
eligibility
reserved_tokens
input_tokens
output_tokens
total_tokens
status
billing_class
openai_request_id
started_at
completed_at


daily_usage
-----------
utc_day
pool
confirmed_tokens
paid_tokens
request_count


reconciliations
---------------
utc_day
pool
local_tokens
openai_tokens
difference
executed_at
```

---

# 34. OpenAI Usage Reconciliation

Cloudflare側集計だけを永久に信用してはならない。

OpenAI は Organization Usage API を提供しており、completions usage について input/output tokens、model、project、service tier 等の情報を取得できる。

OpenAI Dashboard では Complimentary Token が

```text
data sharing incentive tier
```

として確認できる。

したがって reconciliation job を実装する。

---

# 35. Reconciliation Policy

最低限：

```text
09:05 JST
    前日分確定

任意:
    1時間ごと
```

比較：

```text
Cloudflare confirmed usage
        vs
OpenAI actual usage
```

差分：

```text
abs(diff) > threshold
```

の場合ログ・警告する。

real-time quota control では OpenAI Usage API を使用しない。

Usage API の集計には遅延があり得るため、reconciliation 専用とする。

---

# 36. Failure Policy

基本原則：

```text
不明なら無料枠を消費済みとして扱う
```

つまり fail-closed。

### AI Gateway timeout

upstream 送信前と確定できる：

```text
release reservation
```

送信済みか不明：

```text
uncertain
```

### OpenAI 5xx

usage確定不能：

```text
uncertain
```

### Worker exception

reservation TTL だけで自動 release しない。

reconciliation まで uncertain とする。

---

# 37. エラーコード

### 無料枠不足

HTTP:

```text
429
```

Body:

```json
{
  "error": {
    "type": "complimentary_quota_exceeded",
    "pool": "standard",
    "remaining_tokens": 12500,
    "reset_at": "2026-08-10T00:00:00Z"
  }
}
```

### Request too large

```text
413 / 422
```

### Model not allowed

```text
403
```

### Unknown model requiring paid mode

```text
402 / 403
```

実装上は API SDK 互換性を考慮して最終決定する。

---

# 38. Security

以下を必須とする。

* OpenAI Key をクライアントへ配布しない
* OpenAI Key をソースコードへ保存しない
* BYOK / Secrets Store 使用
* Client API key の hash 保存
* Admin API 分離
* Cloudflare Access 使用可能
* request body を D1へ保存しない
* prompt / response content を独自ログへ保存しない
* Usage metadata のみ永続化
* Rate limiting
* key rotation
* audit trail

AI Gateway の Persistent Logs に prompt/response を残すかは別途設定可能な運用ポリシーとする。

---

# 39. Privacy Classification

各 route を最低限以下に分類する。

```text
FREE_SHARED
PAID_SHARED
PAID_PRIVATE
```

### FREE_SHARED

Data Sharing ON。

### PAID_SHARED

ユーザーが明示的に許可した場合のみ。

### PAID_PRIVATE

Data Sharing OFF の別 OpenAI Project。

これによりコスト管理とデータ共有ポリシーを分離する。

---

# 40. Observability

最低限以下を計測する。

### Global

* STANDARD utilization %
* MINI utilization %
* requests/day
* tokens/day
* paid tokens
* rejected requests
* uncertain tokens

### Client

* requests
* tokens
* models
* free/paid ratio

### Model

* requests
* input tokens
* output tokens
* average request size
* quota contribution

### Error

* OpenAI 4xx
* OpenAI 5xx
* AI Gateway failure
* reservation failure
* settlement failure
* reconciliation discrepancy

---

# 41. Caching

AI Gateway Cache は optional とする。

同一 request を cache から返せれば OpenAIへの request 自体を削減でき、Complimentary Token の節約になる。

ただし以下は原則 cache 無効：

* user-specific context
* dynamic data
* tool calls
* session-specific response
* privacy-sensitive request

cache key の誤共有を絶対に防止する。

---

# 42. 非機能要件

## Availability

Gateway自身の障害によって OpenAI API Key が直接必要になる構成を避ける。

## Performance

quota reservation による追加 latency を最小化する。

目標：

```text
Worker + DO overhead
p50 < 50 ms
p95 < 150 ms
```

OpenAI provider latency は除外。

## Concurrency

同一 quota pool に対する同時 reservation で oversubscription が起きないこと。

## Consistency

quota state は strongly consistent な Durable Object を使用する。

## Idempotency

同一 `request_id` の二重 settlement により token 数が二重計上されないこと。

---

# 43. Complimentary Token の「完全保証」に関する制約

本システムは、

```text
意図しない課金を可能な限り防ぐ
```

ことを目的とする。

ただし、

```text
課金が絶対に0円になること
```

は保証しない。

理由：

* 最終 token 数を決定するのは OpenAI
* eligibility を決定するのも OpenAI
* OpenAI が制度を変更可能
* tokenizer/accounting 差異
* network failure 時の不確実性
* API仕様変更

そのため、

```text
conservative reservation
+
fail closed
+
OpenAI reconciliation
```

の三重防御を採用する。

---

# 44. OpenAI Program 変更への対応

OpenAI は Complimentary Tokens program を終了する場合30日前に通知するとしている。

以下を設定値として外部化する。

```text
tier
pool limits
eligible models
reset time
eligibility rules
tool eligibility
```

OpenAIの制度変更によってアプリケーション本体を書き換えなくてもよい設計とする。

---

# 45. MVP

Phase 1 では以下のみ実装する。

### API

```text
/v1/responses
/v1/chat/completions
/v1/models
/quota
```

### Pool

```text
STANDARD
MINI
PAID
```

### Components

```text
Worker
Durable Object
D1
AI Gateway
Secrets Store
```

### Functions

* Authentication
* model classification
* reservation
* settlement
* streaming
* quota status
* request history
* AI Gateway BYOK
* OpenAI reconciliation

---

# 46. Phase 2

追加：

* Admin Web UI
* usage graphs
* client management
* model registry editor
* fallback policy editor
* alerting
* Workers AI fallback
* Anthropic fallback
* Gemini fallback
* per-agent budget
* cost optimization routing

---

# 47. Phase 3

将来的には、

```text
Universal AI Gateway
```

として発展可能とする。

```text
                    ┌─ OpenAI free
                    │
Client ─► Gateway ──┼─ OpenAI paid
                    │
                    ├─ Anthropic
                    │
                    ├─ Gemini
                    │
                    └─ Workers AI
```

判断材料：

```text
quality
cost
free quota remaining
privacy
latency
availability
task type
```

---

# 48. 推奨リポジトリ構成

```text
octg/
├── apps/
│   └── gateway-worker/
│
├── src/
│   ├── api/
│   │   ├── responses.ts
│   │   ├── chat-completions.ts
│   │   ├── models.ts
│   │   └── quota.ts
│   │
│   ├── auth/
│   ├── routing/
│   ├── eligibility/
│   ├── tokenizer/
│   ├── ai-gateway/
│   └── usage/
│
├── durable-objects/
│   └── quota-controller.ts
│
├── db/
│   ├── migrations/
│   └── schema.sql
│
├── config/
│   ├── models.json
│   └── defaults.json
│
├── tests/
│   ├── quota/
│   ├── routing/
│   ├── streaming/
│   └── integration/
│
├── wrangler.jsonc
└── README.md
```

---

# 49. 必須テスト

## Quota

```text
999,000 used
+ 2,000 reservation
→ reject
```

```text
950,000 used
+ 40,000 reservation
→ permit
```

## Concurrent

```text
remaining = 50k

Agent A reserve 40k
Agent B reserve 40k
```

結果：

```text
片方だけ permit
```

であること。

## Settlement

```text
reserve 40k
actual 25k
```

結果：

```text
confirmed += 25k
reserved -= 40k
```

## Duplicate settlement

同じ request を2回 settle しても1回分しか加算されない。

## Unknown

unknown model を Complimentary と判定しない。

## Tool

tool request を Complimentary Pool に入れない。

## Network failure

OpenAIへの到達状況が不明なら reservation が消えない。

## Midnight

UTC日付切替時の同時requestで前日/翌日の state が混在しない。

---

# 50. Acceptance Criteria

MVP完成条件を以下とする。

### AC-01

OpenAI SDK の `base_url` を変更するだけで利用できる。

### AC-02

STANDARD と MINI を独立して管理できる。

### AC-03

複数 client の並列 request でも予約量が quota を超えない。

### AC-04

OpenAI response の actual usage で settlement される。

### AC-05

usage 不明 request は fail-closed となる。

### AC-06

UTC 00:00 に日次 quota が正しく切り替わる。

### AC-07

quota 状態を API から確認できる。

### AC-08

無料枠超過時、デフォルトでは有料APIを呼び出さない。

### AC-09

Paid fallback は明示的設定なしには有効にならない。

### AC-10

OpenAI API Key は client に公開されない。

### AC-11

AI Gateway で client / pool / request 単位の観測ができる。

### AC-12

OpenAI Usage と Cloudflare側集計を reconciliation できる。

---

# 51. 最終採用アーキテクチャ

本システムでは以下を正式方針とする。

```text
Cloudflare Worker
    │
    ├─ OpenAI compatibility
    ├─ Authentication
    ├─ Eligibility
    ├─ Token estimation
    └─ Routing
          │
          ▼
Durable Object
    │
    ├─ STANDARD 1M
    ├─ MINI 10M
    ├─ Reservation
    ├─ Settlement
    └─ Concurrency control
          │
          ▼
Cloudflare AI Gateway
    │
    ├─ BYOK
    ├─ Secrets Store
    ├─ Analytics
    ├─ Metadata
    ├─ Cache
    └─ Spend Limit
          │
          ▼
OpenAI API

D1
    │
    ├─ History
    ├─ Model Registry
    ├─ Client Policy
    └─ Reconciliation
```

---

# 52. 設計原則

最も重要な原則は以下の5点とする。

**1. AI Gateway Spend Limit を無料枠カウンターとして信用しない。**

**2. Durable Object で request 前 reservation を行う。**

**3. actual usage で reservation を精算する。**

**4. 不確実な request は消費済みとして扱う。**

**5. Paid fallback は明示的 opt-in がない限り絶対に発生させない。**

この構成により、

```text
Tier 3 の

STANDARD 1M/day
+
MINI 10M/day
```

を、複数アプリケーションから共有する「日次 token budget」として扱えるようにする。
