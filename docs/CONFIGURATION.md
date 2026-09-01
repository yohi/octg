<!-- markdownlint-disable MD013 -->

# OCTG 設定カタログ

この文書は、OCTG の設定値について「何に使うか」「どこで取得するか」「どこへ設定するか」をまとめたものです。
値の入力テンプレートはリポジトリルートの `.env.example` に集約しています。

```bash
cp .env.example .env
chmod 600 .env
```

`.env` は gitignore 対象です。実Secret、`octg_sk_*`、OpenAI API key、Cloudflare API tokenをコミット、ログ出力、コマンドライン引数へ置かないでください。

## 最短手順

### Local

Local開発だけなら、入力なしで安全な開発用既定値を使えます。

```bash
npm install
npm run setup:local -- --env-file=.env
npm run dev -w apps/gateway-worker
```

既存の `apps/gateway-worker/.dev.vars` は上書きされません。意図的に作り直す場合だけ `--force` を追加します。

### Production

D1、Gateway B、Access applicationをCloudflare側で先に作成し、`.env`のProductionセクションへ値を入力します。セットアップスクリプトはリソースを新規作成しません。

```bash
npm run setup:deploy -- --env-file=.env --dry-run
npm run setup:deploy -- --env-file=.env
```

`--dry-run`では、`wrangler.jsonc`更新、Secret登録、D1 migration、Worker deployを行いません。ProductionのSecretが`.env`にない場合は、スクリプトがwranglerの入力を開きます。

### Preview

Previewは専用のCloudflare account、Worker、D1、client、pepperを使用します。Productionの値を再利用しないでください。

```bash
zsh scripts/setup-preview.zsh --dry-run
zsh scripts/setup-preview.zsh
```

Preview用の値は`.env`の`PREVIEW`セクションへ入力します。`--github`を付けると、GitHub Environment `preview`へVariables/Secretsを設定します。

```bash
zsh scripts/setup-preview.zsh --github
```

## 取得・確認用URLとコマンド

### Cloudflare accountとWrangler認証

Cloudflare Dashboardは <https://dash.cloudflare.com/> から開きます。Account IDはDashboardのAccount Overviewで確認できます。また、Wranglerの認証状態とAccount IDは次で確認できます。

```bash
npx wrangler login
npx wrangler whoami
```

Production用のAPI tokenはDashboardの **My Profile → API Tokens** で作成します。対象Accountだけを選び、必要なWorkers/D1/Access/AI Gateway権限を付与してください。token値は`CLOUDFLARE_API_TOKEN`としてprocess environmentまたは`.env`へ安全に注入します。

### D1 database ID

Dashboardの **Workers & Pages → D1** で対象データベースのDatabase IDを確認できます。Wranglerでも既存D1を一覧できます。

```bash
npx wrangler d1 list --json
npx wrangler d1 create octg
```

`create`は新規D1を作成するwrite操作です。既存D1を使う場合は`list --json`の名前とIDを確認し、`OCTG_DATABASE_ID`へ設定してください。

### AI Gateway BのURL

Dashboardの **Workers & Pages → AI Gateway** でWorkerからOpenAIへ接続するGateway Bを開き、**API/Endpoints → OpenAI** に表示されるendpointをコピーします。Worker用の値は次の形式です。

```text
https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_b_id>/openai
```

これは`OCTG_UPSTREAM_BASE_URL`です。利用者向けCustom ProviderのGateway A URLとは別の値です。Gateway BにはOpenAI ProjectのBYOK設定と、Workerから呼べるRun tokenが必要です。

### Cloudflare Accessの値

<https://one.dash.cloudflare.com/> の **Access → Applications** から対象Self-hosted applicationを開きます。Overviewに表示される次の値を使用します。

- `ACCESS_TEAM_DOMAIN`: Team domain
- `ACCESS_AUD`: Application Audience (AUD) Tag

Access applicationを先に作成し、`/admin/*`を保護するpolicyを設定してください。`.workers.dev` URLをAccess application domainへ直接指定しないでください。カスタムドメインを使用します。

### OpenAI Usage API key

<https://platform.openai.com/> の **Organization → API keys** から、Usage APIの読み取り権限を持つkeyを作成します。`OPENAI_USAGE_API_KEY`としてWorker Secretへ登録し、ファイルやログへ保存しません。

### Secret用のランダム値

`OCTG_KEY_PEPPER`など新規Secretの候補はローカル端末で生成できます。

```bash
openssl rand -hex 32
```

表示された値をshell historyへ残さず、`wrangler secret put`の入力またはSecret Managerへ登録してください。`OCTG_KEY_PEPPER`は既存clientをseedした値と一致させます。

### Preview resource

Preview専用Accountのcredentialを使って、Preview D1を確認します。Productionのcredentialを指定しないでください。

```bash
CLOUDFLARE_API_TOKEN="$CLOUDFLARE_PREVIEW_API_TOKEN" \
  CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_PREVIEW_ACCOUNT_ID" \
  npx wrangler d1 list --json

zsh scripts/setup-preview.zsh --dry-run
zsh scripts/setup-preview.zsh
```

Preview用の入力は`.env`の`CLOUDFLARE_PREVIEW_*`、`OCTG_PREVIEW_*`、`OCTG_PREVIEW_KEY_PEPPER`へ分けて記載します。

### Deno tokenizer

Deno Deploy appとaccess tokenは <https://console.deno.com/account/access-tokens> で取得します。Health checkとデプロイの詳細は[deno-tokenizer.md](./deno-tokenizer.md)を参照してください。

```bash
curl https://<deno-project>.deno.dev/health
deno task check
deno task test
```

### Worker canary

`OCTG_CANARY_URL`はProduction WorkerのURLへ`/v1/chat/completions`を付けた値です。Worker versionとCPU/wall timeはCloudflare DashboardのWorker Observabilityでrequest IDを検索します。

```bash
npm run canary:worker -- --env-file=.env
```

### OpenCode Gateway A

Gateway AのCustom Provider設定は[cloudflare-ai-gateway-custom-provider.md](./cloudflare-ai-gateway-custom-provider.md)を参照してください。Account ID、Gateway ID、Run tokenはGateway Bと共有せず、次の変数へ設定します。

```bash
OCTG_CF_ACCOUNT_ID=<gateway-a-account-id>
OCTG_CF_GATEWAY_ID=<gateway-a-id>
OCTG_CF_API_TOKEN=<gateway-a-run-token>
```

## 値の解決順序

セットアップスクリプトは次の順で値を解決します。

1. コマンドラインオプション
2. process environment
3. `--env-file`で指定したファイル
4. 安全な既定値
5. 対話入力

env fileはshellとして実行せず、単純な`KEY=value`または`export KEY=value`として解析します。未知の変数は各スクリプトから無視されます。Preview setupはPreview用のallow-listだけを読み込み、Productionの`OCTG_KEY_PEPPER`をPreview用pepperへフォールバックしません。

## Local設定

| 変数 | Secret | 設定先 | 取得・決定方法 |
| --- | ---: | --- | --- |
| `OCTG_LOCAL_KEY_PEPPER` | Yes | `.dev.vars` | Local専用に任意の値を使用。既定値は`dev-pepper` |
| `OCTG_LOCAL_UPSTREAM_BASE_URL` | No | `.dev.vars` | Gateway BのOpenAI endpoint。Localでは未設定ならplaceholder |
| `OCTG_LOCAL_UPSTREAM_API_TOKEN` | Yes | `.dev.vars` | Local用Gateway B token。既定値は`dev-token` |
| `OCTG_LOCAL_OPENAI_USAGE_API_KEY` | Yes | `.dev.vars` | Local reconciliation用。既定値は`dev-usage-key` |
| `OCTG_LOCAL_CLIENT_ID` | No | Local D1 | 既定値は`client_demo` |
| `OCTG_LOCAL_CLIENT_NAME` | No | Local D1 | 既定値は`Demo` |
| `OCTG_LOCAL_CLIENT_KEY` | Yes | Local D1 seed | 空欄なら`octg_sk_local_`形式で生成 |
| `OCTG_LOCAL_CLIENT_TOOLS_MODE` | No | Local D1 | `ALLOW`または`REJECT`。既定値は`REJECT` |

既存利用者向けに、process environmentで従来の`OCTG_KEY_PEPPER`、`OCTG_UPSTREAM_BASE_URL`などを指定する方法も維持しています。共通`.env`ではProduction値のLocal流用を防ぐため、`OCTG_LOCAL_*`を使用してください。

## Production設定

### Worker vars

| 変数 | Secret | 設定先 | 取得場所 |
| --- | ---: | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | No | Wrangler環境 | Cloudflare DashboardのAccount ID、または`wrangler whoami` |
| `OCTG_DATABASE_ID` | No | `wrangler.jsonc`のD1 binding | Cloudflare D1のDatabase ID。既存のD1を使用 |
| `OCTG_UPSTREAM_BASE_URL` | No | `wrangler.jsonc`のvars | Gateway BのOpenAI endpoint。Gateway AのCustom Provider URLではない |
| `ACCESS_TEAM_DOMAIN` | No | `wrangler.jsonc`のvars | Access applicationのOverviewに表示されるteam domain |
| `ACCESS_AUD` | No | `wrangler.jsonc`のvars | Access applicationのApplication Audience (AUD) Tag |

`OCTG_UPSTREAM_BASE_URL`は次のGateway B形式です。

```text
https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_b_id>/openai
```

Gateway AのCustom Provider URLは利用者側OpenCode設定用であり、Workerのupstream URLへ設定しないでください。

### Worker Secrets

| 変数 | 設定先 | 取得・生成方法 |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Wrangler認証 | 対象AccountのWorkers/D1等を操作できるtoken。process environmentまたは`.env`へ安全に注入 |
| `OCTG_KEY_PEPPER` | Production Worker Secret | 長いランダム値を生成。既存clientをseedしたpepperと一致させる |
| `OCTG_UPSTREAM_API_TOKEN` | Production Worker Secret | Gateway BのAI Gateway Run token |
| `OPENAI_USAGE_API_KEY` | Production Worker Secret | OpenAI Organization Usage APIの読み取り用key |

Secretは`wrangler secret put`でCloudflareへ登録され、リポジトリのファイルへ保存されません。`OCTG_KEY_PEPPER`を変更すると既存client keyのhashと一致しなくなるため、通常のSecret rotationと分けて計画してください。

## Preview設定

Previewの変数は全て`OCTG_PREVIEW_*`または`CLOUDFLARE_PREVIEW_*`です。Productionの同名リソースを指定しないでください。`.env`からPreview setupへ渡すpepperは`OCTG_PREVIEW_KEY_PEPPER`です。GitHub Environmentへ同期する際だけSecret名`OCTG_KEY_PEPPER`へ変換されます。

| 変数 | Secret | 設定先 | 取得・決定方法 |
| --- | ---: | --- | --- |
| `CLOUDFLARE_PREVIEW_ACCOUNT_ID` | No | Preview Wrangler認証 | Preview専用AccountのID |
| `CLOUDFLARE_PREVIEW_API_TOKEN` | Yes | Preview setup/GitHub Secret | Preview resourceだけに限定したtoken |
| `OCTG_PREVIEW_UPSTREAM_API_TOKEN` | Yes | Preview setup/GitHub Secret `OCTG_UPSTREAM_API_TOKEN` | Preview Gateway BのRun token。Production tokenと共有しない |
| `OCTG_PREVIEW_DATABASE_ID` | No | 一時Preview Wrangler config | Preview D1 Database ID。空欄なら既存名を検索し、なければ作成後にIDを入力 |
| `OCTG_PREVIEW_DATABASE_NAME` | No | Preview D1 | 既定値は`octg-gateway-preview-db` |
| `OCTG_PREVIEW_WORKER_NAME` | No | Preview Worker | 既定値は`octg-gateway-preview` |
| `OCTG_PREVIEW_UPSTREAM_BASE_URL` | No | Preview Worker vars | Preview用Gateway B endpoint |
| `OCTG_PREVIEW_BASE_URL` | No | Preview workflow | Preview Workerの公開URL |
| `OCTG_PREVIEW_QUOTA_LIMIT_STANDARD` | No | Preview Worker vars | Preview STANDARD pool上限。`0`で無効 |
| `OCTG_PREVIEW_QUOTA_LIMIT_MINI` | No | Preview Worker vars | Preview MINI pool上限。正の整数 |
| `OCTG_PREVIEW_CLIENT_ID` | No | Preview D1 | CI用client ID |
| `OCTG_PREVIEW_CLIENT_NAME` | No | Preview D1 | CI用client名 |
| `OCTG_PREVIEW_CLIENT_KEY` | Yes | Preview D1/GitHub Secret | `octg_sk_*`形式のPreview専用key |
| `OCTG_PREVIEW_KEY_PEPPER` | Yes | Preview D1/GitHub Secret | Preview専用pepper。Productionと別の値 |
| `GITHUB_REPOSITORY` | No | GitHub CLI | `owner/repository`形式。`--github`時のみ必須 |
| `SMOKE_MODEL` | No | GitHub Environment Variable | 既定値は`gpt-5-mini` |

## Deno tokenizer設定

Deno tokenizerはopt-inです。全ての設定を一緒に用意し、ProductionとPreviewでendpoint・tokenを分けます。

| 変数 | 設定先 | 取得・決定方法 |
| --- | --- | --- |
| `DENO_DEPLOY_ORG` | Deno Deploy manifest/GitHub Variable | Deno Deployのorganization |
| `DENO_DEPLOY_APP` | Deno Deploy manifest/GitHub Variable | Deno Deployのapplication |
| `DENO_DEPLOY_TOKEN` | Deno Deploy Secret | Deno Deploy access token。ファイルへ保存しない |
| `DENO_TOKENIZER_ENDPOINT` | Worker vars | Deno Deployの`/tokenize` HTTPS endpoint |
| `DENO_TOKENIZER_AUTH_TOKEN` | Deno Deploy/Worker Secret | WorkerとDenoで共有する認証token |
| `DENO_TOKENIZER_THRESHOLD_BYTES` | Worker vars | 測定済みの有効化threshold |
| `DENO_TOKENIZER_TIMEOUT_MS` | Worker vars | 測定済みのtimeout |

`DENO_TOKENIZER_*`を部分的に設定するとfail-closedになります。全て未設定の場合だけCloudflare Durable Object tokenizerが使用されます。詳細は[deno-tokenizer.md](./deno-tokenizer.md)を参照してください。

## Worker canary設定

```bash
npm run canary:worker -- --env-file=.env
```

| 変数 | Secret | 設定先 | 取得・決定方法 |
| --- | ---: | --- | --- |
| `OCTG_CANARY_URL` | No | canary実行環境 | Production Workerの`/v1/chat/completions` URL |
| `OCTG_CANARY_ALLOWED_HOSTS` | No | canary実行環境 | URLと同じexact hostname。wildcard不可 |
| `OCTG_CANARY_CLIENT_KEY` | Yes | canary実行環境 | 専用Production client key。Production quotaを消費 |
| `CANARY_PAYLOAD_PATH` | No | canary実行環境 | 独自fixtureを使う場合だけ指定 |
| `CANARY_CONCURRENCY` | No | canary実行環境 | 既定値`1,2`。想定ピークを追加可能 |
| `CANARY_REQUEST_TIMEOUT_MS` | No | canary実行環境 | 既定値`120000` |

canaryの結果にはresponse bodyやmessageを出さず、request ID・Worker version・安全なstructured errorだけを出力します。CPU/memory制限はrequest IDとrevisionをCloudflare Observabilityで相関して確認します。

## OpenCode設定

OpenCodeでGateway AのCustom Providerを使う場合のクライアント側変数です。

| 変数 | 設定先 | 取得場所 |
| --- | --- | --- |
| `OCTG_CF_ACCOUNT_ID` | OpenCode環境 | Gateway AのCloudflare Account ID |
| `OCTG_CF_GATEWAY_ID` | OpenCode環境 | Gateway AのAI Gateway ID |
| `OCTG_CF_API_TOKEN` | OpenCode環境/Secret Manager | Gateway A Custom ProviderのRun token |

Gateway AとGateway Bは別のAI Gateway instanceにしてください。OpenCodeの設定ファイルへ`octg_sk_*`やRun tokenの実値を書かないでください。詳細は[cloudflare-ai-gateway-custom-provider.md](./cloudflare-ai-gateway-custom-provider.md)を参照してください。

## セットアップの安全動作

- Localの既存`.dev.vars`は`--force`なしで保護されます。
- Productionのplaceholder（`<...>`）は適用前に拒否されます。
- `--dry-run`ではCloudflare/GitHubへのwrite操作を行いません。
- Production setupは既存D1、Gateway B、Access applicationだけを使用します。
- Preview setupは一時configを使い、ProductionのD1 bindingを変更しません。
- `.env`から読み込んだ未知の変数は無視し、関連しないGrafana/Terraform設定に影響されません。
