# OCTG MVP 設計書

**Version:** 1.0
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
- 過去日の DO はアイドル化して自然淘汰される。

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

加えて冪等性のため `request_id -> { reservedTokens: number, settled: boolean }` のマップを DO ストレージに保持する。

### 4.3 RPC インターフェース（3 つのみ）

1. `reserve(requestId, tokens) -> { ok, remaining, resetAt }`
   - 予約量が remaining 内に収まる場合のみ `reservedTokens += tokens`。
   - pool 利用ポリシー（要件第 28 章）に基づく NORMAL / CAUTION / STRICT 判定もここで行う。STRICT 帯では conservative upper bound が remaining 以下の場合のみ許可。
2. `settle(requestId, actualTokens) -> { ok }`
   - `reservedTokens -= reserved`, `confirmedTokens += actual`。
   - 同一 `requestId` が settle 済みなら no-op（二重精算防止、要件第 49 章）。
3. `markUncertain(requestId) -> { ok }`
   - 結果不明リクエストを `reserved -> uncertain` へ移動。TTL では自動解放しない（要件第 14 章、第 36 章）。

### 4.4 ストレージ

SQLite-backed Durable Object Storage を使用し、read-modify-write をトランザクション内で実行する。DO の単一スレッド実行モデルにより、同一 pool への同時 reservation は構造的に直列化され、oversubscription は発生しない（要件第 42 章 Concurrency）。

## 5. Worker 処理設計

### 5.1 認証

- `Authorization: Bearer octg_sk_*` を検証。D1 `clients.key_hash`（keyed hash）と照合。
- 不一致は `401`。OpenAI API キーはクライアントに一切配布しない（要件第 24 章、第 38 章）。

### 5.2 ポリシー解決とモデル分類

- D1 `client_policies` / `model_registry` を Worker 内で短時間キャッシュ。DB を正とし、設定変更は DB 更新のみで反映する（要件第 44 章）。
- `requested_model` を STANDARD / MINI / NONE に分類。不明モデルは `complimentary = NONE`（Unknown = Paid、要件第 4 章）。MVP デフォルトポリシーは REJECT（要件第 27 章）。

### 5.3 Tool-use 判定

`tools` / `tool_choice` / built-in tool 設定が存在するリクエストは一律 PAID_ONLY とする。無料枠 reservation を行わず、ポリシーが許可しない限り拒否（要件第 17 章）。

### 5.4 トークン推定

要件第 11 章の二段階方式：

- モデル対応 tokenizer で input tokens を推定。
- 安全マージン（プール残量率で段階化）:
  - `remaining > 20%` : `max(256, estimatedInput * 0.02)`
  - `remaining <= 20%`: `max(512, estimatedInput * 0.05)`
  - `remaining <= 5%` : strict モード（要件第 28 章）
- 予約量 = `estimated_input + max_output_tokens + safety_margin`
- tokenizer 未知のモデルは UTF-8 バイト数等から保守的上限を使用する。

### 5.5 Output 制御（要件第 12 章）

`推定 input + 要求 output + margin` が remaining を超える場合、ClientPolicy の `outputLimitMode` に従う：

- `REJECT`（デフォルト）: `429` で拒否。
- `CLAMP`（opt-in）: `max_output_tokens = remaining - estimated_input - safety_margin` まで縮小して実行。

### 5.6 Reservation → 上流転送 → Settlement

1. `QuotaController.reserve()` 成功後にのみ AI Gateway REST へ転送（BYOK、Project A「shared-free」向け）。
2. レスポンス / ストリームから最終 usage を抽出して `settle(request_id, actual)`。
3. 失敗・クライアント切断・usage 取得不能なら `markUncertain(request_id)`。upstream 到達前と確実に判明する場合のみ reservation を解放する（要件第 36 章）。
4. streaming 中継でも reserve → SSE pass-through → final usage → settle の順序を維持する（要件第 13 章）。

### 5.7 レスポンスとエラー

- 要件第 29 章の `X-OCTG-*` ヘッダを付加（pool, limit, used, remaining, reset, route, request-id）。
- エラーコード（要件第 37 章、SDK 互換性を考慮して最終確定）:

| 状況 | HTTP / 形式 |
|------|-------------|
| 無料枠不足 | `429` + `complimentary_quota_exceeded`（pool, remaining_tokens, reset_at） |
| リクエスト過大 | `413` / `422` |
| モデル不許可 | `403` |
| 不明モデルで paid 必須 | `402` / `403` |

- 監査ログを D1 へ非同期書き込み（伝播は fire-and-forget とし、レスポンスレイテンシ目標 p50 < 50ms / p95 < 150ms を阻害しない。要件第 42 章）。

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
- Custom metadata 5 項目を標準付与: `client_id, pool, eligibility, route, request_id`（要件第 23 章）。
- Spend Limit は二次防御（eventually consistent なため authoritative ではない。要件第 20 章）。
- Cache は opt-in。tool 使用・user-specific・session-specific・privacy 敏感リクエストは原則無効。cache key の誤共有を防止する（要件第 41 章）。
- Custom cost による仮想 token meter（要件第 21 章）は任意機能。quota 判定には使用しない。

## 8. Reconciliation

- Cron Trigger で 09:05 JST に前日分を確定（任意で 1 時間毎、要件第 35 章）。
- OpenAI Organization Usage API から usage を取得し、Cloudflare 側集計（`confirmed` + `uncertain`）と突合。
- 閾値超過時は D1 `reconciliations` に記録して警告。
- Usage API は集計遅延があり得るため real-time quota 制御には使用しない。
- 前日 DO の `uncertain` は reconciliation 結果に基づき confirmed / 解放へ確定させる（fail-closed の出口、要件第 14 章）。

## 9. エンドポイント一覧（MVP）

```text
POST /v1/responses          # OpenAI 互換（予約・精算つき）
POST /v1/chat/completions   # OpenAI 互換（同上）
GET  /v1/models             # 互換 endpoint（registry から生成し client policy で絞る）
GET  /quota                 # pool 状態の可視化（要件第 30 章）
GET  /admin/quota           # 以下 Admin API（Cloudflare Access 必須、要件第 31 章）
GET  /admin/usage
GET  /admin/clients
GET  /admin/models
PUT  /admin/clients/:id/policy
PUT  /admin/models/:model
POST /admin/reconcile
```

`/v1/embeddings`・`/v1/audio/*`・`/v1/images/*` は将来対応（要件第 25 章）。

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
