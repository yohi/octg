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

   段階的deployを使えない既存Workerでは、baseline設定を用意した後に標準コマンドで既存Deno Secretを
   削除し、直ちにbaselineをdeployします。`wrangler secret delete`は即時deployを伴うため、通常の
   更新でSecretsを個別に`wrangler secret put`しないでください。

   ```bash
   npx wrangler secret delete DENO_TOKENIZER_AUTH_TOKEN \
     --config "$baseline_config"
   npx wrangler deploy --config "$baseline_config"
   ```

4. Deno Deployを使う場合だけ、GitHub Environment `deno-production`へ
   `DENO_DEPLOY_ORG`、`DENO_DEPLOY_APP`、Secret `DENO_DEPLOY_TOKEN`を登録します。
   これはDeno Deployの管理用であり、runtime認証には使いません。
5. Productionの既存`OCTG_KEY_PEPPER`を使って専用clientを一度だけseedし、raw keyを
   Secret Managerへ保存します。raw keyをログ、shell history、repositoryへ残しません。
6. `OCTG_CANARY_URL`と`OCTG_CANARY_CLIENT_KEY`をSecret Managerから注入して初回canaryを実行します。
   このcanaryはCloudflare Durable Object tokenizer経路を対象とし、Worker resource limit、quota
   reserve/settle、upstream到達を確認します。判定基準は「Worker canary設定」と「Quota受け入れ条件」に従います。
7. 初回canary合格後、Deno Deploy applicationをdeployしてhealthを確認し、Deno runtime Secret
   `OCTG_TOKENIZER_AUTH_TOKEN`を登録します。`DENO_DEPLOY_TOKEN`とは別のSecretです。
8. 対象Workerへ`DENO_TOKENIZER_ENDPOINT`、`DENO_TOKENIZER_THRESHOLD_BYTES`、
   `DENO_TOKENIZER_TIMEOUT_MS`をVariablesとして、`DENO_TOKENIZER_AUTH_TOKEN`をWorker Secretとして
   設定します。`MAX_INPUT_BYTES`はWorkerとDeno Deployへ同じraw値を設定し、4つのDeno integration設定を
   部分適用しません。
   既存Workerでは`wrangler versions upload`でinactive versionを作成し、
   `wrangler versions secret put DENO_TOKENIZER_AUTH_TOKEN`でSecretを同じversionへ追加してから、
   `wrangler versions deploy`で一度だけactiveにします。通常の`wrangler secret put`を途中で使いません。
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
| `MAX_INPUT_BYTES` | No | `wrangler.jsonc`のvars。Deno Deploy runtime environmentにも同じraw値を設定 | Gateway WorkerとDeno tokenizerで共有するinput ceiling。未設定・不正値時は1 MiB、`MAX_INPUT_TEXT_BYTES`を上限にclamp |

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

既存WorkerのSecret更新は`wrangler versions secret put`でinactive versionへ登録し、
`wrangler versions deploy`で設定済みのversionを反映します。Secretはリポジトリのファイルへ保存されません。
初回Worker作成時の標準`wrangler secret put`は[テンプレート手順](./DEPLOY_FROM_TEMPLATE.md)に限定します。
`OCTG_KEY_PEPPER`を変更すると既存client keyのhashと一致しなくなるため、通常のSecret rotationと分けて計画してください。

## Preview設定

Previewの変数は全て`OCTG_PREVIEW_*`または`CLOUDFLARE_PREVIEW_*`です。Productionの同名リソースを指定しないでください。`.env`からPreview setupへ渡すpepperは`OCTG_PREVIEW_KEY_PEPPER`です。GitHub Environmentへ同期する際だけSecret名`OCTG_KEY_PEPPER`へ変換されます。

### GitHub Environment `preview`へ登録する値

GitHub Actionsのworkflowが参照するSecret名は、ローカル`.env`のPreview名と一部異なります。
`zsh scripts/setup-preview.zsh --github`を使う場合も、入力元は`.env`のPreview値です。

| `.env`の入力名 | GitHub Environmentの登録名 | GitHubへ渡す実値 |
| --- | --- | --- |
| `CLOUDFLARE_PREVIEW_API_TOKEN` | Secret `CLOUDFLARE_PREVIEW_API_TOKEN` | Preview AccountのWorkers/D1などを操作できるCloudflare API token |
| `OCTG_PREVIEW_UPSTREAM_API_TOKEN` | Secret `OCTG_UPSTREAM_API_TOKEN` | Preview Gateway BのCloudflare API token。Custom tokenでAccount権限`AI Gateway: Run`を付与したもの |
| `OCTG_PREVIEW_CLIENT_KEY` | Secret `OCTG_PREVIEW_SMOKE_API_KEY` | Preview D1へseedしたCI clientの実値（`octg_sk_*`） |
| `OCTG_PREVIEW_KEY_PEPPER` | Secret `OCTG_KEY_PEPPER` | Preview D1のclient key hashに使ったpepperと同じ値 |

`OCTG_UPSTREAM_API_TOKEN`は、Cloudflare Dashboardの **My Profile → API Tokens → Create Token → Custom token** で作成します。
Account権限の **AI Gateway: Run** を選び、`OCTG_PREVIEW_UPSTREAM_BASE_URL`が指すPreview Gateway Bを所有するAccountを対象にします。
GitHub Secretへは、作成後に一度だけ表示されるtoken全文を、`Bearer`や引用符なしで入力してください。

Preview workflowでの`OCTG_UPSTREAM_API_TOKEN`は、Preview Gateway B（WorkerからOpenAIへ出る経路）のtokenです。
Gateway A（OpenCodeからOCTGへ入るCustom Provider）の`OCTG_CF_API_TOKEN`、Wrangler管理用の
`CLOUDFLARE_PREVIEW_API_TOKEN`、OpenAI Project API key、`octg_sk_*`は入力しません。
Gateway BのURLは`https://gateway.ai.cloudflare.com/v1/<account-id>/<gateway-b-id>/openai`形式で、Gateway AのCustom Provider URLとは異なります。

| 変数 | Secret | 設定先 | 取得・決定方法 |
| --- | ---: | --- | --- |
| `CLOUDFLARE_PREVIEW_ACCOUNT_ID` | No | Preview Wrangler認証 | Preview専用AccountのID |
| `CLOUDFLARE_PREVIEW_API_TOKEN` | Yes | Preview setup/GitHub Secret | Preview resourceだけに限定したtoken |
| `OCTG_PREVIEW_UPSTREAM_API_TOKEN` | Yes | Preview setup/GitHub Secret `OCTG_UPSTREAM_API_TOKEN` | Preview Gateway BのRun token。Production tokenと共有しない。Cloudflare Custom tokenの`AI Gateway: Run`権限を使用 |
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
| `DENO_TOKENIZER_AUTH_TOKEN` | Worker Secret | Gateway WorkerからDeno tokenizerへ送る認証token |
| `OCTG_TOKENIZER_AUTH_TOKEN` | Deno Deploy runtime Secret | Deno tokenizerが受け取る認証token。Worker Secretと同じ値 |
| `DENO_TOKENIZER_THRESHOLD_BYTES` | Worker vars | 測定済みの有効化threshold |
| `DENO_TOKENIZER_TIMEOUT_MS` | Worker vars | 測定済みのtimeout |

`.env`の`DENO_TOKENIZER_AUTH_TOKEN`の値を、Worker Secret
`DENO_TOKENIZER_AUTH_TOKEN`とDeno Deploy runtime Secret
`OCTG_TOKENIZER_AUTH_TOKEN`の両方へ設定してください。変数名はruntimeごとに異なりますが、
認証tokenは同じ値です。Deno Deploy runtime SecretはGitHub Environmentやworkflowへ渡しません。

`MAX_INPUT_BYTES`はProduction Worker vars表にある共有設定です。Deno Deploy runtime environmentにも
同じraw値を設定し、WorkerとDenoの各deploy後に`resolveMaxInputBytes`でresolved valueを確認します。
raw値またはresolved valueが一致しない場合は、Deno経路canaryを実行せず設定を修正してください。

`DENO_TOKENIZER_*`を部分的に設定するとfail-closedになります。全て未設定の場合だけCloudflare Durable Object tokenizerが使用されます。詳細は[deno-tokenizer.md](./deno-tokenizer.md)を参照してください。

### GitHub Actionsへの設定

GitHub Actionsの設定画面はリポジトリの **Settings → Secrets and variables → Actions** です。
Production Worker workflowはリポジトリスコープ、Deno Deploy workflowはEnvironment
`deno-production`スコープへ設定します。

| Workflow | 設定先 | Variables | Secrets |
| --- | --- | --- | --- |
| `.github/workflows/deploy-production.yml` | Repository | `CLOUDFLARE_ACCOUNT_ID` | `CLOUDFLARE_API_TOKEN` |
| `.github/workflows/deploy-deno-tokenizer.yml` | Environment `deno-production` | `DENO_DEPLOY_ORG`, `DENO_DEPLOY_APP` | `DENO_DEPLOY_TOKEN` |

GitHub CLIでは値を表示せず、登録済みの名前だけを確認できます。

```bash
gh variable list
gh secret list
gh variable list --env deno-production
gh secret list --env deno-production
```

Secretの実値はGitHubから読み戻せません。未登録またはローテーション時は、各取得元で
新しいtokenを発行し、同じ設定画面の **New repository secret** または
**New environment secret** から登録してください。Deno tokenizerのruntime secret
`OCTG_TOKENIZER_AUTH_TOKEN`はGitHubではなくDeno Deployへ登録します。

## Worker canary設定

Worker canaryはProduction quotaを消費するため、次の順序を変更しません。初回canaryは
Deno integrationを無効にしたWorker version、2回目のcanaryは再deploy後のDeno経路を対象にします。

### Canary共通設定

| 変数 | Secret | 設定先 | 取得・決定方法 |
| --- | ---: | --- | --- |
| `OCTG_CANARY_URL` | No | canary実行環境 | Production Workerの`/v1/chat/completions` URL |
| `OCTG_CANARY_ALLOWED_HOSTS` | No | canary実行環境 | URLと同じexact hostname。wildcard不可 |
| `OCTG_CANARY_CLIENT_KEY` | Yes | canary実行環境 | 専用Production client key。Production quotaを消費 |
| `CANARY_PAYLOAD_PATH` | No | canary実行環境 | 独自fixtureを使う場合だけ指定 |
| `CANARY_CONCURRENCY` | No | canary実行環境 | 既定値`1,2`。想定ピークを追加可能 |
| `CANARY_REQUEST_TIMEOUT_MS` | No | canary実行環境 | 既定値`120000` |

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

初回canaryが合格した後、Deno Deploy applicationをdeployしてhealthを確認し、runtime Secret
`OCTG_TOKENIZER_AUTH_TOKEN`をDeno applicationへ登録します。同時に対象Workerへ
`DENO_TOKENIZER_ENDPOINT`、`DENO_TOKENIZER_THRESHOLD_BYTES`、`DENO_TOKENIZER_TIMEOUT_MS`をVariablesとして、
`DENO_TOKENIZER_AUTH_TOKEN`をWorker Secretとして設定します。`DENO_DEPLOY_TOKEN`はCI管理用の別Secretです。
`MAX_INPUT_BYTES`は両runtimeへ同じraw値を設定します。4つのDeno integration設定を部分適用しません。

### 再deploy

WorkerのDeno設定を変更した後、次のコマンドでWorkerを再deployします。

```bash
npx wrangler deploy --config apps/gateway-worker/wrangler.jsonc
```

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
