# テンプレートから新規インスタンスを構築する手順

本リポジトリは GitHub の [Template repository](https://docs.github.com/ja/repositories/creating-and-managing-repositories/creating-a-template-repository) として公開しています。
`git clone` せずにテンプレートから新規リポジトリを生成し、独自の OCTG インスタンスを構築できます。

OCTG の本番構成は Gateway Worker、`QuotaController` Durable Object、
`TokenizerController` Durable Object で構成されます。TokenizerController は
`tokenizer:primary` という固定 ID の RPC endpoint で exact `o200k_base` BPE を実行します。
入力本文・API key・tokenizer state はログや Durable Object storage に保存しません。

## 1. テンプレートからリポジトリを生成

1. 上部の **Use this template** バッジ（または https://github.com/yohi/octg/generate ）を開く。
2. 新しいリポジトリ名・所有者・可視性（Private 推奨）を入力し、**Create repository from template** をクリック。
3. 生成後、自分のリポジトリとして `git clone` または GitHub Codespaces で開く。

## 2. Cloudflare 環境の事前準備

OCTG を本番動作させるには、Cloudflare アカウント上に **D1 データベース**、**AI Gateway**、**Cloudflare Access アプリケーション**、および Wrangler 用 **API トークン** を作成してください。

### 2.1 必要な Cloudflare サービスと権限

| リソース | 用途 | 必要な権限（API トークン） |
|---|---|---|
| D1 | 監査ログ・レジストリ・クライアント管理 | Zone なし、Account: **Cloudflare D1:Edit** |
| AI Gateway | OpenAI API のプロキシ・キャッシュ・Spend Limit | Account: **AI Gateway:Run** |
| Workers | OCTG 本体のホスティング | Account: **Cloudflare Workers:Edit** |
| Access | Admin API（`/admin/*`）の保護 | Account: **Access:Apps:Edit**, **Access:Organizations:Read** |

### 2.2 Cloudflare API トークンの作成

1. [Cloudflare Dashboard](https://dash.cloudflare.com/) → 右上プロファイル → **My Profile** → **API Tokens** → **Create Token** を開く。
2. **Custom token** を選択し、以下を設定:
   - **Token name**: `OCTG upstream runner`（任意）
   - **Permissions**:
     - `AI Gateway` → `Run`
   - **Account Resources**: 対象のアカウントを Include
3. **Continue to summary** → **Create Token** → 表示されたトークンをコピーする（二度と表示されないので注意）。

このトークンが `OCTG_UPSTREAM_API_TOKEN` として使用します。

### 2.3 D1 データベースの作成

1. Cloudflare Dashboard → **Workers & Pages** → **D1** を開く。
2. **Create database** ボタンをクリック。
3. **Database name** に `octg` と入力し、**Create** をクリック。
4. 作成後に表示される **Database ID** をコピーしておく（例: `42ffaeac-6bc2-431b-a5c1-a8016fae8b4f`）。

コマンドラインから作成する場合:

```bash
npx wrangler d1 create octg
```

出力された `database_id` を `apps/gateway-worker/wrangler.jsonc` の該当行に設定:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "octg",
    "database_id": "<your-database-id>",   // ← 2.3 でコピーした値
    "migrations_dir": "../../db/migrations"
  }
]
```

### 2.4 AI Gateway の作成と OpenAI 接続設定

1. Cloudflare Dashboard → **Workers & Pages** → **AI Gateway** を開く。
2. **Create Gateway** をクリック。
3. **Gateway name** を入力（例: `octg`）→ **Create**。
4. 作成後、AI Gateway 一覧から対象 Gateway をクリックして詳細を開く。
5. **API** タブまたは **Endpoints** セクションで **OpenAI** を選択し、以下を設定:
   - **Endpoint URL**: ダッシュボードに表示された URL（例: `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_name>`）をコピー
   - **Authorization**: OpenAI Project A の API キーを入力
     - OpenAI 側で **Project A** を作成（または既存を使用）し、Billing → Data Sharing Program で **Data Sharing ON** を確認
     - Project A の **Project API keys** から新規キーを発行
     - このキーを AI Gateway の **BYOK（Bring Your Own Key）** 欄に貼り付けて保存
6. **Settings** タブで **Spend Limit** を、許容できる有料利用額の上限として設定する。
   - Tier 3 の無料枠は、`STANDARD 1,000,000 tokens/day` と
     `MINI 10,000,000 tokens/day` という**トークン数の上限**です。
     固定の USD クレジットではありません。モデルごとに input/output の
     単価が異なるため、2 つのプールを 1 つの金額へ正確に換算できません。
     したがって、「無料枠と同額」の設定値はありません。
   - 有料利用を許可しない場合は、ダッシュボードで設定可能な最小額に
     設定してください。最小額で無料リクエストまで拒否される場合は、
     AI Gateway の仕様に従い、無料リクエストを通せる最小額を設定します。
     そのうえで、OCTG の Durable Object reservation と paid fallback の
     拒否ポリシーを authoritative な制御として使用します。
   - Spend Limit は二次防御（eventually consistent）であり、無料枠
     カウンターでも authoritative な制御でもありません。実際のトークン
     上限は Durable Object の reservation が管理します。

### 2.5 Cloudflare Access アプリケーションの作成

Admin API（`/admin/*`）を保護するため、Cloudflare Zero Trust Access の Self-hosted アプリケーションを作成します。

> **重要**: Application domain には、実際に **public DNS で解決し Cloudflare プロキシが有効なカスタムドメイン**を指定してください。`*.cloudflareaccess.com` など存在しないホスト名や、`.workers.dev` ドメインをそのまま入力しても Access は保護対象ホスト名として認識しません。まず Worker にカスタムドメインを紐付けてから Access アプリを作成してください。

#### Worker へのカスタムドメイン紐付け

1. Cloudflare Dashboard → 使用するドメイン（例: `yourdomain.com`）→ **DNS** を開く。
2. `octg-admin` などのホスト名で **CNAME** レコードを作成し、ターゲットを Worker URL（例: `octg-gateway.your-account.workers.dev`）に設定。
3. プロキシステータスを **有効（オレンジクラウド）** にする。
4. **Workers & Pages** → 対象 Worker → **Settings** → **Triggers** → **Custom Domains** で同じドメイン（例: `octg-admin.yourdomain.com`）を追加。

#### Access アプリ作成

1. Cloudflare Dashboard → **Zero Trust** → **Access** → **Applications** を開く。
2. **Add an application** → **Self-hosted** を選択。
3. **Application name** に `OCTG Admin` などを入力。
4. **Application domain** に上記で紐付けたカスタムドメイン（例: `octg-admin.yourdomain.com`）を入力。
5. **Identity providers** で利用する IdP（One-time PIN、Google、GitHub など）を選択。
6. **Access policies** で許可するユーザーを設定（例: **Emails** → 自分のメールアドレスを Include）。
7. **Configure** → **Add application** で保存。
8. 保存後、アプリケーション詳細の **Overview** タブで以下をコピー:
   - **Application Audience (AUD) Tag**: 長い英数字列
   - **Application Domain** に表示されている `<your-team>.cloudflareaccess.com` 形式のチームドメイン

取得した値を `wrangler.jsonc` の `vars` に設定:

```jsonc
"vars": {
  "OCTG_UPSTREAM_BASE_URL": "https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_name>/openai",
  "ACCESS_TEAM_DOMAIN": "<your-team>.cloudflareaccess.com",
  "ACCESS_AUD": "<audience-tag>"
}
```

### 2.6 OpenAI Usage API 用キーの作成

1. [OpenAI Platform](https://platform.openai.com/) にログイン。
2. 左メニュー → **Organization** → **API keys** を開く。
3. **Create new secret key** をクリック。
   - **Name**: `OCTG usage reconciliation`
   - **Project**: デフォルト（Organization スコープ）を選択
   - **Permissions**: `Organization billing:Read` または同等の読み取り権限
4. 発行されたキーをコピー（二度と表示されないので注意）。

このキーが `OPENAI_USAGE_API_KEY` として使用します。

## 3. 自動セットアップスクリプトの実行

上記の事前準備が完了したら、テンプレート生成後のリポジトリで以下を実行すると、`wrangler.jsonc` の更新から Secret 登録、D1 migration、Worker deploy までを対話形式で行います。

```bash
npm install
npm run setup:deploy
```

スクリプトは以下の順で値を対話入力します。

| 質問 | 入力値 | 取得場所 | 必須 |
|---|---|---|---|
| D1 `database_id` | `42ffaeac-...` | 2.3 の D1 ダッシュボード | ✓ |
| `OCTG_UPSTREAM_BASE_URL` | AI Gateway URL | 2.4 の Gateway 詳細 | ✓ |
| `ACCESS_TEAM_DOMAIN` | `your-team.cloudflareaccess.com` | 2.5 の Access アプリ Overview | ✓ |
| `ACCESS_AUD` | Audience tag | 2.5 の Access アプリ Overview | ✓ |

`setup:deploy` は `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` を含む本番設定がすべて入力されている場合にのみ実行できます。Admin API（`/admin/*`）を保護するため、2.5 の手順で Access アプリを作成し、取得した値を入力してください。
その後、`wrangler secret put` を使って **3 つの Secret を順番に入力**します。順序は以下の通りです。

| 順 | Secret | 入力する値 | 取得場所 |
|---:|---|---|---|
| 1 | `OCTG_KEY_PEPPER` | 任意の長いランダム文字列 | 自分で生成 |
| 2 | `OCTG_UPSTREAM_API_TOKEN` | Cloudflare API token | 2.2 で作成 |
| 3 | `OPENAI_USAGE_API_KEY` | OpenAI admin key | 2.6 で作成 |

> 初回実行時、`wrangler secret put` は Worker `octg-gateway` が存在しないことを検知し、新規作成するか尋ねるダイアログを表示します。`yes` を選択すると Worker が作成され、Secret が登録されます。
>
> Secret の値はファイルには保存されません。

## 4. 手動で Secret 設定する場合

スクリプトを使わず手動で行う場合は以下のコマンドを順に実行します。

```bash
# 1. wrangler.jsonc の vars を直接編集
#    - database_id
#    - OCTG_UPSTREAM_BASE_URL
#    - ACCESS_TEAM_DOMAIN
#    - ACCESS_AUD

# 2. Secret を Cloudflare に登録
npx wrangler secret put OCTG_KEY_PEPPER          --config apps/gateway-worker/wrangler.jsonc
npx wrangler secret put OCTG_UPSTREAM_API_TOKEN  --config apps/gateway-worker/wrangler.jsonc
npx wrangler secret put OPENAI_USAGE_API_KEY     --config apps/gateway-worker/wrangler.jsonc

# 3. 本番 D1 にマイグレーションを適用
npx wrangler d1 migrations apply octg --remote --config apps/gateway-worker/wrangler.jsonc

# 4. Worker をデプロイ
npx wrangler deploy --config apps/gateway-worker/wrangler.jsonc
```

> 初回デプロイ時、`wrangler` は `workers_dev` が明示的に設定されていないことを警告することがあります。これはデフォルトで `workers.dev` ルートが有効になることを示しており、無料枠の Gateway 用途では通常そのままで問題ありません。必要に応じて `wrangler.jsonc` に `workers_dev` を明示的に設定してください。

### 4.1 Durable Object migration の確認

Gateway Worker の `apps/gateway-worker/wrangler.jsonc` には、QuotaController に続いて
TokenizerController を追加する migration `v2` が定義されています。

```jsonc
"durable_objects": {
  "bindings": [
    { "name": "QUOTA_CONTROLLER", "class_name": "QuotaController" },
    { "name": "TOKENIZER_CONTROLLER", "class_name": "TokenizerController" }
  ]
},
"migrations": [
  { "tag": "v1", "new_sqlite_classes": ["QuotaController"] },
  { "tag": "v2", "new_sqlite_classes": ["TokenizerController"] }
]
```

- 適用済み migration tag は削除、改名、内容変更しないでください。
- TokenizerController は SQLite class として登録されますが、現在は `ctx.storage` を使わない
  RPC 専用 Durable Object です。入力本文や tokenizer state を永続化しません。
- migration を追加・変更した場合は、D1 migration だけでなく Gateway Worker の deploy で
  Durable Object migration も適用されることを確認してください。

| Secret | 用途 | 取得場所 |
|---|---|---|
| `OCTG_KEY_PEPPER` | クライアントキー `key_hash` の keyed hash 用 pepper | 任意の長いランダム文字列を生成して使用 |
| `OCTG_UPSTREAM_API_TOKEN` | AI Gateway REST 呼び出し用 Cloudflare API token | 2.2 で作成 |
| `OPENAI_USAGE_API_KEY` | OpenAI Organization Usage API 読み取り用 admin key | 2.6 で作成 |

> Secrets の値をコード・ログ・コミットに含めないこと。[Secret ローテーション手順](../README.md#secret-ローテーション) も参照。

## 4.2 デプロイ前の検証

本番 credential、入力本文、API key を出力しない環境で、少なくとも次を実行します。

```bash
npm run typecheck
npm test
npm test -w apps/gateway-worker
npm test -w durable-objects/tokenizer-controller
```

次の動作を確認してから deploy してください。

- TokenizerController の exact BPE が成功するまで `quota_reserve` と upstream call が発生しない。
- malformed RPC result、RPC failure、入力上限超過、算術異常が `500 internal_error` になり、
  reservation と upstream call が発生しない。
- 74,000 token 級の fixture で exact token count と quota accounting が一致する。
- Tokenizer stage event が request ID、revision、safe な数値、allowlist 済み outcome だけを含み、
  payload や credential を含まない。

## Custom Provider として AI Gateway 経由で公開する

初回デプロイ後、OCTG を Cloudflare AI Gateway の Custom Provider として登録して利用者に配布できます。
この場合は **Gateway A（受信側）と Gateway B（OpenAI 送信側）を別の AI Gateway インスタンスにすること** が必須です。同一 Gateway ID に Gateway A の `custom-octg` エンドポイントと Gateway B の `/openai` エンドポイントを混在させると、OCTG Worker が Gateway A へ outbound した際にルーティングループするリスクがあります。

詳細は [docs/cloudflare-ai-gateway-custom-provider.md](./cloudflare-ai-gateway-custom-provider.md) を参照してください。

## 5. クライアント鍵の発行

初回クライアントを本番 D1 に登録します。

```bash
OCTG_KEY_PEPPER=<your-production-pepper> \
  node scripts/seed-client.mjs client_demo "Demo Client" octg_sk_xxx > /tmp/octg-seed.sql

npx wrangler d1 execute octg --remote --file /tmp/octg-seed.sql --config apps/gateway-worker/wrangler.jsonc
```

ツール使用を許可する場合は、第 4 引数に `ALLOW` を指定してください。

```bash
OCTG_KEY_PEPPER=<your-production-pepper> \
  node scripts/seed-client.mjs client_demo "Demo Client" octg_sk_xxx ALLOW > /tmp/octg-seed.sql

npx wrangler d1 execute octg --remote --file /tmp/octg-seed.sql --config apps/gateway-worker/wrangler.jsonc
```

または、より簡単に `npm run seed:client:remote` を使用します。`--key` を省略すると、`octg_sk_remote_` 形式のランダムな本番クライアントキーを自動生成して本番 D1 に登録します。

```bash
# 本番クライアントキーを自動生成する場合（ツール使用を許可）
OCTG_KEY_PEPPER=<your-production-pepper> \
  npm run seed:client:remote -- --id=client_demo --name=DemoClient --tools-mode=ALLOW

# 独自のキーを指定する場合
OCTG_KEY_PEPPER=<your-production-pepper> \
  npm run seed:client:remote -- --id=client_demo --name=DemoClient --key=octg_sk_my_custom_key --tools-mode=ALLOW

# --name にスペースを含む場合は環境変数を使用
OCTG_KEY_PEPPER=<your-production-pepper> \
  OCTG_CLIENT_ID=client_demo \
  OCTG_CLIENT_NAME="Demo Client" \
  OCTG_CLIENT_TOOLS_MODE=ALLOW \
  npm run seed:client:remote
```

## 6. デプロイ後の確認と運用

### 6.1 クライアントキー発行後の動作確認

発行した `octg_sk_*` を使って、Gateway が実際に応答するか確認します。無料枠モデルとして `gpt-5.6-luna` を使用します。

```bash
curl https://octg-gateway.<your-account>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer <発行された octg_sk_xxx>" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-5.6-luna", "messages": [{"role": "user", "content": "Hello"}]}'
```

正常に通れば OpenAI 互換のレスポンスが返ります。利用可能なモデルは `/v1/models` で確認できます。もし 401/403 なら、D1 にクライアントが正しく登録されたか、`OCTG_KEY_PEPPER` が一致しているか確認してください。

### 6.2 クォータ状態の確認

認証済みクライアントから pool 状態を参照できます。

```bash
curl https://octg-gateway.<your-account>.workers.dev/quota \
  -H "Authorization: Bearer <発行された octg_sk_xxx>"
```

### 6.3 利用者への配布情報

クライアント（OpenCode、OpenAI SDK 互換ツールなど）には以下を設定してもらいます。

```text
base URL: https://octg-gateway.<your-account>.workers.dev/v1
API Key:  <発行された octg_sk_xxx>
```

> **注意**: 2.5 で作成した **Cloudflare Access 保護ドメイン（例: `octg-admin.yourdomain.com`）は Admin API（`/admin/*`）専用**です。クライアント API（`/v1/*`、`/quota`）の呼び出しには **Worker のメイン URL**（`*.workers.dev` またはクライアント API 用に別途設定したカスタムドメイン）を使用してください。Access 保護ドメインにクライアント API を向けると、ログイン画面へ 302 リダイレクトされて正常に応答しません。

### 6.4 Admin API の保護

`setup:deploy` は `ACCESS_TEAM_DOMAIN` と `ACCESS_AUD` が未設定の場合に中断します。まだ Cloudflare Access アプリを作成していない場合は、2.5 の手順で作成し、取得した値を入力してから再実行してください。

### 6.5 監視・運用

- クォータ状態は `/quota` で確認できます。
- 毎日 UTC 0:05 の Cron Trigger で、OpenAI Usage API との reconciliation が実行されます。
- D1 監査ログは best-effort で書き込まれます。課金判定は Durable Object の reservation を authoritative として扱います。
- Tokenizer stage event は request ID、revision、stage、duration、safe な byte/token 数、
  allowlist 済み outcome だけを記録します。入力本文、Authorization、API key、encoder 例外文字列は記録しません。
- Tokenizer RPC が利用できない場合、Gateway は未検証の推定値で quota を予約せず、
  `500 internal_error` を返します。local BPE、未検証の byte 比率式、paid fallback、
  リトライ回数の増加で回避しないでください。
- 74,000 token 級 payload の canary は、同じ revision の Workers invocation outcome、CPU/wall time、
  Tokenizer stage、quota reserve、upstream 到達を request ID で相関して確認します。

> 詳細な設計・エラー契約は [SPEC.md](../SPEC.md) を参照してください。

### 6.6 ロールバック

Durable Object migration は不可逆として扱います。適用済みの `v1` / `v2` を削除・改名・再利用せず、
Cloudflare の deployment version rollback を使ってアプリケーション revision だけを戻してください。
rollback 後も `TOKENIZER_CONTROLLER` binding と migration `v2` を含む manifest を維持し、Gateway や
shared package に exact BPE を戻さないでください。小さい非機密 fixture で success、reservation、
upstream 到達、`/quota` の状態を確認してから利用者へ再開を告知します。

Tokenizer RPC failure が継続する場合は、原因が解消するまで再試行を増やさず fail-closed のままにし、
revision ID と安全な stage event だけを記録します。

## Template repository 利用時の留意点

- **upstream 同期なし**: フォークと異なり、本家（`yohi/octg`）側の修正は自動で取り込まれません。必要に応じて `git remote add upstream ...` で追跡し、手動マージしてください。
- **`database_id` の再発行**: テンプレートから生成した直後は必ず自分の D1 `database_id` に書き換えてください（テンプレート元の ID は参照できません）。
- **Secrets は各自設定**: 本家側の Secret は引き継がれません。各自 `wrangler secret put` で設定します。
- **`wrangler.jsonc` の `vars` 差し替え**: `OCTG_UPSTREAM_BASE_URL`、`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD` を自分の環境の値に更新します。
- **OpenAI キーは BYOK**: AI Gateway の Secrets Store にのみ保持し、OCTG のコード・クライアント・ログに OpenAI API キーを含めないでください。
