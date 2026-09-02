# OCTG — OpenAI Complimentary Token Gateway

OpenAI Data Sharing Program (Tier 3) の無料枠を複数クライアントで共有するための OpenAI 互換 API Gateway。Cloudflare Workers + Durable Objects + D1 で構成される。

詳細設計は [SPEC.md](./SPEC.md) を参照。

Deno tokenizer の有効化、Secret 設定、canary 手順は
[docs/deno-tokenizer.md](./docs/deno-tokenizer.md) を参照してください。
既定の Gateway 設定では Deno tokenizer は無効です。

全環境の変数、Secret、取得場所、Production/Preview の境界は
[docs/CONFIGURATION.md](./docs/CONFIGURATION.md) にまとめています。入力テンプレートは
[.env.example](./.env.example) を使用してください。

[![Use this template](https://img.shields.io/badge/Use%20this%20template-yohi/octg-blue)](https://github.com/yohi/octg/generate)

## アーキテクチャ概要

```text
Client (OpenCode / AI Agent / MCP / Apps)
        │  Authorization: Bearer octg_sk_*
        ▼
Cloudflare Worker (OpenAI 互換 API)
        │  認証 → ポリシー解決 → モデル分類 → Tool-use 判定
        │  → QuotaController state 読み出し
        ▼
Durable Object: TokenizerController (exact o200k_base BPE)
        │  固定 ID tokenizer:primary への 1 回の RPC
        ▼
Cloudflare Worker
        │  token budget 算術 → reservation 要求
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
6. exact BPE は `tiktoken/lite` を使う TokenizerController に隔離し、Gateway と shared package に encoder を依存させない
7. TokenizerController は RPC 専用で、入力本文や tokenizer state を Durable Object storage に保存しない
8. `Idempotency-Key` は client × pool × UTC 日単位で重複排除し、空文字を absent、指定値を UTF-8 255 bytes 以下として扱う。Worker の upstream 自動 retry は無効化する

## はじめに：あなたの立場に応じた手順

このリポジトリに関わる人は次の 3 つの立場があります。自分に該当する手順だけを読んでください。

| 立場 | やること | 参照先 |
|------|---------|--------|
| **利用するだけ** | デプロイ済みの Gateway を OpenAI 互換クライアントから呼ぶ | [クイックスタート（利用するだけ）](#クイックスタート利用するだけ) |
| **開発する** | ローカルで Worker を起動し、コードを変更・テストする | [セットアップ（開発する場合）](#セットアップ開発する場合) |
| **デプロイする** | 自分専用のインスタンスを Cloudflare に建てる | [テンプレートから新規作成（デプロイする場合）](#テンプレートから新規作成デプロイする場合) |

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
| `gpt-5.6-terra` | MINI | 性能とコストのバランス |
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

#### OpenCode の `opencode.json` / `opencode.jsonc` への追記

OpenCode からこの Custom Provider を使う場合は、Gateway A の Run token を
`OCTG_CF_API_TOKEN` として環境変数へ設定し、既存の `provider` オブジェクトへ次を追加します。
`opencode.jsonc` ではそのまま使用でき、`opencode.json` ではコメントを除去してください。
以下の model metadata は上流モデルの token limit と reasoning / tool calling 対応を反映しています。
OCTG 経由では非テキスト入力を拒否し、tool calling はクライアントポリシーの `tools_mode=ALLOW` が必要です。

```jsonc
"cloudflare-ai-gateway-octg": {
  "npm": "@ai-sdk/openai",
  "options": {
    "apiKey": "cloudflare-custom-provider",
    "baseURL": "https://gateway.ai.cloudflare.com/v1/{env:OCTG_CF_ACCOUNT_ID}/{env:OCTG_CF_GATEWAY_ID}/custom-octg/v1",
    "headers": {
      "Authorization": "",
      "cf-aig-authorization": "Bearer {env:OCTG_CF_API_TOKEN}",
      "cf-aig-collect-log-payload": "false",
      "cf-aig-max-attempts": "1",
      "cf-aig-skip-cache": "true"
    }
  },
  "models": {
    "gpt-5.6-luna": {
      "name": "GPT-5.6 Luna (OCTG)",
      "reasoning": true,
      "tool_call": true,
      "modalities": { "input": ["text"], "output": ["text"] },
      "limit": { "context": 1050000, "input": 922000, "output": 128000 }
    },
    "gpt-5.6-terra": {
      "name": "GPT-5.6 Terra (OCTG)",
      "reasoning": true,
      "tool_call": true,
      "modalities": { "input": ["text"], "output": ["text"] },
      "limit": { "context": 1050000, "input": 922000, "output": 128000 }
    },
    "gpt-5.6-sol": {
      "name": "GPT-5.6 Sol (OCTG)",
      "reasoning": true,
      "tool_call": true,
      "modalities": { "input": ["text"], "output": ["text"] },
      "limit": { "context": 1050000, "input": 922000, "output": 128000 }
    }
  }
}
```

環境変数の例:

```bash
export OCTG_CF_ACCOUNT_ID="<Cloudflare account ID>"
export OCTG_CF_GATEWAY_ID="<Gateway A ID>"
export OCTG_CF_API_TOKEN="<Gateway A Run token>"
```

Provider Key は Gateway A の Custom Provider 側に登録済みの `octg_sk_*` を使用します。
そのため、OpenCode の設定ファイルへ `octg_sk_*` や Run token の実値を記載しないでください。
モデルを選択するときは、例えば `cloudflare-ai-gateway-octg/gpt-5.6-luna` を指定します。

---

## セットアップ（開発する場合）

コードを変更・テストするためにローカル環境を構築する手順です。

### 最短手順

Node.js 22 以上を用意した後、次の 2 コマンドでローカル環境を準備できます。`.dev.vars` が既にある場合は、既存の Secret を保護するためスクリプトが停止します。

```bash
npm install
cp .env.example .env
chmod 600 .env
npm run setup:local -- --env-file=.env
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

本リポジトリは npm workspaces で構成されています。Cloudflare Workers 向けのため、`wrangler` が各 workspace の devDependency として同梱されています（別途グローバルインストール不要）。

### 前提条件

- **Node.js** `>= 22`（`engines` 参照）
- **npm** `>= 10`（Node.js 22 同梱版で動作確認）
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

> **Tip:** `engines` で Node.js 22+ を要求しています。`.nvmrc` 等の管理を推奨します。`node -v` でバージョンを確認してください。

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

TokenizerController は Gateway Worker の `TOKENIZER_CONTROLLER` binding から
`tokenizer:primary` という固定 ID で呼び出されます。入力文字列は TokenizerController 内で
`o200k_base` により exact BPE token 数へ変換され、成功するまで QuotaController の
reservation は実行されません。Tokenizer の outcome は次の契約です。

- `work_limit`（BPE work limit 超過）は HTTP 413、`request_too_large`、
  `X-OCTG-Route: reject:request_too_large` で拒否します。
- RPC failure、malformed result、Worker の RPC preflight ceiling 超過、または
  Tokenizer RPC 境界で `MAX_INPUT_TEXT_BYTES` を超過した場合は unavailable として、
  HTTP 500、`api_error` / `internal_error`、`X-OCTG-Route: error:internal_error` にします。
- Worker の HTTP 正規化で入力上限を超過した場合は RPC より前に HTTP 413、
  `request_too_large`、`reject:request_too_large` で拒否します。
- token budget の算術異常は HTTP 500、`api_error` / `internal_error`、公開 HTTP route は
  `error:internal_error` とし、resource stage event の route は `error:arithmetic_error` とします。

いずれも `QuotaController.reserve`、in-flight admission、upstream call は実行しません。
TokenizerController は RPC 処理だけを行い、入力本文・API key・tokenizer state をログや
Durable Object storage に保存しません。

ここまででローカル開発環境の準備は完了です。実運用する場合は [テンプレートから新規作成（デプロイする場合）](#テンプレートから新規作成デプロイする場合) を参照してください。

---

## テンプレートから新規作成（デプロイする場合）

`git clone` せずに、自分専用の Gateway インスタンスを Cloudflare にデプロイする手順です。

本リポジトリは [Template repository](https://docs.github.com/ja/repositories/creating-and-managing-repositories/creating-a-template-repository) として公開しています。

1. 上部の **Use this template** バッジ（または [Generate from template](https://github.com/yohi/octg/generate)）をクリックします。
2. 新しいリポジトリ名・所有者・可視性を入力し、**Create repository from template** をクリックします。
3. 生成されたリポジトリをローカルに展開（`git clone <your-new-repo>` または GitHub Codespaces）します。
4. `npm install` を実行します。
5. D1 の作成後、次のコマンドで本番設定を対話的に行います。D1 の作成方法や AI Gateway / Access の準備は [docs/DEPLOY_FROM_TEMPLATE.md](./docs/DEPLOY_FROM_TEMPLATE.md) を参照してください。

   ```bash
   npm install
   cp .env.example .env
   chmod 600 .env
   # .env の Production セクションへ既存リソースの値を入力
   npm run setup:deploy -- --env-file=.env --dry-run
   npm run setup:deploy -- --env-file=.env
   ```

   スクリプトは `.env` または既存の `wrangler.jsonc` から設定値を読み、未入力の値だけを尋ねます。`--dry-run`で確認後、`wrangler.jsonc` の更新、3 つの Secret の登録、remote D1 migration、Worker deploy を順番に実行します。D1・AI Gateway・Access application自体は作成しません。

> Template repository の留意点: フォークと異なり upstream との同期は自動で行われません。本リポジトリ側で修正が入った場合は、必要に応じて手動で取り込みます。

---

## 開発

セットアップ済みの環境での日次開発コマンド:

```bash
npm test            # 全ワークスペース (Vitest + @cloudflare/vitest-pool-workers)
npm run typecheck
npm run dev -w apps/gateway-worker   # ローカルで Worker 起動
```

初回の環境構築手順は [セットアップ（開発する場合）](#セットアップ開発する場合) を参照してください。

## CI/CD（GitHub Actions）

- `deploy-production.yml`: `master` への push を受け、typecheck / test、remote D1
  migration（冪等）、`wrangler deploy` を実行します。
- `deploy-deno-tokenizer.yml`: `apps/deno-tokenizer` または依存する shared package の変更時に
  Deno の型検査・テストを実行し、`master` への push では成功後に Deno Deploy の
  Production アプリへデプロイします。Actions の **Run workflow** から feature branch を
  指定して手動実行した場合も、同じ validate job と `deno-production` Environment の承認を
  通過した後に実デプロイできます。また、master へマージする前は同一リポジトリの PR に
  `deploy-deno` ラベルを付けると同じ経路を起動できます（fork PR は対象外）。これにより
  master へマージする前に Deno Deploy の revision build / warmup まで検証できます。
  検証は `apps/deno-tokenizer` から実行し、Deploy は
  repository root の `deno.json` manifest（`./deno.json`、
  `apps/deno-tokenizer/src/**`、`packages/shared/src/**` のみを upload 対象とし、
  `package.json` / `package-lock.json` は含めない）を使用します。GitHub Environment `deno-production` には
  `DENO_DEPLOY_ORG` / `DENO_DEPLOY_APP` と
  Secret `DENO_DEPLOY_TOKEN` を設定します。現行の `deno deploy` CLI を使用し、Classic の
  `deployctl` は使用しません。
- `preview-smoke.yml`: `master` 向け PR の更新を受け、専用 preview Worker の新 version を
  0% traffic で deployment し、preview URL に Version Override header を付けて
  `POST /v1/chat/completions` を最大 3 回試行します。HTTP 200、応答本文、
  `X-OCTG-Worker-Version` と override ID の一致を検証します。header の Worker 名は
  `OCTG_PREVIEW_WORKER_NAME`（未設定時 `octg-gateway-preview`）から渡し、完了後は
  `wrangler rollback <current-version-id> --config <preview-config> --yes` で現行 version
  100% に復元します。

Durable Objects を実装する Worker では Cloudflare Preview URL が生成されないため、
PR の検証には固定の専用 preview Worker と Version Override を使用します。Cloudflare が
自動生成する Preview URL は使用しません。新 version は通常トラフィックへ流さず、
疎通テストのリクエストだけが対象 version に到達します。PR checkout のコード、
`wrangler.jsonc`、smoke script には production credential / resource を渡しません。

Deno Deploy の workflow は通常の PR と fork からの PR では検証だけを行います。同一リポジトリの PR でも
`deploy-deno` ラベルを付けた場合は、検証と `deno-production` Environment の承認を経てデプロイできます。
`OCTG_TOKENIZER_AUTH_TOKEN` は GitHub ではなく、対象 Deno Deploy アプリの runtime
Secret として設定してください。Preview 用 Deno Deploy を使う場合は、Production と別の
GitHub Environment、別プロジェクト、別 Secret を追加して workflow を拡張します。

### 事前に必要な設定（一度だけ）

1. production と分離した preview Worker、preview D1、preview Durable Object、
   client/policy/model registry、監査・reconciliation state を用意し、preview用
   Cloudflare API tokenをpreview control-plane resourceだけへ限定します。upstream billing
   principal は共有できますが、その場合は Preview の利用上限、quota coordination、監視、
   coordination 未設定時の fail-closed 条件を先に定義してください。
   D1作成・migration・CI client seed・GitHub Environment設定は、次のスクリプトで一括実行できます。
   `.env.example` を `.env` へコピーして Preview セクションへ実値を入力し、まずdry-runで確認してください。

   ```bash
   cp .env.example .env
   chmod 600 .env
   zsh scripts/setup-preview.zsh --dry-run
   zsh scripts/setup-preview.zsh
   zsh scripts/setup-preview.zsh --github
   ```

   `--github` は `preview` Environment の Variables と、
   `CLOUDFLARE_PREVIEW_API_TOKEN` / `OCTG_UPSTREAM_API_TOKEN` /
   `OCTG_PREVIEW_SMOKE_API_KEY` / `OCTG_KEY_PEPPER` Secretsを更新します。
   Scriptはcanonical configの`DB` bindingだけを使った一時configを生成するため、
   canonical configに複数のD1 bindingがあってもProduction D1を変更しません。

2. （スクリプトを使わず手動で行う場合）CI 専用クライアントキーを preview D1 に登録します。preview用の
   `OCTG_PREVIEW_KEY_PEPPER` と control-plane credential は production と別の値を
   Cloudflare側で管理します。セットアップスクリプトは入力した
   `OCTG_PREVIEW_KEY_PEPPER` をGitHub preview Environment Secret
   `OCTG_KEY_PEPPER`へ設定し、`OCTG_PREVIEW_UPSTREAM_API_TOKEN`を
   GitHub preview Environment Secret `OCTG_UPSTREAM_API_TOKEN`へ設定します。
   workflowの対象version uploadとCI client seedでPreview専用の値を使用します。
   upstream billing principalを共有する場合も、preview workflowへproduction
   D1/Worker credentialやUsage API keyを渡してはいけません。`scripts/seed-client.mjs` でseed SQLを生成し、
   preview D1へ適用してください。

   ```bash
   printf 'Preview client key: '
   read -r -s OCTG_PREVIEW_CLIENT_KEY
   printf '\n'
   OCTG_KEY_PEPPER="$OCTG_PREVIEW_KEY_PEPPER" \
     node scripts/seed-client.mjs client_ci_smoke "CI Smoke" "$OCTG_PREVIEW_CLIENT_KEY" REJECT > /tmp/octg-preview-seed.sql
   unset OCTG_PREVIEW_CLIENT_KEY
   ```

   生成したSQLをpreview D1へ適用します（preview accountのcredentialだけを使用してください）。

   `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、preview D1 名は、shell の環境変数または
   Cloudflare の認証済み profile へ事前に設定し、値をコマンドラインへ直接記載しないでください。

   ```bash
   ./node_modules/.bin/wrangler d1 execute "$OCTG_PREVIEW_DATABASE_NAME" --remote \
     --file /tmp/octg-preview-seed.sql
   ```

   `OCTG_PREVIEW_KEY_PEPPER` と `OCTG_PREVIEW_CLIENT_KEY` は、ローカルシェル履歴や
   ログへ残らない方法で事前に環境へ設定してください。
   GitHub Environment `preview` の `OCTG_PREVIEW_SMOKE_API_KEY` へ登録し、
   productionのclient keyは使わないでください。
3. GitHub Environment `preview` の **Secrets** に以下を登録します。表の「入力する値」が実値です。

   | Secret名 | 入力する値 |
   | --- | --- |
   | `CLOUDFLARE_PREVIEW_API_TOKEN` | Preview Account用のCloudflare API token |
   | `OCTG_UPSTREAM_API_TOKEN` | Preview Gateway B用token（`AI Gateway: Run`） |
   | `OCTG_PREVIEW_SMOKE_API_KEY` | Preview D1へseedしたCI clientの`octg_sk_*` key |
   | `OCTG_KEY_PEPPER` | Preview D1のhashに使った`OCTG_PREVIEW_KEY_PEPPER` |

   `OCTG_UPSTREAM_API_TOKEN`はCloudflare Dashboardの
   **My Profile → API Tokens → Create Token → Custom token**で発行します。
   Preview Gateway Bを所有するAccountを対象に、Account権限の
   **AI Gateway: Run**を付与してください。
   `OCTG_PREVIEW_UPSTREAM_BASE_URL`が指す`/openai` endpointのtokenです。
   Gateway AのCustom Provider用tokenではありません。
   Secretにはtoken全文だけを入力します。`Bearer`、引用符、Gateway URL、
   OpenAI API keyは付けません。

   ローカル`.env`の名前とGitHub Secretの名前は一部異なります。`--github`は次のように変換します。

   | `.env`の名前 | GitHub Environmentの名前 |
   | --- | --- |
   | `OCTG_PREVIEW_UPSTREAM_API_TOKEN` | `OCTG_UPSTREAM_API_TOKEN` |
   | `OCTG_PREVIEW_KEY_PEPPER` | `OCTG_KEY_PEPPER` |
   | `OCTG_PREVIEW_CLIENT_KEY` | `OCTG_PREVIEW_SMOKE_API_KEY` |
   | `CLOUDFLARE_PREVIEW_API_TOKEN` | `CLOUDFLARE_PREVIEW_API_TOKEN` |

4. **Actions Variables** に以下を登録します:

   | Variable名 | 入力する値 |
   | --- | --- |
   | `CLOUDFLARE_PREVIEW_ACCOUNT_ID` | Preview Account ID（32桁hex。tokenではない） |
   | `OCTG_PREVIEW_DATABASE_ID` | Preview D1 Database ID（UUID） |
   | `OCTG_PREVIEW_UPSTREAM_BASE_URL` | Gateway B endpoint（`/openai`で終了） |
   | `OCTG_PREVIEW_QUOTA_LIMIT_STANDARD` | Preview STANDARD pool上限（`0`で無効） |
   | `OCTG_PREVIEW_QUOTA_LIMIT_MINI` | Preview MINI pool上限（正の整数） |
   | `OCTG_PREVIEW_BASE_URL` | Preview Workerの公開URL |
   | `OCTG_PREVIEW_WORKER_NAME` | 任意。未設定時は`octg-gateway-preview` |
   | `SMOKE_MODEL` | 任意。未設定時は`gpt-5-mini` |

5. production deploy用のSecret `CLOUDFLARE_API_TOKEN` と
   Variable `CLOUDFLARE_ACCOUNT_ID`はproduction workflowだけへ登録し、
   preview environmentへ登録・参照しないでください。

### 運用メモ

- preview smokeは1つの論理テストとして最大3回POSTします。各試行は独立したrequestのため、
  preview MINI poolのquotaを最大3回分消費し得ます。上限値はActions Variablesから一時
  configへ注入し、共有upstreamを使う場合はProduction側のquota配分からPreview分を差し引きます。
- Preview D1/DOのquota stateはProductionと共有しません。同じupstream billing principalを使う場合でも、
  D1共有はquota coordinationの代替になりません。coordination上限を超えるrequestはupstreamへ送らず、
  fail-closedにしてください。
- workflowは専用preview Workerの新 versionを0% trafficでactive deploymentに追加し、
  テスト後に現行version 100%へ復元します。PR smokeとproduction deployは
  `octg-deployment` concurrency groupで直列化されます。
- smoke失敗時のログにはHTTP status、形式検証済みrequest ID、sanitize/truncate済みmessage
  だけを出力し、response bodyやcredentialを出力しません。
- 本番デプロイ失敗時の rollback は Cloudflare deployment version rollback を手動実施します。
- Secret 値は workflow ログへ出力されません。`octg_sk_*` や OpenAI API key をドキュメントやコードへ記載しないでください。

### Durable Object migration の不変条件

`apps/gateway-worker/wrangler.jsonc` の migration は次の順序を維持します。

```jsonc
"migrations": [
  { "tag": "v1", "new_sqlite_classes": ["QuotaController"] },
  { "tag": "v2", "new_sqlite_classes": ["TokenizerController"] }
]
```

- 既に適用した tag を削除・改名・内容変更しないでください。
- TokenizerController は SQLite class として登録されますが、現在の実装は
  `ctx.storage` を使用せず、入力本文・tokenizer state を永続化しません。
- 変更は必ず新しい migration tag の追加として行い、`apps/gateway-worker/wrangler.jsonc`
  を使って Gateway Worker と一緒に deploy します。

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

### デプロイ前の Tokenizer / quota 確認

本番 credential や入力本文をログへ出さず、次の順で確認します。

```bash
npm run typecheck
npm test
npm test -w apps/gateway-worker
npm test -w durable-objects/tokenizer-controller
```

少なくとも、次の条件を満たすことを確認してください。

- `TokenizerController` の exact BPE success 後にだけ `quota_reserve` が発生する。
- `work_limit` は HTTP 413 / `request_too_large` / `reject:request_too_large` となり、
  reservation、in-flight admission、upstream call が発生しない。
- RPC failure、malformed result、RPC preflight ceiling 超過は HTTP 500 /
  `api_error` / `internal_error` / `error:internal_error` となり、reservation、in-flight
  admission、upstream call が発生しない。
- `MAX_INPUT_TEXT_BYTES = 16 * 1024 * 1024 - 65_536` の `inputText` UTF-8 byte 境界を確認する。
  - `MAX_INPUT_TEXT_BYTES - 1` bytes: 受け入れる。
  - `MAX_INPUT_TEXT_BYTES` bytes: 受け入れる。
  - `MAX_INPUT_TEXT_BYTES + 1` bytes: Tokenizer RPC では HTTP 500 / `error:internal_error` で拒否し、
    reservation、in-flight admission、upstream call を実行しない。Worker の HTTP 正規化経路では
    RPC より前に HTTP 413 / `reject:request_too_large` で拒否する。
- token budget の算術異常は HTTP 500 / `api_error` / `internal_error` となり、公開 route は
  `error:internal_error`、resource stage route は `error:arithmetic_error` になる。
- 74,000 token 級 fixture で tokenization 結果が安定し、success response の実 usage で settle される。
- `apps/gateway-worker/wrangler.jsonc` の `TOKENIZER_CONTROLLER` binding と migration `v2` が残っている。

### Worker resource-limit canary

Worker の CPU / memory limit を確認するための canary は、次の wrapper で実行します。
共通の `.env` を使う場合は `--env-file=.env` を明示してください。従来の `admin.env` も後方互換として利用できます。

```bash
npm run canary:worker
```

このコマンドは次の処理を自動で行います。

1. `--env-file` を指定した場合はそのファイルを読み込みます。未指定時は従来どおり root の `admin.env` を読み込みます。ファイルがない状態が通常運用であり、process environment だけでも実行できます。process environment の値が優先されます。
2. `OCTG_CANARY_URL` の hostname から `OCTG_CANARY_ALLOWED_HOSTS` を導出します。明示値を指定する場合も wildcard は使用できません。
3. 74,000 token 級の `gpt-5` chat payload を一時ファイルへ生成し、canary 終了後に削除します。入力本文は出力しません。
4. `CANARY_CONCURRENCY` の既定値 `1,2` と `CANARY_REQUEST_TIMEOUT_MS` の既定値 `120000` を設定します。
5. 検証済みの canary script を起動し、結果 JSON Lines をそのまま出力します。client key、payload、例外文字列は出力しません。

#### 設定値

通常は Secret Manager または CI の環境変数から注入してください。複数の設定を一箇所で管理する場合は root の `.env` を使い、`admin.env` は既存運用との互換用または一時的なローカル実行用に限定してください。

| 変数 | 必須 | 既定値 | 設定内容 |
|---|---:|---|---|
| `OCTG_CANARY_URL` | Yes | なし | Production Worker の `https://<worker-host>/v1/chat/completions`。`OCTG_UPSTREAM_BASE_URL` は使用しない。 |
| `OCTG_CANARY_CLIENT_KEY` | Yes | なし | `/v1/chat/completions` を呼べる専用 Production client key。raw key を commit・共有しない。 |
| `OCTG_CANARY_ALLOWED_HOSTS` | No | URLの hostname | URLの exact hostname を comma 区切りで指定する。port、scheme、wildcard は不可。 |
| `CANARY_CONCURRENCY` | No | `1,2` | 必ず `1` と `2` を含む正の整数。実際の想定ピークを検証する場合は `1,2,8` のように追加する。 |
| `CANARY_REQUEST_TIMEOUT_MS` | No | `120000` | 各 request の timeout。正の safe integer。 |
| `CANARY_PAYLOAD_PATH` | No | 自動生成 | 独自の JSON fixture を使う場合だけ指定する。通常は指定不要。 |

env file から読み込むのは上表の canary 用6変数だけです。Grafana、Terraform、Cloudflare
など他ツールの設定行は無視するため、canary と無関係な行の構文不備で実行を止めません。
canary 用変数の形式は、shell を実行しない単純な assignment だけです。

```text
OCTG_CANARY_URL=https://octg-gateway.example.workers.dev/v1/chat/completions
OCTG_CANARY_ALLOWED_HOSTS=octg-gateway.example.workers.dev
OCTG_CANARY_CLIENT_KEY=<Secret Managerから注入する値>
```

canary 用の行では shell command、command substitution、`${...}` 展開を使用しないでください。
値を Secret Manager から process environment へ注入できる場合は、`admin.env` を作成せずに
`npm run canary:worker` を実行してください。`admin.env` を作成する場合は、次のコマンドで
repository の外からも読み取り権限を制限してください。

```bash
chmod 600 admin.env
```

#### Client key の準備

既存の canary key がある場合は、毎回 seed せずに `OCTG_CANARY_CLIENT_KEY` として注入します。
key がない場合だけ、次の remote seed を一度実行します。

```bash
npm run seed:client:remote -- \
  --id=canary_cpu \
  --name="CPU Canary" \
  --tools-mode=REJECT
```

この seed は Production D1 を変更する write 操作です。`OCTG_KEY_PEPPER`、
`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` が必要です。`OCTG_KEY_PEPPER` は
Production Worker に設定済みの元の値を Secret Manager から注入してください。新しい pepper を
生成すると既存 client key と一致しなくなります。

`seed:client:remote` は client key の raw 値を生成・表示します。出力を CI log や repository に
残さず、Secret Manager に一度だけ保存してください。D1 から raw key を復元することはできません。
key の登録後は seed を繰り返さず、canary の読み取り専用実行だけを行います。

#### Wrapper のオプション

`.env` 以外の一時ファイルを使う場合は `--env-file` を指定します。env file より
process environment の値が優先されます。`--concurrency`、`--timeout-ms`、
`--payload-path` は実行単位の上書き値として使用できます。

```bash
npm run canary:worker -- --env-file=operator-canary.env
npm run canary:worker -- --concurrency=1,2,8
npm run canary:worker -- --timeout-ms=180000
npm run canary:worker -- --payload-path=fixtures/canary.json
```

設定エラーの場合は、次のように不足している変数名だけが表示されます。

```text
octg.canary.config_error
missing: OCTG_CANARY_URL, OCTG_CANARY_CLIENT_KEY
```

この marker は HTTP request を送る前のエラーです。`admin.env` がないこと自体はエラーでは
ありません。`OCTG_KEY_PEPPER` の不足は canary ではなく `seed:client:remote` の設定エラーです。

#### 結果の判定

wrapper の出力は request ごとの status、duration、形式検証済み request ID に加えて、レスポンスから
安全に抽出できる `X-OCTG-Route`、`X-OCTG-Worker-Version`、構造化された error の type / code / param
だけを含みます。response message、response body、credential、例外文字列は出力しません。
CPU limit の判定は出力だけで完了しないため、request ID と worker version を Cloudflare Observability と相関してください。
`route` が `free_shared` の場合は Worker が upstream response を返しており、`responseErrorType`、
`responseErrorCode`、`responseErrorParam` で本文を開示せずに upstream の構造化エラーを確認できます。
`route` が null の場合は Worker 内の入力検証などで返された可能性があるため、同じ request ID の
resource stage event と相関してください。

- canary revision が Production deploy の対象 revision と一致する。
- concurrency `1`、`2`、および指定した想定ピークで accepted request が成功する。
- `$workers.outcome` に `exceededCpu` / `exceededMemory` がない。
- `$workers.cpuTimeMs`、`$workers.wallTimeMs`、memory が実効 limit 内にある。
- `tokenize` stage が成功してから `quota_reserve` が開始される。
- 成功した upstream request が actual usage で settle される。
- canary は Production quota と upstream billing を消費するため、専用 client key と
  upstream が受け付ける最小値 `max_completion_tokens: 16` を使用する。

いずれかの revision、limit、invocation outcome、stage event、quota/upstream 相関が欠ける場合は、
Error 1102 を解消済みと判定せず、未確認として扱います。

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
POST /admin/reconcile/:pool/:utcDay/:targetRequestId
```

`/v1/embeddings`・`/v1/audio/*`・`/v1/images/*` は将来対応。

## Admin Web UI

Cloudflare Access 認証済みの運用者向けに、`/admin/ui/` から Admin API の
ダッシュボードを利用できます。UI は Workers Static Assets として同梱され、
外部 CDN やブラウザへ配布する秘密情報を使用しません。

- `/admin/ui` は `/admin/ui/` に正規化されます。
- `index.html`、`app.js`、`api.js`、`render.js`、`editors.js`、`styles.css`、
  `pico.min.css` は Access JWT 検証後に Worker の `ASSETS` binding から配信されます。
- Quota、Usage、Clients、Models を表示し、Clients と Models はインライン編集できます。
- Usage は `client_id` 昇順、Quota は STANDARD、MINI の固定順で表示されます。
- 保存成功時は該当 API を再取得し、取得・保存失敗時は対象 section または行に
  エラーと再試行操作を表示します。

### Admin UI のデプロイ確認

本番デプロイ後、次の順序で Access と Worker の境界を確認してください。

1. `/admin/*` を保護する Access application が存在し、AUD が `ACCESS_AUD` と一致する。
2. JWT なしの `/admin/ui/`、`/admin/ui/app.js`、`/admin/ui/styles.css`、
   `/admin/ui/pico.min.css` が拒否される。
3. 認証済み UI が同一 origin の API を取得し、外部 CDN request が発生しない。
4. 有効な JWT と `Origin: https://attacker.example` を付けた
   `PUT /admin/clients/:id/policy`、`PUT /admin/models/:model`、`POST /admin/reconcile`、
   `POST /admin/reconcile/:pool/:utcDay/:targetRequestId` が全て 403
   `origin_not_allowed` になり、状態を変更しない。
5. Origin なしの有効な JWT を使う既存の管理 CLI が引き続き利用できる。

Worker 統合テストは次で実行できます。

```bash
npm test -w apps/gateway-worker -- test/admin-ui.test.ts
node --check apps/gateway-worker/public/admin/ui/api.js
node --check apps/gateway-worker/public/admin/ui/render.js
node --check apps/gateway-worker/public/admin/ui/app.js
node --check apps/gateway-worker/public/admin/ui/editors.js
```

## 既知の限界

課金 0 円の完全保証はしない。conservative reservation + fail-closed + OpenAI reconciliation の三重防御（詳細は SPEC.md §15 参照）。監査ログは best-effort で配送欠損を許容する（authoritative な制御は DO が担う）。

## Tokenizer の監視・運用

- `MAX_INPUT_BYTES` は二段階で適用されます。raw body は JSON parse 前に、正規化済み入力は
  JSON parse・正規化後かつ Tokenizer RPC 前に検査します。未設定・不正値時と現行 deployment
  の既定値は 1 MiB です。いずれかの段階で超過した場合は reservation / in-flight admission /
  upstream の前に HTTP 413 で拒否されます。
- `MAX_IN_FLIGHT_REQUESTS` は pool ごとの upstream 同時実行上限です。既定値は 2 で、上限到達時は
  reservation を解放して HTTP 429 `worker_concurrency_exceeded` を返します。SSE の lease は
  generation と TTL で保護され、定期更新に失敗した場合は fail-closed で終了します。
- Tokenizer の custom stage event は request ID、revision、stage、duration、safe な byte/token 数、
  allowlist 済み outcome だけを記録します。入力本文、Authorization、API key、encoder 例外文字列は記録しません。
- Tokenizer RPC が利用できない場合は `500 internal_error` として fail-closed になります。
  この場合に local BPE、未検証の byte 比率式、paid fallback を有効化しないでください。
- 74,000 token 級 payload の canary は、同じ revision の Workers invocation outcome、CPU/wall time、
  Tokenizer stage、quota reserve、upstream 到達を request ID で相関して確認します。

### ロールバック

- Durable Object migration は不可逆として扱い、適用済みの `v1` / `v2` を削除・改名・再利用しません。
- アプリケーションを戻す場合は Cloudflare の deployment version rollback を使い、`v2` binding を含む
  manifest を維持します。rollback のために Gateway や shared package へ local BPE を戻さないでください。
- rollback 後は `/v1/chat/completions` または `/v1/responses` の小さい非機密 fixture で、
  `quota_reserve` と upstream が成功すること、`/quota` の状態が不自然に減っていないことを確認します。
- Tokenizer RPC failure が継続する場合は、原因が解消するまで再試行を増やさず fail-closed のままにし、
  revision ID と安全な stage event だけを記録します。

## 今回のレビューで未対応とした項目

`handleAdmin` のルート別 handler への分割は、今回の修正では実施していない。これは機能不具合ではなく構造改善であり、JWT 検証、入力検証、エラー境界、reconciliation の挙動修正とは独立しているため、変更範囲と回帰リスクを抑える目的で保留した。
