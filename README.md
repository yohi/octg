# OCTG — OpenAI Complimentary Token Gateway

OpenAI Data Sharing Program (Tier 3) の無料枠を複数クライアントで共有するための OpenAI 互換 API Gateway。Cloudflare Workers + Durable Objects + D1 で構成される。

詳細設計は [SPEC.md](./SPEC.md) を参照。

[![Use this template](https://img.shields.io/badge/Use%20this%20template-yohi/octg-blue)](https://github.com/yohi/octg/generate)

## アーキテクチャ概要

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

### 設計原則

1. AI Gateway Spend Limit を無料枠カウンターとして信用しない
2. Durable Object で request 前 reservation を行う
3. actual usage で reservation を精算する
4. 不確実な request は消費済みとして扱う（fail-closed）
5. Paid fallback は明示的 opt-in がない限り発生させない

## テンプレートから新規作成

本リポジトリは [Template repository](https://docs.github.com/ja/repositories/creating-and-managing-repositories/creating-a-template-repository) として公開しています。`git clone` せずに、以下の手順で独自の Gateway インスタンスを構築できます。

1. 上部の **Use this template** バッジ（または [Generate from template](https://github.com/yohi/octg/generate)）をクリックします。
2. 新しいリポジトリ名・所有者・可視性を入力し、**Create repository from template** をクリックします。
3. 生成されたリポジトリをローカルに展開（`git clone <your-new-repo>` または GitHub Codespaces）します。
4. 以下のセットアップ手順に沿って `npm install` 以降を実施してください。
5. Cloudflare リソース（D1・AI Gateway・Access）の作成と Secret 設定は [docs/DEPLOY_FROM_TEMPLATE.md](./docs/DEPLOY_FROM_TEMPLATE.md) を参照してください。

> Template repository の留意点: フォークと異なり upstream との同期は自動で行われません。本リポジトリ側で修正が入った場合は、必要に応じて手動で取り込みます。

---

## セットアップ（インストール）

本リポジトリは npm workspaces で構成されています。Cloudflare Workers 向けのため、`wrangler` が各 workspace の devDependency として同梱されています（別途グローバルインストール不要）。

### 前提条件

- **Node.js** `>= 20`（`engines` 参照）
- **npm** `>= 10`（Node.js 20 同梱版で動作確認）
- **Cloudflare アカウント**（デプロイ・D1・Durable Objects・AI Gateway を利用する場合）
- ローカル開発のみであれば Cloudflare アカウントは不要（`wrangler dev` のローカルモードで動作）

### 1. リポジトリの取得

```bash
git clone <repo-url> octg
cd octg
```

### 2. 依存関係のインストール

ルートで一度実行すると、全 workspace（`apps/*`, `durable-objects/*`, `packages/*`）の依存関係が揃います。`wrangler`・`vitest`・`typescript` などもここでインストールされます。

```bash
npm install
```

> **Tip:** `engines` で Node.js 20+ を要求しています。`.nvmrc` 等の管理を推奨します。`node -v` でバージョンを確認してください。

### 3. ローカル環境変数の準備（任意・ローカル開発時）

`apps/gateway-worker/.dev.vars` に Secrets のローカル値を置きます。本番の `wrangler secret` とは別物で、`wrangler dev` 時のみ参照されます。

```bash
cd apps/gateway-worker
cat > .dev.vars <<'EOF'
OCTG_KEY_PEPPER=dev-pepper
OCTG_UPSTREAM_BASE_URL=https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>
OCTG_UPSTREAM_API_TOKEN=dev-token
OPENAI_USAGE_API_KEY=dev-usage-key
EOF
```

`.dev.vars` は `.gitignore` 対象です（ Secrets の値を commit しないこと）。

### 4. ローカル D1 のマイグレーション

`wrangler dev` は初回起動時にローカル D1 を自動作成しますが、スキーマを明示的に当てる場合は以下を実行します。

```bash
npx wrangler d1 migrations apply octg --local --config apps/gateway-worker/wrangler.jsonc
```

### 5. ローカル用クライアント鍵の発行

クライアントキーは keyed hash で D1 に保存します。`scripts/seed-client.mjs` が `INSERT` 文を生成するので、ローカル D1 に流してください。

```bash
OCTG_KEY_PEPPER=dev-pepper node scripts/seed-client.mjs client_demo Demo octg_sk_xxx > /tmp/octg-seed.sql
npx wrangler d1 execute octg --local --file /tmp/octg-seed.sql --config apps/gateway-worker/wrangler.jsonc
```

### 6. 動作確認

```bash
npm run typecheck   # 全 workspace の型検査
npm test            # 全 workspace のユニットテスト (Vitest + @cloudflare/vitest-pool-workers)
npm run dev -w apps/gateway-worker   # ローカルで Worker 起動 (http://localhost:8787)
```

ここまででローカル開発環境の準備は完了です。本番デプロイ手順は [§ デプロイ前の必須プロビジョニング](#デプロイ前の必須プロビジョニング手動) を参照してください。

---

## 開発

セットアップ済みの環境での日次開発コマンド:

```bash
npm test            # 全ワークスペース (Vitest + @cloudflare/vitest-pool-workers)
npm run typecheck
npm run dev -w apps/gateway-worker   # ローカルで Worker 起動
```

初回の環境構築手順は [§ セットアップ（インストール）](#セットアップインストール) を参照してください。

## デプロイ前の必須プロビジョニング（手動）

1. `wrangler d1 create octg` → 発行された `database_id` を `apps/gateway-worker/wrangler.jsonc` に設定する。
2. AI Gateway を作成し、OpenAI Project A（shared-free, Data Sharing ON）の API キーを **BYOK + Secrets Store** に登録する。OCTG のコード・クライアントには OpenAI キーを配布しない。
3. AI Gateway の Spend Limit を無料枠と同額に設定する（二次防御。authoritative ではない）。
4. `wrangler.jsonc` の vars を実値に差し替える: `OCTG_UPSTREAM_BASE_URL`（アカウント ID 込み）、`ACCESS_TEAM_DOMAIN` / `ACCESS_AUD`（Admin API 用 Cloudflare Access アプリケーション）。
5. Secrets を設定する:
   - `npx wrangler secret put OCTG_KEY_PEPPER --config apps/gateway-worker/wrangler.jsonc` — クライアントキーの keyed hash 用 pepper
   - `npx wrangler secret put OCTG_UPSTREAM_API_TOKEN --config apps/gateway-worker/wrangler.jsonc` — AI Gateway REST 用 Cloudflare API token（AI Gateway Run 権限）
   - `npx wrangler secret put OPENAI_USAGE_API_KEY --config apps/gateway-worker/wrangler.jsonc` — OpenAI Organization Usage API 読み取り用 admin key
6. `npx wrangler d1 migrations apply octg --remote --config apps/gateway-worker/wrangler.jsonc` で remote D1 migration を適用する。
7. `npx wrangler deploy --config apps/gateway-worker/wrangler.jsonc`（CI からのデプロイを推奨）。

## Secret ローテーション

各 Secret は (1) 新規トークン発行 → (2) `wrangler secret put` で設定 → (3) デプロイ / 動作確認 → (4) 旧トークン失効、の順で実施する。Worker コード・ログ・`octg_sk_*` の鍵素材に Secret の値を含めない。

`OCTG_KEY_PEPPER` の変更は通常の Secret ローテーションと分離して扱う。旧 pepper との併用期間を設けて段階的に全キーを再発行するか、全クライアントの `key_hash` を新 pepper で移行してから旧 pepper を無効化する。単純な即時変更は既存キーを無効化するため避ける。

## エンドポイント一覧（MVP）

```text
POST /v1/responses          # OpenAI 互換（予約・精算つき）
POST /v1/chat/completions   # OpenAI 互換（同上）
GET  /v1/models             # 互換 endpoint（registry から生成し client policy で絞る）
GET  /quota                 # pool 状態の可視化（クライアントキー認証必須）
GET  /admin/quota           # 以下 Admin API（Cloudflare Access 必須）
GET  /admin/usage
GET  /admin/clients
GET  /admin/models
PUT  /admin/clients/:id/policy
PUT  /admin/models/:model
POST /admin/reconcile
```

`/v1/embeddings`・`/v1/audio/*`・`/v1/images/*` は将来対応。

## 既知の限界

課金 0 円の完全保証はしない。conservative reservation + fail-closed + OpenAI reconciliation の三重防御（詳細は SPEC.md §15 参照）。監査ログは best-effort で配送欠損を許容する（authoritative な制御は DO が担う）。

## 今回のレビューで未対応とした項目

`handleAdmin` のルート別 handler への分割は、今回の修正では実施していない。これは機能不具合ではなく構造改善であり、JWT 検証、入力検証、エラー境界、reconciliation の挙動修正とは独立しているため、変更範囲と回帰リスクを抑える目的で保留した。
