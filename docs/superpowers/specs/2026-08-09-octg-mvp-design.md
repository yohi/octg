# OCTG MVP 設計書

**Version:** 1.1
**作成日:** 2026-08-09
**基盤要件:** [REQUIREMENTS.md](../../../REQUIREMENTS.md) v1.0
**スコープ:** Phase 1 (MVP) のみ。Phase 2 / Phase 3 は本書では実装対象外とし、拡張を妨げない設計上の配慮のみ記述する。

---

## 1. 目的と設計原則

OpenAI Data Sharing Program の Tier 3 Complimentary Tokens（STANDARD 1M tokens/日 + MINI 10M tokens/日）を複数クライアント間で一元管理し、意図しない課金を最大限防止する OpenAI 互換 API Gateway を構築する。

REQUIREMENTS.md 第 52 章の 5 原則を継承する：

1. AI Gateway Spend Limit を無料枠カウンターとして信用しない
2. Durable Object で request 前 reservation を行う
3. actual usage で reservation を精算する
4. 不確実な request は消費済みとして扱う（fail-closed）
5. Paid fallback は明示的 opt-in がない限り発生させない

## 2. 確定した意思決定

ブレインストーミングで確定した事項：

| # | 項目 | 決定 |
|---|------|------|
| 1 | 設計スコープ | Phase 1 (MVP) のみ |
| 2 | 言語・ランタイム | TypeScript / Cloudflare Workers (V8) |
| 3 | DO の粒度 | 1 DO / pool / UTC 日（例: `quota:STANDARD:2026-08-09`） |
| 4 | Worker → AI Gateway 接続 | AI Gateway REST API 経由 |
| 5 | クライアント認証 | `Authorization: Bearer octg_sk_*`。Admin API は Cloudflare Access で二重防御 |
| 6 | Tool-use 判定 | `tools` / `tool_choice` 等が存在する場合は一律 PAID_ONLY |
| 7 | リポジトリ構成 | シンプルモノレポ（`apps/gateway-worker`, `durable-objects`, `packages/shared`） |
| 8 | テスト基盤 | Vitest + Miniflare（DO 含む） |

## 3. アーキテクチャ概要

```text
Client (OpenCode / AI Agent / MCP / Apps)
        │  Authorization: Bearer octg_sk_*
        ▼
Cloudflare Worker (OpenAI 互換 API)
        │  認証 → ポリシー解決 → モデル分類 → Tool-use 判定
        │  → トークン推定 → reservation 要求
        ▼
Durable Object: QuotaController (pool × UTC 日)
        │  reserve / settle / markUncertain（単一スレッドで直列化）
        ▼ (permit 後のみ)
Cloudflare AI Gateway (REST)
        │  BYOK + Secrets Store / metadata / cache (opt-in) / Spend Limit (二次防御)
        ▼
OpenAI API (Project A: shared-free, Data Sharing ON)

Worker ──非同期──► D1（監査・履歴・レジストリ・ポリシー・reconciliation）
Cron Trigger ──► Reconciliation（OpenAI Usage API との突合）
```

## 4. QuotaController（Durable Object）設計

### 4.1 インスタンス粒度

DO ID を `quota:{POOL}:{UTC日付}` とする（POOL は `STANDARD` / `MINI`）。

- Worker はリクエスト時点の UTC 日付から対象 DO を解決するため、日次リセットは Cron に依存せず構造的に保証される（要件第 15 章）。
- UTC 0 時境界の同時リクエストは旧日付 DO / 新日付 DO に自然に分かれ、state の混在が起きない（要件第 49 章「Midnight」テストに対応）。
- 過去日の DO はアイドル化して自然淘汰される（保持・削除運用は 4.5 を参照）。

### 4.2 状態

```typescript
interface PoolState {
  utcDay: string;
  limit: number;          // STANDARD=1_000_000 / MINI=10_000_000（設定外部化）
  confirmedTokens: number;
  reservedTokens: number;
  uncertainTokens: number;
  requestCount: number;
  updatedAt: string;
}
```

利用可能量：

```text
remaining = limit - confirmedTokens - reservedTokens - uncertainTokens
```

加えて冪等性と遅延処理のため、DO ストレージに `request_id -> RequestEntry` のマップを保持する。`settled: boolean` のような単一フラグではなく、以下の明示的な状態機械で管理する（要件第 14 章、第 36 章の fail-closed 契約を RPC 再送に対しても成立させるため）。

```typescript
type RequestState = 'reserved' | 'settled' | 'uncertain' | 'reconciled' | 'released';

interface RequestEntry {
  state: RequestState;
  reservedTokens: number;      // reserve 時点の予約量（不変）
  actualTokens?: number;       // settle 確定値
  result?: unknown;            // 各 RPC の最初の成功応答（再送時はカウンターを変更せずこの値を返す）
  createdAt: string;
  updatedAt: string;
}
```

状態遷移（単一スレッド下で直列化。遷移不能な組合せは no-op またはエラーで冪等に扱う）：

```text
(none) --reserve--> reserved --settle--> settled
reserved --markUncertain--> uncertain --settle--> settled  # 消費確定（後述）
uncertain --reconcile--> reconciled                        # confirmed へ確定
uncertain --reconcile--> released                          # 未消費が Usage API で裏付けられた場合のみ解放
reserved --release--> released                             # upstream 到達前と確定的に判明した場合のみ
```

### 4.3 RPC インターフェース（3 つのみ）

1. `reserve(requestId, tokens, upperBoundTokens) -> { ok, remaining, resetAt }`
   - 予約量が remaining 内に収まる場合のみ `reservedTokens += tokens`。
   - pool 利用ポリシー（要件第 28 章）に基づく NORMAL / CAUTION / STRICT 判定もここで行う。STRICT 帯では conservative upper bound（`upperBoundTokens`）が remaining 以下の場合のみ許可。
   - 冪等性: 同一 `requestId` で状態が `reserved` のまま再送された場合はカウンターを再変更せず、保存済みの最初の結果を返す。`ok=false`（容量不足等）で失敗した reserve は状態を残さず、再送は新規として評価する。`reserved` 以外の状態での再送は既存結果を返して no-op。
2. `settle(requestId, actualTokens) -> { ok }`
   - `reserved` から: `reservedTokens -= reserved`, `confirmedTokens += actual`, 状態を `settled` へ。
   - `uncertain` から（Usage API 確定より先に上流 usage が届いた遅延 settle）: `uncertainTokens -= reserved`, `confirmedTokens += actual`, 状態を `settled` へ。**予約量の二重減算はしない**（減算対象は遷移元バケットのみ）。
   - 既に `settled` / `reconciled` / `released` の場合は保存済み結果を返す no-op（二重精算防止、要件第 49 章）。
   - **超過精算（fail-closed）**: `actual > reserved` の場合でも超過分は `confirmedTokens` に正差分として計上する（課金は既に発生しており、カウントから落とす方が危険なため）。超過分を別途「債務」予約として扱う設計は採らない。代わりに、settle 後に `confirmedTokens + reservedTokens + uncertainTokens > limit` であれば、当該 DO（= 当日当該 pool）への以後の `reserve` を全て拒否し、超過額を `requests` / 観測メトリクス（要件第 40 章の `settlement overage`）へ記録する。実装上は `reservedTokens` が負にならないよう `max(0, …)` で防御し、負に遷移させない。
3. `markUncertain(requestId) -> { ok }`
   - 結果不明リクエストを `reserved -> uncertain` へ移動（`reservedTokens -= reserved`, `uncertainTokens += reserved`）。TTL では自動解放しない（要件第 14 章、第 36 章）。
   - 冪等性: 既に `uncertain` の場合は no-op。既に `settled` の場合は、両者が同一の最終 usage を知っているなら保存済み結果を返して no-op とし、異なる usage を主張する競合のみ監査記録のうえ既存状態（`settled`）を維持する。`released` / `reconciled` からの遷移は不可（no-op + 監査）。

いずれの RPC も「同一 requestId の再送では保存済みの元の結果を返し、カウンターを再変更しない」を共通契約とする。

### 4.4 ストレージ

SQLite-backed Durable Object Storage を使用し、read-modify-write をトランザクション内で実行する。DO の単一スレッド実行モデルにより、同一 pool への同時 reservation は構造的に直列化され、oversubscription は発生しない（要件第 42 章 Concurrency）。

### 4.5 過去日 DO のライフサイクル

過去日 DO はアイドル化による自然淘汰に任せず、以下の保持・削除ポリシーで管理する。

- **保持期間**: 当該 UTC 日の翌々日 00:00 UTC まで、request_id マップと uncertain 状態を永続化して保持する。これは Usage API の集計遅延（最大 ~24 時間を想定）と 1 回の reconciliation リトライを吸収するための最低保証であり、`D1 reconciliations` で当該日・pool の突合が完了（uncertain 件数 0）ステータスになった場合は、この期限を待たず早期に削除してよい。
- **削除手順**: Worker / Cron から当該 DO の `finalizeDay()` を呼び、(1) `uncertain` 状態が 0 件であることを確認 → (2) `deleteAll()` で request_id マップと PoolState を消去 → (3) D1 `utc_day × pool` に `deleted` を記録、の順で冪等に実行する。`uncertain` が残っている DO は `deleteAll()` してはならない。
- **削除後の遅延 settle**: 削除済み requestId に対する遅延 `settle` は、当該 DO が存在しないため受理不能となる。日次リセット後の pool は新しい DO に切り替わっているため課金の二重計上リスクはなく、worker は当該 settle を破棄し、D1 `requests.status = 'orphaned'` として記録したうえで成功（no-op）として扱う。**新しい日の quota を過去のリクエストで消費してはならない**。
- **reconciliation の再実行**: reconcile RPC は、`no_state`（削除済み）を「0 トークン」として冪等に扱う。削除後の再 reconcile は前回結果（D1 `reconciliations`）を返して no-op とし、過去日 quota を再変更しない。

## 5. Worker 処理設計

### 5.1 認証

- `Authorization: Bearer octg_sk_*` を検証。D1 `clients.key_hash`（keyed hash）と照合。
- 不一致は `401`。OpenAI API キーはクライアントに一切配布しない（要件第 24 章、第 38 章）。

### 5.2 ポリシー解決とモデル分類

- D1 `client_policies` / `model_registry` を Worker 内で短時間キャッシュ。DB を正とし、設定変更は DB 更新のみで反映する（要件第 44 章）。
- `requested_model` を STANDARD / MINI / NONE に分類。不明モデルは `complimentary = NONE`（Unknown = Paid、要件第 4 章）。MVP デフォルトポリシーは REJECT（要件第 27 章）。

### 5.3 Tool-use 判定

`tools` / `tool_choice` / built-in tool 設定が存在するリクエストは一律 PAID_ONLY とする。無料枠 reservation を行わず、ポリシーが許可しない限り `model_not_allowed` で拒否（要件第 17 章、エラー契約は 5.7）。

### 5.4 トークン推定

要件第 11 章の二段階方式：

- モデル対応 tokenizer で input tokens を推定。**入力正規化**: `/v1/chat/completions` の `max_completion_tokens` は内部の `max_output_tokens` へ変換する。互換入力 `max_tokens` も同様に変換する。`max_tokens` と `max_completion_tokens` の両方が指定された場合は `max_completion_tokens` を優先し、**値が異なる場合は `invalid_request`（400, `param: "max_tokens"`）で拒否**して予約へ進まない。
- 安全マージン（プール残量率で段階化）:
  - `remaining > 20%` : `max(256, estimatedInput * 0.02)`
  - `remaining <= 20%`: `max(512, estimatedInput * 0.05)`
  - `remaining <= 5%` : strict モード（要件第 28 章）
- 予約量 = `estimated_input + max_output_tokens + safety_margin`。
- **非テキスト入力の扱い（MVP）**: `/v1/responses` および `/v1/chat/completions` の予約処理で `input_image`・`input_audio` など非テキストのモダリティを検出した場合、tokenizer 推定が成立しないため**予約前に明示的に拒否**する（エラー契約は 5.7 の `invalid_request` を使用）。将来対応としてモダリティ別の保守的上限を `estimated_input` へ加算する方式を採る場合は、モダリティごとの上限表を本書に追加し、過少計上を防ぐ。
- tokenizer 未知のモデルは UTF-8 バイト数等から保守的上限を使用する。

### 5.5 Output 制御（要件第 12 章）

`推定 input + 要求 output + margin` が remaining を超える場合、ClientPolicy の `outputLimitMode` に従う：

- `REJECT`（デフォルト）: `429`（`complimentary_quota_exceeded`）で拒否。
- `CLAMP`（opt-in）: `candidate = remaining - estimated_input - safety_margin` を計算し、
  - `candidate > 0` の場合のみ `max_output_tokens = candidate` まで縮小して実行する（予約量が正であることを保証）。
  - `candidate <= 0` の場合は CLAMP せず `REJECT` と同じ `429`（`complimentary_quota_exceeded`）で拒否する。`max_output_tokens` が 0 または負のリクエストを上流へ送らない。

### 5.6 Reservation → 上流転送 → Settlement

1. `QuotaController.reserve(request_id, reservation, upperBound)` 成功後にのみ AI Gateway REST へ転送する（BYOK、Project A「shared-free」向け。認証は 7.1）。
2. 上流へ送出する際は、AI Gateway の request handling ヘッダーを以下の既定値で付与する：
   - `cf-aig-request-timeout: 25000`（本リクエストの単一試行タイムアウト。ストリーミングは最初のチャンク受信までをタイムアウト判定とする AI Gateway 側の仕様に従う）
   - `cf-aig-max-attempts: 2`
   - `cf-aig-retry-delay: 1000` / `cf-aig-backoff: exponential`
   - リトライ対象は AI Gateway 側の既定（ネットワークエラーおよび上流 5xx）に限定する。クライアント起因の 4xx（認証・バリデーション等）はリトライしない。
3. レスポンス / ストリームから最終 usage を抽出して `settle(request_id, actual)`。
4. 失敗・クライアント切断・usage 取得不能なら `markUncertain(request_id)`。**設定した全 attempt を使い切った後、または usage を信頼して取得できない場合は必ず `markUncertain`** とする。`release`（予約解放）は、AI Gateway への送信前エラー（例: request 構築失敗、認証前エラー）など、upstream 到達前と確定的に判明する場合に限る（要件第 36 章）。AI Gateway の最終 attempt は完了まで待機する挙動のため、タイムアウト後の成否は不確実として `uncertain` 側に倒す。
5. streaming 中継でも reserve → SSE pass-through → final usage → settle の順序を維持する（要件第 13 章）。

### 5.7 レスポンスとエラー

- 要件第 29 章の `X-OCTG-*` ヘッダを付加（pool, limit, used, remaining, reset, route, request-id）。エラー応答にも、pool 確定後のものについては同じヘッダを付し、`X-OCTG-Quota-Used` は pool 全体の confirmed+reserved+uncertain とする。
- エラーコード（要件第 37 章。OpenAI SDK 互換の `{ error: { message, type, param, code } }` 形式に統一し、`request_id` はトップレベルに付与）:

| 状況 | HTTP | `error.type` / `error.code` | `param` | 補足 |
|------|------|------------------------------|---------|------|
| 無料枠不足 | `429` | `insufficient_quota` / `complimentary_quota_exceeded` | `pool` | body に `pool` / `remaining_tokens` / `reset_at` を含める |
| リクエスト過大 | `413` | `invalid_request_error` / `request_too_large` | `max_tokens` 等 | 予約量が pool limit 自体を超える等 |
| モデル不許可 | `403` | `invalid_request_error` / `model_not_allowed` | `model` | tool-use 拒否を含む |
| 不明モデルで paid 必須 | `403` | `invalid_request_error` / `model_requires_paid` | `model` | complimentary=NONE で paid 非許可の場合 |
| 非テキスト入力（MVP 未対応） | `400` | `invalid_request_error` / `invalid_request` | `input` | 5.4 の予約前拒否 |
| `max_tokens` / `max_completion_tokens` 衝突 | `400` | `invalid_request_error` / `invalid_request` | `max_tokens` | 5.4 の正規化規則 |

いずれのエラーでも `request_id` を応答 body トップレベルと `X-OCTG-Request-Id` ヘッダに含める。
- 監査ログの D1 への非同期書き込みは `ctx.waitUntil()` を用いた fire-and-forget とし、レスポンスレイテンシ目標 p50 < 50ms / p95 < 150ms（要件第 42 章）を阻害しない。**配送保証は best-effort とし、Worker 障害・同時実行制限超過時の監査ログ欠損を許容範囲として明示する**。authoritative な制御は DO が担い、監査は証跡用途に限定する（クォータ判定・課金制御を監査ログ到達に依存させない）。完全な配送保証が必要になった場合は、Cloudflare Queues 等の永続配送経路＋コンシューマでの重複排除（request_id 単位の idempotent upsert）への移行を、要件42章レイテンシ目標の再交渉とセットの設計判断として扱う。

## 6. データ永続化（D1）

D1 は authoritative quota には使用しない（要件第 32 章）。概念スキーマは要件第 33 章に準拠：

- `clients` — id, name, key_hash, enabled, created_at
- `client_policies` — client_id, overflow_mode, output_limit_mode, max_paid_usd_day, cache_enabled
- `model_registry` — model, provider, complimentary_pool, enabled, fallback_model, updated_at
- `requests` — request_id, utc_day, client_id, requested_model, upstream_model, pool, eligibility, reserved_tokens, input/output/total_tokens, status, billing_class, openai_request_id, started_at, completed_at
- `daily_usage` — utc_day, pool, confirmed_tokens, paid_tokens, request_count
- `reconciliations` — utc_day, pool, local_tokens, openai_tokens, difference, executed_at

request body / prompt / response content は D1 に保存しない（要件第 38 章）。

## 7. AI Gateway 連携

- OpenAI BYOK + Secrets Store。AI Gateway は quota の authoritative source としない（要件第 19 章）。

### 7.1 認証と Secret 管理

Worker → AI Gateway および管理系 API の認証は endpoint ごとに専用 Secret を使い分け、`octg_sk_*`（クライアント認証用）や BYOK 保管の OpenAI キーを流用しない。

| 用途 / endpoint | 認証方式 | 専用 Secret | 最小権限 |
|---|---|---|---|
| AI Gateway REST API（`api.cloudflare.com/client/v4/accounts/{id}/ai/v1`） | `Authorization: Bearer <token>` | Cloudflare API token（例: `CLOUDFLARE_AIG_API_TOKEN`）を Workers Secrets に保管 | `AI Gateway Run`（Read を付可、Edit は付与しない） |
| AI Gateway provider-native endpoint（`gateway.ai.cloudflare.com`） | `cf-aig-authorization` ヘッダー | 専用 Secret として分離保管（REST 用と共有しない） | `AI Gateway Run` |
| OpenAI provider キー | AI Gateway BYOK | AI Gateway Secrets Store へ保管（OCTG は値を保持しない。要件第 38 章） | OpenAI 側の project スコープ最小権限 |
| OpenAI Organization Usage API（reconciliation 用） | `Authorization: Bearer <admin key>` | 専用 Secret（例: `OPENAI_USAGE_API_KEY`）を Workers Secrets に保管 | Usage 読み取り用途 |
| `api.cloudflare.com` のその他管理 REST（Spend Limit 確認等） | `Authorization: Bearer <token>` | 上記 AIG token とは別の管理用 token（例: `CLOUDFLARE_MGMT_API_TOKEN`） | 必要な account/gateway read のみ |

ローテーション手順: 各 Secret は (1) 新規トークン発行 → (2) `wrangler secret put` で設定 → (3) デプロイ / 動作確認 → (4) 旧トークン失効、の順で実施する。Worker コード・ログ・`octg_sk_*` の鍵素材にこれらの値を含めない。

BYOK で Secrets Store に保管した OpenAI キーは、AI Gateway によるプロバイダー向け認証だけに使用され、他の認証用途へは転用しない。

- Custom metadata 5 項目を標準付与: `client_id, pool, eligibility, route, request_id`（要件第 23 章。観測・ログ用途に限定し、キャッシュ分離キーや制御ロジックの根拠にはしない）。
- Spend Limit は二次防御（eventually consistent なため authoritative ではない。要件第 20 章）。
- Cache は opt-in。tool 使用・user-specific・session-specific・privacy 敏感リクエストは原則無効。cache key の誤共有を防止する（要件第 41 章）。**キャッシュ分離の根拠として、観測用途のカスタムメタデータ（`cf-aig-metadata`）に依存しない**。有効化する場合は、worker が client / 明示的な session / ユーザーなどの分離単位から `cf-aig-cache-key` を生成して付与する。AI Gateway 既定のキャッシュキー（provider・endpoint・model・プロバイダー認証情報・request body）は、全クライアントが同一の共有 BYOK 経路を通る構成では client 境界を区別しないため、cross-client の誤共有防止にはカスタムキーが必須となる。`cache_enabled` が true のクライアントでも、安定した分離単位を導出できないリクエストでは `cf-aig-skip-cache: true`（またはカスタムキー未付与）としてキャッシュを無効化する。
- Custom cost による仮想 token meter（要件第 21 章）は任意機能。quota 判定には使用しない。

## 8. Reconciliation

### 8.1 方式の決定

OpenAI Organization Usage API（および対応する project スコープの usage 集約）で得られるのは **project × モデル × 時刻帯の集約値**であり、OCTG 内部の `request_id` を直接突合できる粒度ではない。MVP では以下のどちらかの方式を運用として選択できるよう設計する：

- **方式 A（推奨・標準）**: route（`FREE_SHARED` / `PAID_SHARED`）ごとに OpenAI Project / API キーを分離する（要件第 18 章の Project A/B 分離を必須化する）。これにより Usage API の project 単位集約と route が 1:1 で対応し、再現性のある突合が可能となる。
- **方式 B（許容・縮退運用）**: 単一 Project の集約突合に留める。ただし後述の不確実性ルールにより、`uncertain` は**個別に確定できない限り解放しない**（fail-closed 維持）。

### 8.2 実行スケジュールと UTC 境界

- Cron 実行は `05 0 * * *`（00:05 UTC = 09:05 JST。要件第 35 章の表現と一致）に加え、任意で 1 時間毎の補助実行を許可する。対象は **直前に完了した UTC 日**で、JST 表記に依存しない（UTC 日付の切替と独立に計算する）。
- Usage API の集計遅延を吸収するため、対象 UTC 日の範囲に加えて **後続 24 時間分を含む再取得（UTC 境界をまたいだ refetch）** を行い、最大 3 回までリトライ窓を設ける。
- Reconciliation 実行は **冪等**とし、同一 `utc_day × pool × route` への再実行では前回結果（D1 `reconciliations`）を返して再計上しない。DO 側の状態遷移も `settled` → `reconciled`、`uncertain` → `reconciled` / `released` への**単調（一方向）遷移**のみ許可する。後戻り遷移は不可とする。

### 8.3 uncertain の確定ポリシー（fail-closed）

- **解放の条件**: `released` への遷移は、該当 request が実際には無料枠で消費されていないことを Usage API 上で **request に相当する単位で肯定的に裏付けられる場合に限る**（方式 A で project/route 単位の集約が他の証拠と整合する場合の帰納的判断、または将来 OpenAI が request 粒度の usage を提供した場合）。**集約値の一致のみを根拠に uncertain を解放しない**（Usage API の遅延・欠損による見かけ上の一致を信じて解放することを防ぐ）。
- 裏付けが取れない `uncertain` は、4.5 の保持期限まで `uncertain` 状態を維持し、最終的に `reconciled`（confirmed 側）へ確定させて日次 quota を確定する。
- `FREE_SHARED` と `PAID_SHARED` は課金・データ共有ポリシーが異なるため、Usage 突合・`reconciliations` 記録ともに route 単位で分離して扱う。混合集約による見かけ上の整合に依存しない。

## 9. エンドポイント一覧（MVP）

```text
POST /v1/responses          # OpenAI 互換（予約・精算つき）
POST /v1/chat/completions   # OpenAI 互換（同上）
GET  /v1/models             # 互換 endpoint（registry から生成し client policy で絞る）
GET  /quota                 # pool 状態の可視化（要件第 30 章、認証は下記 9.1）
GET  /admin/quota           # 以下 Admin API（Cloudflare Access 必須、要件第 31 章）
GET  /admin/usage
GET  /admin/clients
GET  /admin/models
PUT  /admin/clients/:id/policy
PUT  /admin/models/:model
POST /admin/reconcile
```

`/v1/embeddings`・`/v1/audio/*`・`/v1/images/*` は将来対応（要件第 25 章）。

### 9.1 GET /quota の認証・認可

`GET /quota` は **クライアントキー認証（`Authorization: Bearer octg_sk_*`）を必須**とし、Cloudflare Access は Admin API（`/admin/*`）に限定する（要件第 31 章との一貫性）。Cloudflare Access による二重防御は要件第 31 章で Admin API にのみ求められており、通常クライアントが credentialed に保持するアクセス経路を育てるため、本エンドポイントでは採らない。

- **返却スコープ**: STANDARD / MINI の**全クライアント共通 pool の集約値**（limit / confirmed / reserved / uncertain / remaining / usage_percent）を返す。クライアント個別の利用行跡（per-client の timestamps・model 内約・他クライアント存在の推測可能性）は含めない。per-client 可視化が必要になった場合は、pool 集約とは別の認可スコープ（例: 自分の `requests` 集約のみ）として別途設計する。
- **認可条件**: 有効な client key を持つこと（`clients.enabled = true`）。pool 状態は共有リソースの情報であり、特定クライアントの機密を含まないため、認証済みクライアントであれば参照を許可する。
- **エラー**: 未認証（missing/invalid key）は `401`（`authentication_error` / `invalid_api_key`）、認証済みだが無効化済みクライアントは `403`（`permission_error` / `client_disabled`）。これらの認可ケースを 12 章テスト戦略の必須テストに追加する。

## 10. セキュリティとプライバシー

要件第 38-39 章に準拠：

- OpenAI キーは Secrets Store のみ。ソースコード・クライアントに保存・配布しない。
- Client API key は keyed hash で保存。
- Admin API は Cloudflare Access で分離保護。
- prompt / response content を独自ログ・D1 に保存しない。Usage metadata のみ永続化。
- AI Gateway Persistent Logs の運用（残すかどうか）は別途運用ポリシーとして決定する。
- Rate limiting、key rotation、audit trail を備える。
- route 分類: `FREE_SHARED` / `PAID_SHARED`（明示許可時のみ）/ `PAID_PRIVATE`（Data Sharing OFF の別 Project）。

## 11. 観測性（要件第 40 章）

- Global: STANDARD / MINI 利用率、requests/day、tokens/day、paid tokens、reject 数、uncertain tokens
- Client: requests、tokens、models、free/paid 比率
- Model: requests、input/output tokens、平均リクエストサイズ、quota 寄与
- Error: OpenAI 4xx/5xx、AI Gateway 障害、reservation / settlement 失敗、reconciliation 差異

## 12. テスト戦略

- 基盤: Vitest + Miniflare（Workers / DO / D1 をローカル再現）。
- 必須テスト（要件第 49 章）:
  - Quota 境界: `999,000 used + 2,000 reservation -> reject`、`950,000 used + 40,000 reservation -> permit`
  - Concurrent: `remaining=50k` で A/B が各 40k reserve -> 片方のみ permit
  - Settlement: `reserve 40k, actual 25k -> confirmed += 25k, reserved -= 40k`
  - Duplicate settlement: 同一 request の 2 回 settle は 1 回分のみ加算
  - Unknown model を Complimentary と判定しない
  - Tool-use リクエストを Complimentary Pool に入れない
  - Network failure: OpenAI 到達不明の reservation が消えない（uncertain 化）
  - Midnight: UTC 日替わり同時リクエストで前日/翌日 state が混在しない
  - reserve RPC 再送: 同一 `requestId` で再送した場合、最初の応答を返し `reservedTokens` を二重加算しない
  - settle 超過: `actual > reserved` の場合に `reservedTokens` が負とならず、pool 合計が limit を超過した場合は以後の reserve が拒否される
  - markUncertain 後の settle: `uncertain` からの settle では予約量の二重減算が発生しない
  - CLAMP 境界: `remaining <= estimated_input + safety_margin` の場合は CLAMP せず 429 で拒否され、`max_output_tokens <= 0` のリクエストが上流へ送出されない
  - 非テキスト入力: `input_image` / `input_audio` を含むリクエストが予約前に 400 で拒否される
  - GET /quota 認可: 未認証 401、無効化クライアント 403、認証済みクライアントは pool 集約のみ参照できること

## 13. ディレクトリ構成（モノレポ）

```text
octg/
├── apps/
│   └── gateway-worker/      # Worker エントリ、wrangler.jsonc
├── durable-objects/
│   └── quota-controller/    # QuotaController DO
├── packages/
│   └── shared/              # 型定義、モデル分類、推定ロジック等の共有コード
├── db/
│   ├── migrations/
│   └── schema.sql
├── config/                  # モデルレジストリ初期データ・デフォルトポリシー
└── tests/                   # quota / routing / streaming / integration
```

## 14. Acceptance Criteria 対応（要件第 50 章）

| AC | 実現手段 |
|----|---------|
| AC-01 base_url 変更のみで利用可 | OpenAI 互換 endpoint を Worker が提供 |
| AC-02 STANDARD/MINI 独立管理 | pool × 日の DO 分離 |
| AC-03 並列 request で quota 非超過 | DO 単一スレッド直列化 + reserve 前判定 |
| AC-04 actual usage で settlement | レスポンス usage 抽出 → settle RPC |
| AC-05 usage 不明は fail-closed | markUncertain + TTL 非解放 |
| AC-06 UTC 0 時で quota が切り替わる | DO ID に UTC 日付を含有 |
| AC-07 quota API | `GET /quota` |
| AC-08 超過時デフォルト non-call | REJECT デフォルト（要件第 27 章） |
| AC-09 Paid fallback は明示 opt-in | overflow_mode デフォルト REJECT |
| AC-10 OpenAI Key 非公開 | BYOK + Secrets Store、Client は octg_sk_* |
| AC-11 AI Gateway 観測 | custom metadata 5 項目 |
| AC-12 reconciliation | Cron + OpenAI Usage API 突合 |

## 15. 既知の限界

要件第 43 章の通り、課金 0 円の完全保証はしない。conservative reservation + fail-closed + OpenAI reconciliation の三重防御を採用する。
