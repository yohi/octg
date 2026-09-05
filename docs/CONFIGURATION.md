<!-- markdownlint-disable MD013 -->

# OCTG 設定カタログ

この文書は、OCTG の設定値について「何に使うか」「どこで取得するか」「どこへ設定するか」をまとめたものです。
値の入力テンプレートはリポジトリルートの `.env.example` に集約しています。

```bash
cp .env.example .env
chmod 600 .env
```

`.env` は gitignore 対象です。実Secret、`octg_sk_*`、OpenAI API key、Cloudflare API tokenをコミット、ログ出力、コマンドライン引数へ置かないでください。

## 最初に読むルール

- `Secret` は値をログ、リポジトリ、コマンドライン引数へ置かず、Secret managerまたは対話入力から登録します。
- `Variable` は機密でない設定値ですが、Production/Previewのリソース境界を越えて共有しません。
- `DENO_DEPLOY_TOKEN` はDeno Deploy管理用です。Deno tokenizer HTTP認証には使用しません。
- Productionの共有Deno認証値はGitHub Environment `deno-production`のSecret `PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN`として一度だけ登録します。workflowがWorker binding `DENO_TOKENIZER_AUTH_TOKEN`とDeno runtime `OCTG_TOKENIZER_AUTH_TOKEN`へ安全に配布します。
- ProductionとPreviewではAccount、Worker、D1、Durable Object、Gateway、pepper、client key、Deno applicationを分離します。

## Quick start（最短手順）

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

### Preview configuration

Previewは専用のCloudflare account、Worker、D1、client、pepperを使用します。Productionの値を再利用しないでください。

```bash
zsh scripts/setup-preview.zsh --dry-run
zsh scripts/setup-preview.zsh
```

Preview用の値は`.env`の`PREVIEW`セクションへ入力します。`--github`を付けると、GitHub Environment `preview`へVariables/Secretsを設定します。

```bash
zsh scripts/setup-preview.zsh --github
```

## Production初回デプロイの設定順

既存リソースを使うProductionでは、最初にDeno無効のWorkerをcanaryし、そこで
Worker本体・quota・resource limitを確認してからDeno経路を有効化します。各値の取得場所と
設定先は、後述のカタログを正とします。

1. Cloudflare Account、D1、Gateway B、Access applicationを準備し、
   `CLOUDFLARE_API_TOKEN`を対象Accountに限定して注入します。
2. Workerの通常Variablesを設定し、`MAX_INPUT_BYTES`のraw値を決めます。
   Deno integrationの4設定（endpoint、Worker auth Secret、threshold、timeout）はbaseline versionへ
   まだ設定しません。Production用の既存`wrangler.jsonc`にDeno値がある場合は、4設定を除外した
   baseline用の一時設定を使います。
3. 既存Workerでは、VariablesとSecretsをinactive versionへ揃えてから一度だけactiveにします。
   `versions upload`はdeployせず、後続の`versions secret put`もinactive versionだけを作成します。

   ```bash
   baseline_config="${BASELINE_WRANGLER_CONFIG:?Deno設定を除外したbaseline config pathを指定してください}"
   npx wrangler versions upload \
     --config "$baseline_config" \
     --message "OCTG baseline"
   npx wrangler versions secret put OCTG_KEY_PEPPER \
     --config "$baseline_config"
   npx wrangler versions secret put OCTG_UPSTREAM_API_TOKEN \
     --config "$baseline_config"
   npx wrangler versions secret put OPENAI_USAGE_API_KEY \
     --config "$baseline_config"
   ```

   `versions secret put`は対話入力またはstdinからSecretを受け取り、値をコマンドラインや文書へ
   書きません。既存versionに`DENO_TOKENIZER_AUTH_TOKEN`がある場合は、baselineをdeployする前に
   最新のinactive versionから削除します。未登録の場合はこの削除操作を省略します。

   ```bash
   npx wrangler versions secret delete DENO_TOKENIZER_AUTH_TOKEN \
     --config "$baseline_config"
   ```

   deploy前に`wrangler versions view <version-id>`またはDashboardで、endpoint、threshold、timeout、
   `DENO_TOKENIZER_AUTH_TOKEN`が全てunsetであること、通常Variablesと3つのProduction Secret bindingが
   揃っていることを確認します。初回Worker作成では`versions upload`を使えないため、
   [テンプレート手順](./DEPLOY_FROM_TEMPLATE.md)の初回作成フローを使います。

   ```bash
   npx wrangler versions deploy --config "$baseline_config"
   ```

   段階的deployを使えない既存Workerでも、Productionの通常更新はworkflowに限定します。
   `wrangler secret put`、`wrangler secret delete`、通常の`wrangler deploy`でDeno設定を個別に更新しないでください。
   緊急復旧で手動操作が避けられない場合だけ、[Deno tokenizer手順](./deno-tokenizer.md)のemergency
   recoveryにあるversioned deploy手順を使用し、Workerへ登録する認証値は
   `PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN`と一致させます。Deno runtime Secretは同じsourceから
   Deno Deploy workflowで反映します。

4. Deno Deployを使う場合だけ、GitHub Environment `deno-production`へ
   `DENO_DEPLOY_ORG`、`DENO_DEPLOY_APP`、Secret `DENO_DEPLOY_TOKEN`、および
   Secret `PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN`を登録します。前者はDeno Deployの管理用、
   後者はWorkerとDeno runtimeで共有する認証値です。
5. Productionの既存`OCTG_KEY_PEPPER`を使って専用clientを一度だけseedし、raw keyを
   Secret Managerへ保存します。raw keyをログ、shell history、repositoryへ残しません。
6. `OCTG_CANARY_URL`と`OCTG_CANARY_CLIENT_KEY`をSecret Managerから注入して初回canaryを実行します。
   このcanaryはCloudflare Durable Object tokenizer経路を対象とし、Worker resource limit、quota
   reserve/settle、upstream到達を確認します。判定基準は「Worker canary設定」と「Quota受け入れ条件」に従います。
7. 初回canary合格後、Deno Deploy applicationをdeployしてhealthを確認します。
   `PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN`をGitHub Environment `deno-production`へ登録すると、
   ProductionのDeno Deploy workflowがruntime Secret `OCTG_TOKENIZER_AUTH_TOKEN`へ反映します。
8. 対象Workerへ`DENO_TOKENIZER_ENDPOINT`、`DENO_TOKENIZER_THRESHOLD_BYTES`、
   `DENO_TOKENIZER_TIMEOUT_MS`をRepository Variablesとして登録します。Production Worker workflowは
   `PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN`からWorker Secret `DENO_TOKENIZER_AUTH_TOKEN`を同じversionへ
   注入します。`MAX_INPUT_BYTES`はWorkerとDeno Deployへ同じraw値を設定し、4つのDeno integration設定を
   部分適用しません。
   workflowを実行できない緊急復旧に限り、既存Workerの手動更新では
   `wrangler versions upload --secrets-file`でinactive versionを作成し、4設定を同じversionへ
   揃えてから`wrangler versions deploy`で一度だけactiveにします。通常の`wrangler secret put`を
   途中で使いません。
9. WorkerとDenoのresolved `MAX_INPUT_BYTES`を照合した後、同じcanary clientでDeno経路canaryを実行します。
    Deno providerの選択、tokenization stage、quota lifecycle、upstream到達を初回canaryと比較します。

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

表示された値をshell historyへ残さず、既存Workerでは`wrangler versions secret put`の入力または
Secret Managerへ登録してください。`OCTG_KEY_PEPPER`は既存clientをseedした値と一致させます。

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

## Configuration catalog（設定カタログ）

### Local development

| Name | Kind | Consumer | Set in | Obtain or decide | Apply |
| --- | --- | --- | --- | --- | --- |
| `OCTG_LOCAL_KEY_PEPPER` | Secret | Local Worker | `.env` → `.dev.vars` | Local専用値。既定値は`dev-pepper` | `npm run setup:local` |
| `OCTG_LOCAL_UPSTREAM_BASE_URL` | Variable | Local Worker | `.env` → `.dev.vars` | Gateway BのOpenAI endpoint。未設定時はplaceholder | `npm run setup:local` |
| `OCTG_LOCAL_UPSTREAM_API_TOKEN` | Secret | Local Worker | `.env` → `.dev.vars` | Local用Gateway B token。既定値は`dev-token` | `npm run setup:local` |
| `OCTG_LOCAL_OPENAI_USAGE_API_KEY` | Secret | Local reconciliation | `.env` → `.dev.vars` | Local用Usage API key。既定値は`dev-usage-key` | `npm run setup:local` |
| `OCTG_LOCAL_CLIENT_ID` | Variable | Local D1 seed | `.env`または既定値 | 既定値は`client_demo` | `npm run setup:local` |
| `OCTG_LOCAL_CLIENT_NAME` | Variable | Local D1 seed | `.env`または既定値 | 既定値は`Demo` | `npm run setup:local` |
| `OCTG_LOCAL_CLIENT_KEY` | Secret | Local D1 seed | `.env`または対話入力 | 空欄なら`octg_sk_local_`形式で生成 | `npm run setup:local` |
| `OCTG_LOCAL_CLIENT_TOOLS_MODE` | Variable | Local D1 policy | `.env`または既定値 | `ALLOW`または`REJECT`。既定値は`REJECT` | `npm run setup:local` |

既存利用者向けに、process environmentで従来の`OCTG_KEY_PEPPER`、`OCTG_UPSTREAM_BASE_URL`などを指定する方法も維持しています。共通`.env`ではProduction値のLocal流用を防ぐため、`OCTG_LOCAL_*`を使用してください。

### Production Cloudflare deploy authentication

| Name | Kind | Consumer | Set in | Obtain or decide | Apply |
| --- | --- | --- | --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | setup script / Wrangler | process environmentまたは`.env` | 対象Production Account ID。`wrangler whoami`でも確認 | `setup:deploy`またはWrangler command |
| `CLOUDFLARE_API_TOKEN` | Secret | setup script / Wrangler | process environmentまたは`.env` | 対象Accountだけに必要権限を限定 | `setup:deploy`またはWrangler command |

### Production Worker runtime

#### Worker vars

| Name | Kind | Consumer | Set in | Obtain or decide | Apply |
| --- | --- | --- | --- | --- | --- |
| `OCTG_DATABASE_ID` | Variable | Gateway Worker D1 binding | `wrangler.jsonc` | 既存Production D1のDatabase ID | `setup:deploy`または設定後deploy |
| `OCTG_UPSTREAM_BASE_URL` | Variable | Gateway Worker upstream | `wrangler.jsonc` vars | Gateway BのOpenAI endpoint。Gateway Aとは別 | 設定後Worker deploy |
| `ACCESS_TEAM_DOMAIN` | Variable | Gateway Worker Admin auth | `wrangler.jsonc` vars | Access applicationのTeam domain | 設定後Worker deploy |
| `ACCESS_AUD` | Variable | Gateway Worker Admin auth | `wrangler.jsonc` vars | Access applicationのAUD Tag | 設定後Worker deploy |
| `MAX_INPUT_BYTES` | Variable | Gateway Worker and Deno tokenizer | Worker vars + Deno runtime environment | 両runtimeへ同じraw値。既定1 MiB、`MAX_INPUT_TEXT_BYTES`でclamp | 両runtime deploy後にresolved value照合 |
| `QUOTA_LIMIT_STANDARD` | Variable | Gateway Worker quota policy | `wrangler.jsonc` vars | Production STANDARD pool上限 | Worker deploy |
| `QUOTA_LIMIT_MINI` | Variable | Gateway Worker quota policy | `wrangler.jsonc` vars | Production MINI pool上限 | Worker deploy |
| `MAX_IN_FLIGHT_REQUESTS` | Variable | Gateway Worker admission | `wrangler.jsonc` vars | upstream同時実行上限。既定値は2 | Worker deploy |
| `IN_FLIGHT_LEASE_TTL_MS` | Variable | Gateway Worker admission | `wrangler.jsonc` vars | in-flight lease TTL | Worker deploy |
| `IN_FLIGHT_LEASE_RENEWAL_MS` | Variable | Gateway Worker admission | `wrangler.jsonc` vars | streaming lease renewal interval | Worker deploy |

`OCTG_UPSTREAM_BASE_URL`は次のGateway B形式です。

```text
https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_b_id>/openai
```

Gateway AのCustom Provider URLは利用者側OpenCode設定用であり、Workerのupstream URLへ設定しないでください。

#### Worker Secrets

| Name | Kind | Consumer | Set in | Obtain or decide | Apply |
| --- | --- | --- | --- | --- | --- |
| `OCTG_KEY_PEPPER` | Secret | Gateway Worker client authentication | Production Worker Secret | 長いランダム値。既存clientをseedした値と一致させる | inactive versionへ登録後にdeploy |
| `OCTG_UPSTREAM_API_TOKEN` | Secret | Gateway Worker → Gateway B | Production Worker Secret | Gateway BのAI Gateway Run token | inactive versionへ登録後にdeploy |
| `OPENAI_USAGE_API_KEY` | Secret | Reconciliation Worker | Production Worker Secret | OpenAI Organization Usage API read key | inactive versionへ登録後にdeploy |

既存WorkerのSecret更新は`wrangler versions secret put`でinactive versionへ登録し、
`wrangler versions deploy`で設定済みのversionを反映します。Secretはリポジトリのファイルへ保存されません。
初回Worker作成時の標準`wrangler secret put`は[テンプレート手順](./DEPLOY_FROM_TEMPLATE.md)に限定します。
`OCTG_KEY_PEPPER`を変更すると既存client keyのhashと一致しなくなるため、通常のSecret rotationと分けて計画してください。

### Production Deno integration

Deno tokenizerはopt-inです。全ての設定を一緒に用意し、ProductionとPreviewでendpoint・tokenを分けます。
Production Workerの3つの非Secret設定はGitHub Repository Variablesをsource of truthとし、
`.github/workflows/deploy-production.yml`が毎回のProduction deploy前に検証してWorkerへ注入します。
`apps/gateway-worker/wrangler.jsonc`へ環境固有の値を追加したり、通常運用でWorker dashboardへ手動設定したりしません。

| Name | Kind | Consumer | Set in | Obtain or decide | Apply |
| --- | --- | --- | --- | --- | --- |
| `DENO_TOKENIZER_ENDPOINT` | Variable | Gateway Worker | GitHub Repository Variable | Deno Deployの`/tokenize` HTTPS endpoint | `.github/workflows/deploy-production.yml` |
| `PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN` | Secret | Production Worker and Deno Deploy workflows | GitHub Environment `deno-production` | WorkerとDeno runtimeで共有する認証token | 両workflowが各runtimeへ反映 |
| `DENO_TOKENIZER_AUTH_TOKEN` | Secret | Gateway Worker → Deno | Worker Secret | `PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN`から生成されるversion Secret | Production Worker workflow |
| `OCTG_TOKENIZER_AUTH_TOKEN` | Secret | Deno tokenizer runtime | Deno Deploy runtime environment | `PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN`から反映される認証token | Deno Deploy workflow |
| `DENO_TOKENIZER_THRESHOLD_BYTES` | Variable | Gateway Worker router | GitHub Repository Variable | 測定済みの有効化threshold | `.github/workflows/deploy-production.yml` |
| `DENO_TOKENIZER_TIMEOUT_MS` | Variable | Gateway Worker client | GitHub Repository Variable | 測定済みのtimeout | `.github/workflows/deploy-production.yml` |

Productionの共有認証値は`PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN`としてGitHub Environment
`deno-production`へ登録してください。Production Worker workflowはこのSecretを一時ファイルから
Worker version Secret `DENO_TOKENIZER_AUTH_TOKEN`へ注入し、Deno Deploy workflowは同じ値を一時dotenv
からruntime Secret `OCTG_TOKENIZER_AUTH_TOKEN`へloadします。`DENO_DEPLOY_TOKEN`は管理用の別Secretで、
tokenizer HTTP認証には使いません。3つの非Secret Production Worker値はGitHub Repository Variablesへ
登録し、Productionの通常deployではworkflowから注入します。

`MAX_INPUT_BYTES`はProduction Worker vars表にある共有設定です。Deno Deploy runtime environmentにも
同じraw値を設定し、WorkerとDenoの各deploy後に`resolveMaxInputBytes`でresolved valueを確認します。
raw値またはresolved valueが一致しない場合は、Deno経路canaryを実行せず設定を修正してください。

`DENO_TOKENIZER_*`を部分的に設定するとfail-closedになります。全て未設定の場合だけCloudflare Durable Object tokenizerが使用されます。
Production workflowは3つの非Secret GitHub Repository VariablesをD1 migration前に検証しますが、
Worker SecretとDeno runtime Secretの設定も含め、4つのDeno integration設定を一緒に準備してください。
詳細は[deno-tokenizer.md](./deno-tokenizer.md)を参照してください。

### Deno Deploy CI

GitHub Actionsの設定画面はリポジトリの **Settings → Secrets and variables → Actions** です。
Production Worker workflowはリポジトリスコープ、Deno Deploy workflowはEnvironment
`deno-production`スコープへ設定します。

`DENO_TOKENIZER_ENDPOINT`、`DENO_TOKENIZER_THRESHOLD_BYTES`、
`DENO_TOKENIZER_TIMEOUT_MS`はProduction Worker workflow用のGitHub Repository Variablesです。
`DENO_DEPLOY_ORG`、`DENO_DEPLOY_APP`、`DENO_DEPLOY_TOKEN`、
`PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN`はGitHub Environment `deno-production`へ登録します。

| Name | Kind | Consumer | Set in | Obtain or decide | Apply |
| --- | --- | --- | --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | Production Worker workflow | GitHub Repository Variable | Production Account ID | `deploy-production.yml` |
| `CLOUDFLARE_API_TOKEN` | Secret | Production Worker workflow | GitHub Repository Secret | Account-scoped Cloudflare API token | `deploy-production.yml` |
| `DENO_DEPLOY_ORG` | Variable | Deno Deploy workflow | GitHub Environment `deno-production` | Deno Deploy organization | `deploy-deno-tokenizer.yml` |
| `DENO_DEPLOY_APP` | Variable | Deno Deploy workflow | GitHub Environment `deno-production` | Deno Deploy application | `deploy-deno-tokenizer.yml` |
| `DENO_DEPLOY_TOKEN` | Secret | Deno Deploy workflow | GitHub Environment `deno-production` | Deno Deploy access token | `deploy-deno-tokenizer.yml` |
| `PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN` | Secret | Production Worker and Deno Deploy workflows | GitHub Environment `deno-production` | Worker/Denoで共有するtokenizer認証値 | 両workflow |

GitHub CLIでは値を表示せず、登録済みの名前だけを確認できます。

```bash
gh variable list
gh secret list
gh variable list --env deno-production
gh secret list --env deno-production
```

Secretの実値はGitHubから読み戻せません。未登録またはローテーション時は、各取得元で
新しいtokenを発行し、同じ設定画面の **New repository secret** または
**New environment secret** から登録してください。ProductionのDeno runtime Secret
`OCTG_TOKENIZER_AUTH_TOKEN`は、`PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN`からDeno Deploy
workflowが反映します。通常運用でDeno Deployへ個別登録しないでください。

### Production canary

Worker canaryはProduction quotaを消費するため、次の順序を変更しません。初回canaryは
Deno integrationを無効にしたWorker version、2回目のcanaryは再deploy後のDeno経路を対象にします。

### Canary共通設定

| Name | Kind | Consumer | Set in | Obtain or decide | Apply |
| --- | --- | --- | --- | --- | --- |
| `OCTG_CANARY_URL` | Variable | Worker canary CLI | process environment / `.env` | Production Workerの`/v1/chat/completions` URL | `npm run canary:worker` |
| `OCTG_CANARY_ALLOWED_HOSTS` | Variable | Worker canary CLI | process environment / `.env` | URLと同じexact hostname。wildcard不可 | `npm run canary:worker` |
| `OCTG_CANARY_CLIENT_KEY` | Secret | Worker canary CLI | process environment / Secret Manager | 専用Production client key。Production quotaを消費 | `npm run canary:worker` |
| `CANARY_PAYLOAD_PATH` | Variable | Worker canary CLI | process environment / `.env` | 独自fixtureを使う場合だけ指定 | `npm run canary:worker` |
| `CANARY_CONCURRENCY` | Variable | Worker canary CLI | process environment / `.env` | 既定値`1,2`。想定ピークを追加可能 | `npm run canary:worker` |
| `CANARY_REQUEST_TIMEOUT_MS` | Variable | Worker canary CLI | process environment / `.env` | 既定値`120000` | `npm run canary:worker` |

canaryの結果にはresponse bodyやmessageを出さず、request ID・Worker version・安全なstructured errorだけを出力します。CPU/memory制限はrequest IDとrevisionをCloudflare Observabilityで相関して確認します。

専用clientがない場合はProduction D1へ一度だけ登録します。既存Productionの
`OCTG_KEY_PEPPER`をSecret Managerからprocess environmentへ注入し、raw keyを標準出力や
コマンドラインへ出さないため、`--key-output-file`を使用してください。同じclient IDを
key省略で再実行すると既存keyが無効になるため、登録後は再seedしません。

```bash
key_file="$(mktemp)"
trap 'rm -f -- "$key_file"' EXIT

OCTG_KEY_PEPPER="${OCTG_KEY_PEPPER:?Secret Managerから注入してください}" \
  npm run seed:client:remote -- \
    --id=canary_cpu --name="CPU Canary" --tools-mode=REJECT \
    --key-output-file="$key_file"
```

`--key-output-file`はmode `0600`のファイルへkeyを一度だけ書き込み、登録完了メッセージへ
raw keyを含めません。Secret Managerやprocess environmentを使えない場合は、登録を中断し、
raw keyをログへ残さない別の受け渡し方法を用意してください。

### 初回canary（Deno無効）

1. endpoint、threshold、timeout、Worker auth SecretのDeno integration設定が未設定であることを確認します。
2. 次のcanaryを実行します。

   ```bash
   OCTG_CANARY_CLIENT_KEY="$(<"$key_file")" \
     npm run canary:worker -- --env-file=.env
   ```

3. `cloudflare_do`のtokenization stageが成功し、各requestのquota reserve/settleとupstream到達が
   request IDで相関できること、Worker Observabilityに予期しないCPU/memory limitがないことを確認します。
   この段階でDeno providerが選択された場合は初回canaryを受け入れず、Deno設定を無効化して再実行します。

### Deno runtime SecretとWorker設定の適用

初回canaryが合格した後、Deno Deploy applicationをdeployしてhealthを確認します。
認証値はGitHub Environment `deno-production`の
`PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN`へ一度だけ登録し、Production Worker workflowが
Worker version Secret `DENO_TOKENIZER_AUTH_TOKEN`へ、Deno Deploy workflowがruntime Secret
`OCTG_TOKENIZER_AUTH_TOKEN`へ同じ値を反映します。`DENO_DEPLOY_TOKEN`はCI管理用の別Secretです。
`MAX_INPUT_BYTES`は両runtimeへ同じraw値を設定します。4つのDeno integration設定を部分適用しません。

通常のDeno設定変更やSecret rotationでは、GitHub Repository VariablesとEnvironment Secretを更新し、
Production Worker workflowとDeno Deploy workflowを実行します。Worker Secret、Deno runtime Secret、
通常の`wrangler deploy`を片方だけ手動で更新しないでください。緊急復旧時だけ、
[Deno tokenizer手順](./deno-tokenizer.md)のversioned deploy手順を使用します。

active versionのVariablesとSecret bindingを確認し、WorkerとDenoのresolved `MAX_INPUT_BYTES`が一致することを確認してから、Deno経路canaryへ進みます。

### Deno経路canary

同じkey fileとcanary設定で再度canaryを実行します。

```bash
OCTG_CANARY_CLIENT_KEY="$(<"$key_file")" \
  npm run canary:worker -- --env-file=.env
```

`deno`のtokenization provider、Deno tokenizerのstage、exact token count、quota reserve/settle、
upstream到達を確認し、初回canaryとquota accountingが一致することを判定します。Denoのtimeout、
network、upstream status、malformed responseでgeneric 500となった場合は、quota reserve、in-flight
admission、upstream callが発生していないことを確認します。

### Preview

Previewのリソース変数は`OCTG_PREVIEW_*`または`CLOUDFLARE_PREVIEW_*`に限定します。補助変数として`GITHUB_REPOSITORY`は`--github`実行時のみ必須で、`SMOKE_MODEL`はPreview smokeで未指定時に`gpt-5-mini`を使用します。Productionの同名リソースを指定しないでください。`.env`からPreview setupへ渡すpepperは`OCTG_PREVIEW_KEY_PEPPER`です。GitHub Environmentへ同期する際だけSecret名`OCTG_KEY_PEPPER`へ変換されます。

GitHub Actionsのworkflowが参照するSecret名は、ローカル`.env`のPreview名と一部異なります。次の表の`Set in`と`Apply`に、ローカル入力名からGitHub側の名前への対応を記載しています。`zsh scripts/setup-preview.zsh --github`を使う場合も、入力元は`.env`のPreview値です。

`OCTG_UPSTREAM_API_TOKEN`は、Cloudflare Dashboardの **My Profile → API Tokens → Create Token → Custom token** で作成します。Account権限の **AI Gateway: Run** を選び、`OCTG_PREVIEW_UPSTREAM_BASE_URL`が指すPreview Gateway Bを所有するAccountを対象にします。GitHub Secretへは、作成後に一度だけ表示されるtoken全文を、`Bearer`や引用符なしで入力してください。

Preview workflowでの`OCTG_UPSTREAM_API_TOKEN`は、Preview Gateway B（WorkerからOpenAIへ出る経路）のtokenです。Gateway A（OpenCodeからOCTGへ入るCustom Provider）の`OCTG_CF_API_TOKEN`、Wrangler管理用の`CLOUDFLARE_PREVIEW_API_TOKEN`、OpenAI Project API key、`octg_sk_*`は入力しません。Gateway BのURLは`https://gateway.ai.cloudflare.com/v1/<account-id>/<gateway-b-id>/openai`形式で、Gateway AのCustom Provider URLとは異なります。

| Name | Kind | Consumer | Set in | Obtain or decide | Apply |
| --- | --- | --- | --- | --- | --- |
| `CLOUDFLARE_PREVIEW_ACCOUNT_ID` | Variable | Preview Wrangler | `.env` / process environment | Preview専用Account ID | Preview setup / workflow |
| `CLOUDFLARE_PREVIEW_API_TOKEN` | Secret | Preview setup / workflow | `.env` → GitHub Environment `preview` | Preview resourceだけに限定したtoken | `setup-preview.zsh --github` |
| `OCTG_PREVIEW_UPSTREAM_API_TOKEN` | Secret | Preview Worker | `.env` → GitHub Secret `OCTG_UPSTREAM_API_TOKEN` | Productionと共有しないPreview Gateway B Run token | `setup-preview.zsh --github` |
| `OCTG_PREVIEW_DATABASE_ID` | Variable | Preview D1 migration | `.env` / 一時config | Preview D1 ID。空欄なら既存名を検索し、なければ作成後に入力 | `setup-preview.zsh` |
| `OCTG_PREVIEW_DATABASE_NAME` | Variable | Preview D1 | `.env`または既定値 | 既定値は`octg-gateway-preview-db` | `setup-preview.zsh` |
| `OCTG_PREVIEW_WORKER_NAME` | Variable | Preview Worker / smoke | `.env`または既定値 | 既定値は`octg-gateway-preview` | Preview workflow |
| `OCTG_PREVIEW_UPSTREAM_BASE_URL` | Variable | Preview Worker | `.env` → preview config | Preview Gateway B endpoint | Preview Worker deploy |
| `OCTG_PREVIEW_BASE_URL` | Variable | Preview workflow | `.env` → GitHub Variable | Preview Workerの公開URL | Preview smoke |
| `OCTG_PREVIEW_QUOTA_LIMIT_STANDARD` | Variable | Preview quota policy | `.env` → preview config | Preview STANDARD上限。`0`で無効 | Preview Worker deploy |
| `OCTG_PREVIEW_QUOTA_LIMIT_MINI` | Variable | Preview quota policy | `.env` → preview config | Preview MINI上限。正の整数 | Preview Worker deploy |
| `OCTG_PREVIEW_CLIENT_ID` | Variable | Preview D1 seed | `.env` | CI用client ID | `setup-preview.zsh` |
| `OCTG_PREVIEW_CLIENT_NAME` | Variable | Preview D1 seed | `.env` | CI用client名 | `setup-preview.zsh` |
| `OCTG_PREVIEW_CLIENT_KEY` | Secret | Preview D1 / smoke | `.env` → GitHub Secret `OCTG_PREVIEW_SMOKE_API_KEY` | `octg_sk_*`形式のPreview専用key | seed + `setup-preview.zsh --github` |
| `OCTG_PREVIEW_KEY_PEPPER` | Secret | Preview D1 / Worker | `.env` → GitHub Secret `OCTG_KEY_PEPPER` | Productionと別のPreview専用pepper | seed + Preview deploy |
| `GITHUB_REPOSITORY` | Variable | Preview setup CLI | process environment / `.env` | `owner/repository`形式。`--github`時のみ必須 | `setup-preview.zsh --github` |
| `SMOKE_MODEL` | Variable | Preview smoke workflow | GitHub Environment Variable | 既定値は`gpt-5-mini` | Preview smoke |
| `DENO_PREVIEW_DEPLOY_ORG` | Variable | Preview Deno workflow | `.env` → GitHub Environment `preview` | Preview専用Deno Deploy organization | `setup-preview.zsh --github` |
| `DENO_PREVIEW_DEPLOY_APP` | Variable | Preview Deno workflow | `.env` → GitHub Environment `preview` | Preview専用Deno Deploy application | `setup-preview.zsh --github` |
| `DENO_PREVIEW_TOKENIZER_ENDPOINT` | Variable | Preview Worker router | `.env` → GitHub Environment `preview` | Preview専用Deno `/tokenize` HTTPS endpoint | `setup-preview.zsh --github` |
| `DENO_PREVIEW_TOKENIZER_THRESHOLD_BYTES` | Variable | Preview Worker router | `.env` → GitHub Environment `preview` | Preview用の測定済みthreshold | `setup-preview.zsh --github` |
| `DENO_PREVIEW_TOKENIZER_TIMEOUT_MS` | Variable | Preview Worker client | `.env` → GitHub Environment `preview` | Preview用の測定済みtimeout | `setup-preview.zsh --github` |
| `DENO_PREVIEW_DEPLOY_TOKEN` | Secret | Preview Deno workflow | `.env` → GitHub Environment `preview` | Preview専用Deno Deploy access token | `setup-preview.zsh --github` |
| `DENO_PREVIEW_TOKENIZER_AUTH_TOKEN` | Secret | Preview Worker and Deno workflow | `.env` → GitHub Environment `preview` | Preview Worker/Denoで共有する認証値 | `setup-preview.zsh --github` |

Previewの既存`version-smoke`はDeno設定を除去した**DO-only** smokeで、専用Preview D1と
Cloudflare Durable Object tokenizerを検証します。追加の`deno-version-smoke`は同一リポジトリの
PRだけで実行し、Preview専用Deno appへdeployした後、invalid-auth versionを`0%`で検証します。
固定sentinelによるVersion Override requestはHTTP `500`と`error.code=internal_error`を要求し、
HTTP `200`ならDO fallbackを検出できないため失敗とします。正しいPreview Secretを持つ2つ目の
versionはHTTP `200`と期待するWorker version headerを要求します。最後に`always()` cleanupで
開始時のversionへ`wrangler rollback`し、smoke失敗時もPreview trafficを残しません。Fork PRは
credential-free validationだけを実行します。

## Quota受け入れ条件と判定基準

### Preview quota

`OCTG_PREVIEW_QUOTA_LIMIT_STANDARD`は0以上の安全整数（`0`は無効）、
`OCTG_PREVIEW_QUOTA_LIMIT_MINI`は正の安全整数にします。PreviewとProductionが同じupstream billing
principalを使う場合は、両環境の配分合計をprovider ceiling以下にします。ceilingはSTANDARDが
1,000,000 tokens、MINIが10,000,000 tokensです。coordinationが未設定・不明な場合はPreviewからの
upstream送信をfail-closedにします。

### Canaryとquotaの受け入れ

次の全条件を満たした場合だけquota設定とcanaryを受け入れます。

1. Tokenizer成功前に`quota_reserve`、in-flight admission、upstream callが発生しない。
2. 初回canaryの`cloudflare_do`経路とDeno経路canaryの`deno`経路がrequest ID・revisionで特定できる。
3. 成功requestのreserve/settleと`/quota`の残量変化がrequest結果と整合し、D1監査書き込みの成否に依存しない。
4. 74,000 token級payloadで予期しないCPU/memory limit、quota超過、upstream retryが発生しない。
5. Tokenizer timeout、network、upstream status、malformed responseではquota状態を消費せず、後続処理が実行されない。

いずれかを確認できない場合、quota設定を受け入れず、未確定requestをfail-closedのまま保持します。

### OpenCode client

OpenCodeでGateway AのCustom Providerを使う場合のクライアント側変数です。

| Name | Kind | Consumer | Set in | Obtain or decide | Apply |
| --- | --- | --- | --- | --- | --- |
| `OCTG_CF_ACCOUNT_ID` | Variable | OpenCode client | OpenCode environment | Gateway AのCloudflare Account ID | OpenCode provider config |
| `OCTG_CF_GATEWAY_ID` | Variable | OpenCode client | OpenCode environment | Gateway AのAI Gateway ID | OpenCode provider config |
| `OCTG_CF_API_TOKEN` | Secret | OpenCode client | OpenCode environment / Secret Manager | Gateway A Custom ProviderのRun token | OpenCode provider config |

Gateway AとGateway Bは別のAI Gateway instanceにしてください。OpenCodeの設定ファイルへ`octg_sk_*`やRun tokenの実値を書かないでください。詳細は[cloudflare-ai-gateway-custom-provider.md](./cloudflare-ai-gateway-custom-provider.md)を参照してください。

## Production/Preview boundary

ProductionとPreviewでは、Account、Worker、D1、Durable Object、Gateway、registry、監査・reconciliation state、pepper、client keyを分離します。upstream billing principalを共有する場合も、Previewのquota ceilingとbounded coordinationを別に設定し、coordinationが不明な場合はupstream送信をfail-closedにします。

Preview setupが生成する一時configにはProductionのDeno tokenizer endpoint、threshold、timeout、auth Secretを含めません。PreviewでDeno tokenizerを使う場合は、Productionとは別のDeno Deploy application、endpoint、runtime Secret、GitHub Environmentを用意してください。

## Rotation and recovery

1. 新しいruntime tokenまたはupstream tokenを発行し、既存値を無効化する前に対象Secretへ登録します。
2. `PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN`またはPreviewの`DENO_PREVIEW_TOKENIZER_AUTH_TOKEN`を対象Environmentへ登録し、workflowがWorker SecretとDeno Deploy runtime Secretへ反映します。
3. 既存Workerではinactive versionへSecretとVariablesを揃え、`wrangler versions deploy`で一度だけ反映してからhealth checkとcanaryを実行します。
4. canaryが合格した後に旧tokenを失効させます。失敗時は4つのDeno integration設定を全てunsetにしてCloudflare Durable Object経路へ戻します。
5. `OCTG_KEY_PEPPER`の変更はtoken rotationと分離し、既存client keyの再発行またはhash移行を完了してから旧pepperを無効化します。

## Troubleshooting

| Symptom | Check | Recovery |
| --- | --- | --- |
| 認証済み`/v1`が`500 internal_error` | Deno 4設定が部分適用されていないか確認 | Denoを使わない場合は4設定を全てunset。使う場合はendpoint、auth、threshold、timeoutを同じversionへ登録 |
| Denoの`401`またはWorkerのtimeout | 対象Environment SecretからWorker/Deno runtimeへ同じ値が反映されているか確認 | `PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN`または`DENO_PREVIEW_TOKENIZER_AUTH_TOKEN`を更新し、health check後にworkflowを再実行 |
| Preview設定にProduction endpointが現れる | Preview configと`setup-preview.zsh`の生成結果を確認 | `DENO_TOKENIZER_*`をPreview configから除去し、Production SecretをPreviewへ登録しない |
| Secret変更がactive versionへ反映されない | `wrangler versions view <version-id>`でbindingを確認 | inactive versionへ全設定を揃えてから`wrangler versions deploy`を再実行 |

## Related procedures

- Deno runtime、health check、障害契約、canary: [Deno tokenizer手順](./deno-tokenizer.md)
- Template固有のCloudflare resource作成と初回deploy: [テンプレート手順](./DEPLOY_FROM_TEMPLATE.md)
- Gateway A Custom Provider: [Cloudflare AI Gateway Custom Provider](./cloudflare-ai-gateway-custom-provider.md)
- Worker canaryとquota受け入れ条件: 本文の「Production canary」と「Quota受け入れ条件と判定基準」

## セットアップの安全動作

- Localの既存`.dev.vars`は`--force`なしで保護されます。
- Productionのplaceholder（`<...>`）は適用前に拒否されます。
- `--dry-run`ではCloudflare/GitHubへのwrite操作を行いません。
- Production setupは既存D1、Gateway B、Access applicationだけを使用します。
- Preview setupは一時configを使い、ProductionのD1 bindingを変更しません。
- `.env`から読み込んだ未知の変数は無視し、関連しないGrafana/Terraform設定に影響されません。
