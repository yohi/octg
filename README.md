# OCTG — OpenAI Complimentary Token Gateway

OpenAI Data Sharing Program (Tier 3) の無料枠を複数クライアントで共有するための
OpenAI 互換 API Gateway です。Cloudflare Workers、Durable Objects、D1 で構成されます。

詳細設計は [SPEC.md](./SPEC.md) を参照。

本 README は OCTG 本体リポジトリの開発・運用手順を記載しています。
独自環境へ展開する場合は、このリポジトリを fork した後、生成先リポジトリの設定に
合わせて `wrangler.jsonc` と Secret を構成してください。

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

## はじめに：あなたの立場に応じた手順

このリポジトリに関わる人は次の 3 つの立場があります。自分に該当する手順だけを読んでください。

| 立場 | やること | 参照先 |
|------|---------|--------|
| **利用するだけ** | デプロイ済みの Gateway を OpenAI 互換クライアントから呼ぶ | [クイックスタート（利用するだけ）](#クイックスタート利用するだけ) |
| **開発する** | ローカルで Worker を起動し、コードを変更・テストする | [セットアップ（開発する場合）](#セットアップ開発する場合) |
| **デプロイする** | 自分専用のインスタンスを Cloudflare に建てる | [デプロイする場合](#デプロイする場合) |

---

## クイックスタート（利用するだけ）

開発・デプロイは行わず、既に動いている Gateway を利用するだけの場合の手順です。

### 必要なもの

管理者から以下を受け取ってください。

- **Gateway の URL**（例: `https://octg-gateway.<subdomain>.workers.dev`）
- **クライアント API キー**（`octg_sk_*` で始まる文字列）

### 使い方

OCTG は OpenAI 互換 API を提供するため、**接続先 URL（base URL）と API キーを差し替えるだけで利用できます**（SPEC.md AC-01）。利用可能な無料枠モデルは `gpt-5`、`gpt-5-mini`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna` です。

#### curl での動作確認

```bash
curl https://octg-gateway.<subdomain>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer octg_sk_xxx" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-5.6-luna", "messages": [{"role": "user", "content": "Hello"}]}'
```

#### 利用可能なモデル

| モデル | 無料枠プール | 用途の目安 |
|---|---|---|
| `gpt-5.6-sol` | STANDARD | 高度な推論・複雑な処理 |
| `gpt-5.6-terra` | STANDARD | 性能とコストのバランス |
| `gpt-5.6-luna` | MINI | 高ボリューム・低コスト |
| `gpt-5` | STANDARD | 既存の推論・コーディング |
| `gpt-5-mini` | MINI | 軽量な処理 |

モデルの利用可否は Gateway の `/v1/models` でも確認できます。

OpenAI 互換の base URL を指定できるクライアント（OpenCode、OpenAI SDK 互換ツールなど）では、以下のように設定します。

```text
base URL: https://octg-gateway.<subdomain>.workers.dev/v1
API Key:  octg_sk_xxx
```

> 注意: 共有無料枠の範囲内で処理されるため、利用状況（/quota）は管理者に問い合わせてください。超過時は 429 または REJECT ポリシーに応じた応答が返ります。

### Cloudflare AI Gateway 経由で利用する

管理者が OCTG を Cloudflare AI Gateway の **Custom Provider** として登録している場合、クライアントは Gateway A のエンドポイントを向けます。

```text
base URL: https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_a_id}/custom-octg/v1
API Key:  <発行された octg_sk_xxx>
追加ヘッダー:
  cf-aig-authorization: Bearer <Gateway A Run token>
  cf-aig-collect-log-payload: false
  cf-aig-skip-cache: true
```

詳細なセットアップ手順とトラブルシューティングは [docs/cloudflare-ai-gateway-custom-provider.md](./docs/cloudflare-ai-gateway-custom-provider.md) を参照してください。

---

## セットアップ（開発する場合）

コードを変更・テストするためにローカル環境を構築する手順です。

### 最短手順

Node.js 20 以上を用意した後、次の 2 コマンドでローカル環境を準備できます。`.dev.vars` が既にある場合は、既存の Secret を保護するためスクリプトが停止します。

```bash
npm install
npm run setup:local
```

セットアップ完了後、Worker を起動します。

```bash
npm run dev -w apps/gateway-worker
```

クライアントキーを自分で指定する場合は、環境変数を付けて実行します。

```bash
OCTG_CLIENT_ID=client_demo \
OCTG_CLIENT_NAME=Demo \
OCTG_CLIENT_KEY=octg_sk_local_demo \
OCTG_CLIENT_TOOLS_MODE=ALLOW \
npm run setup:local
```

`setup:local` は `.dev.vars` の作成、ローカル D1 migration、開発用クライアントの登録を行います。既存の `.dev.vars` を意図的に作り直す場合だけ `npm run setup:local -- --force` を使用してください。

## セットアップ（インストール）

本リポジトリは npm workspaces で構成されています。Cloudflare Workers 向けのため、
`wrangler` が各 workspace の devDependency として同梱されています
（別途グローバルインストール不要）。

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

ルートで一度実行すると、全 workspace（`apps/*`, `durable-objects/*`, `packages/*`）の
依存関係が揃います。`wrangler`・`vitest`・`typescript` などもここでインストールされます。

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
OCTG_UPSTREAM_BASE_URL=https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/openai
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

ここまででローカル開発環境の準備は完了です。
本番デプロイ手順は [デプロイ前の必須プロビジョニング](#デプロイ前の必須プロビジョニング手動) を参照してください。

---

## 開発

セットアップ済みの環境での日次開発コマンド:

```bash
npm test            # 全ワークスペース (Vitest + @cloudflare/vitest-pool-workers)
npm run typecheck
npm run dev -w apps/gateway-worker   # ローカルで Worker 起動
```

初回の環境構築手順は [セットアップ（インストール）](#セットアップインストール) を参照してください。

## デプロイする場合

自分専用の Gateway インスタンスを Cloudflare にデプロイする手順です。

1. D1 を作成し、発行された `database_id` を確認します。
2. AI Gateway と Cloudflare Access の準備を行います。必要な権限と作成手順は
   [docs/DEPLOY_FROM_TEMPLATE.md](./docs/DEPLOY_FROM_TEMPLATE.md) を参照してください。
3. 次のコマンドを実行し、本番設定を対話的に入力します。

   ```bash
   npm run setup:deploy
   ```

   スクリプトは `database_id`、AI Gateway URL、Access の `Team domain` と
   `Audience tag` を入力として受け取り、`wrangler.jsonc` の更新、3 つの Secret の登録、
   remote D1 migration、Worker deploy を順番に実行します。

### デプロイ前の必須プロビジョニング（手動）

1. `wrangler d1 create octg` → 発行された `database_id` を `apps/gateway-worker/wrangler.jsonc` に設定する。
2. AI Gateway を作成し、OpenAI Project A（shared-free, Data Sharing ON）の API キーを **BYOK + Secrets Store** に登録する。OCTG のコード・クライアントには OpenAI キーを配布しない。
3. AI Gateway の Spend Limit を無料枠と同額に設定する（二次防御。authoritative ではない）。
4. `wrangler.jsonc` の vars を実値に差し替える: `OCTG_UPSTREAM_BASE_URL`（アカウント ID 込み）、`ACCESS_TEAM_DOMAIN` / `ACCESS_AUD`（Admin API 用 Cloudflare Access アプリケーション）。
5. Secrets を設定する:
    - `npx wrangler secret put OCTG_KEY_PEPPER --config apps/gateway-worker/wrangler.jsonc`
      — クライアントキーの keyed hash 用 pepper
    - `npx wrangler secret put OCTG_UPSTREAM_API_TOKEN --config apps/gateway-worker/wrangler.jsonc`
      — provider-native AI Gateway 用 Cloudflare API token（AI Gateway Run 権限）
    - `npx wrangler secret put OPENAI_USAGE_API_KEY --config apps/gateway-worker/wrangler.jsonc`
      — OpenAI Organization Usage API 読み取り用 admin key
6. `npx wrangler d1 migrations apply octg --remote --config apps/gateway-worker/wrangler.jsonc` で remote D1 migration を適用する。
7. `npx wrangler deploy --config apps/gateway-worker/wrangler.jsonc`（CI からのデプロイを推奨）。

### カスタムプロバイダーを BYOK で接続する場合

Cloudflare AI Gateway の **Custom Providers** を使うと、AI Gateway がネイティブ対応していない HTTPS ベースの AI API も、BYOK（Provider Keys）で接続できます。

> **OCTG の現状との注意:** OCTG の標準設定は OpenAI provider-native endpoint（`.../<gateway_id>/openai`）向けです。カスタムプロバイダーを OCTG の upstream として利用するには、カスタムプロバイダーの API が OpenAI 互換であることに加え、`apps/gateway-worker/src/upstream.ts` の URL・モデル分類・リクエスト形式をカスタムプロバイダーに合わせて変更してください。設定だけで既存の OpenAI 用経路を切り替えることはできません。

#### 1. Custom Provider を作成する

Cloudflare Dashboard で以下を開きます。

1. **AI > AI Gateway > Custom Providers** を選択する。
2. **Add Custom Provider** を選択する。
3. 次の値を入力する。
   - **Provider Name**: 表示名（例: `Internal AI`）
   - **Provider Slug**: 一意な slug（例: `internal-ai`）。リクエスト時は `custom-internal-ai` として使用する。
   - **Base URL**: `https://` で始まるプロバイダーの API ルート。`/v1/chat/completions` などの API 固有パスは含めない。
   - **Enable**: 接続確認後に有効化する。最初は無効のまま保存してもよい。
4. **Save** を選択する。

Custom Provider の作成・管理を API で行う場合は、Cloudflare API token に **AI Gateway Edit** 権限を付与し、次の API を使用します。

```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai-gateway/custom-providers" \
  -H "Authorization: Bearer $CLOUDFLARE_MGMT_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Internal AI",
    "slug": "internal-ai",
    "base_url": "https://api.example.com",
    "description": "Internal OpenAI-compatible provider",
    "enable": true
  }'
```

#### 2. Provider API key を BYOK に登録する

1. 対象 Gateway の **Provider Keys** を開く。
2. **Add API Key** を選択する。
3. プロバイダーとしてカスタムプロバイダーを選択し、プロバイダーの API key を入力する。
4. key alias を指定する。1 つだけ登録する場合は `default` を推奨する。
5. 保存後、AI Gateway 側でキーが有効になっていることを確認する。

API key は Worker の Secret やリポジトリに保存しません。複数のキーを登録して `default` 以外の alias を使う場合は、リクエストに `cf-aig-byok-alias` ヘッダーを付与します。

#### 3. リクエスト経路を選択する

カスタムプロバイダーの slug は、AI Gateway の URL では必ず `custom-` を付けて参照します。

- **OpenAI 互換 API の場合:** Unified API を使う。モデル名は `custom-internal-ai/<model-name>` の形式にする。

  ```text
  https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/compat/chat/completions
  ```

- **独自の API パスまたはリクエスト形式の場合:** provider-specific endpoint を使う。`custom-internal-ai/` より後ろのパスが Base URL に連結される。

  ```text
  https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/custom-internal-ai/v1/generate
  ```

Authenticated Gateway を有効にしている場合、provider-native endpoint への Cloudflare Gateway 認証には `Authorization` ではなく `cf-aig-authorization` を使用します。

```bash
curl -X POST "https://gateway.ai.cloudflare.com/v1/$CLOUDFLARE_ACCOUNT_ID/<gateway_id>/compat/chat/completions" \
  -H "cf-aig-authorization: Bearer $OCTG_UPSTREAM_API_TOKEN" \
  -H "cf-aig-byok-alias: default" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "custom-internal-ai/example-model",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

接続確認後は、AI Gateway のログとカスタムプロバイダー側のアクセスログを確認し、(1) BYOK key が送信されていないこと、(2) upstream URL が想定どおりであること、(3) 失敗時に API key をログ出力していないことを確認してください。

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
