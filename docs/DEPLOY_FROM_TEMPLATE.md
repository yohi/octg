# テンプレートから新規インスタンスを構築する手順

本リポジトリは GitHub の [Template repository](https://docs.github.com/ja/repositories/creating-and-managing-repositories/creating-a-template-repository) として公開しています。
`git clone` せずにテンプレートから新規リポジトリを生成し、独自の OCTG インスタンスを構築できます。

## 1. テンプレートからリポジトリを生成

1. 上部の **Use this template** バッジ（または https://github.com/yohi/octg/generate ）を開く。
2. 新しいリポジトリ名・所有者・可視性（Private 推奨）を入力し、**Create repository from template** をクリック。
3. 生成後、自分のリポジトリとして `git clone` または GitHub Codespaces で開く。

## 2. Cloudflare リソースの準備

テンプレートから生成した直後は、`apps/gateway-worker/wrangler.jsonc` に **テンプレート元の `database_id`** が残っているため、以下を自分のアカウントの値に書き換えます。

### 2.1 D1 データベース

```bash
npx wrangler d1 create octg
```

出力された `database_id` を `apps/gateway-worker/wrangler.jsonc` の該当行に設定:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "octg",
    "database_id": "<your-database-id>",   // ← 差し替え
    "migrations_dir": "../../db/migrations"
  }
]
```

### 2.2 AI Gateway

1. Cloudflare ダッシュボードで AI Gateway を作成し、OpenAI Project A（shared-free, Data Sharing ON）の API キーを **BYOK + Secrets Store** に登録。
2. AI Gateway のエンドポイント URL を確認（`https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>`）。
3. AI Gateway の Spend Limit を無料枠と同額に設定（二次防御）。

### 2.3 Cloudflare Access（Admin API 保護）

Admin API（`/admin/*`）は Cloudflare Access で保護します。Access アプリケーションを作成し、以下を取得して `wrangler.jsonc` の `vars` に設定:

- `ACCESS_TEAM_DOMAIN`: Access チームドメイン（例: `your-team.cloudflareaccess.com`）
- `ACCESS_AUD`: Audience tag

## 3. Secret の設定

本番用 Secrets を Cloudflare に登録:

```bash
npx wrangler secret put OCTG_KEY_PEPPER          --config apps/gateway-worker/wrangler.jsonc
npx wrangler secret put OCTG_UPSTREAM_API_TOKEN  --config apps/gateway-worker/wrangler.jsonc
npx wrangler secret put OPENAI_USAGE_API_KEY     --config apps/gateway-worker/wrangler.jsonc
```

| Secret | 用途 |
|---|---|
| `OCTG_KEY_PEPPER` | クライアントキー `key_hash` の keyed hash 用 pepper |
| `OCTG_UPSTREAM_API_TOKEN` | AI Gateway REST 呼び出し用 Cloudflare API token（AI Gateway Run 権限） |
| `OPENAI_USAGE_API_KEY` | OpenAI Organization Usage API 読み取り用 admin key |

> Secrets の値をコード・ログ・コミットに含めないこと。[Secret ローテーション手順](../README.md#secret-ローテーション) も参照。

## 4. デプロイ

```bash
# D1 マイグレーション（本番）
npx wrangler d1 migrations apply octg --remote --config apps/gateway-worker/wrangler.jsonc

# Worker デプロイ
npx wrangler deploy --config apps/gateway-worker/wrangler.jsonc
```

## 5. クライアント鍵の発行

初回クライアントを本番 D1 に登録します。

```bash
OCTG_KEY_PEPPER=<your-production-pepper> \
  node scripts/seed-client.mjs client_demo Demo octg_sk_xxx > /tmp/octg-seed.sql

npx wrangler d1 execute octg --remote --file /tmp/octg-seed.sql --config apps/gateway-worker/wrangler.jsonc
```

## Template repository 利用時の留意点

- **upstream 同期なし**: フォークと異なり、本家（`yohi/octg`）側の修正は自動で取り込まれません。必要に応じて `git remote add upstream ...` で追跡し、手動マージしてください。
- **`database_id` の再発行**: テンプレートから生成した直後は必ず自分の D1 `database_id` に書き換えてください（テンプレート元の ID は参照できません）。
- **Secrets は各自設定**: 本家側の Secret は引き継がれません。各自 `wrangler secret put` で設定します。
- **`wrangler.jsonc` の `vars` 差し替え**: `OCTG_UPSTREAM_BASE_URL`、`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD` を自分の環境の値に更新します。
