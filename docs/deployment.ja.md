# Deployment

[English](./deployment.md)

この文書は [deployment.md](./deployment.md) の日本語版です。英語版を正本とします。

設定値の ownership は [configuration.md](./configuration.md)、デプロイ後の運用は [operations.md](./operations.md) を参照してください。

## Production 構成

Production OCTG は主に次を使用します。

- Cloudflare Worker
- D1
- `QuotaController` / `TokenizerController` Durable Objects
- OCTG → OpenAI 用 Cloudflare AI Gateway B
- `/admin/*` 用 Cloudflare Access
- intended complimentary project の OpenAI credential
- optional Deno Deploy tokenizer

client ingress に Cloudflare AI Gateway Custom Provider を使う場合は Gateway A を別 instance として使用します。

## Prerequisites

- Node.js 22+
- npm
- target Cloudflare account へ認証済み Wrangler

`setup:deploy` 実行前に次の resource を作成します。

- D1 database
- outbound Gateway B
- Cloudflare Access application

setup script 自体はこれらの service を新規作成しません。

## Template から作成

1. `yohi/octg` template から自分の repository を作成
2. clone
3. dependencies install
4. `.env.example` を private `.env` へ copy
5. 自分の Production resource values を入力

```bash
npm install
cp .env.example .env
chmod 600 .env
```

template repository の account ID / D1 ID / Access audience / upstream URL を別 instance へそのまま流用しません。

## D1

例:

```bash
npx wrangler d1 create octg
```

Worker binding は `DB`、migration は `db/migrations` にあります。

## Gateway B

`OCTG_UPSTREAM_BASE_URL` は Gateway B の OpenAI provider endpoint とし、`/openai` で終了させます。

Worker は `OCTG_UPSTREAM_API_TOKEN` の Run token で Gateway B へ認証します。

## Cloudflare Access

Admin surface 用 Access application を作成し、次を設定します。

- `ACCESS_TEAM_DOMAIN`
- `ACCESS_AUD`

## Secrets

通常の request path で使用する主要 Worker secrets:

- `OCTG_KEY_PEPPER`
- `OCTG_UPSTREAM_API_TOKEN`

`OPENAI_USAGE_API_KEY` は一般的な request authentication / proxying 用ではありません。`fetchUsage` が scheduled / manual reconciliation で Usage API を呼び出すために必要な Worker secret です。`npm run setup:deploy` は現在この secret も登録するため、同コマンドを使う場合は値を用意してください。

Deno enabled の場合は Deno tokenizer shared-auth も必要です。[deno-tokenizer.md](./deno-tokenizer.md) を参照してください。

## Pre-deploy verification

```bash
npm run typecheck
npm test
npm run setup:deploy -- --env-file=.env --dry-run
```

placeholder / invalid target を解消してから実 run します。

## Deploy

```bash
npm run setup:deploy -- --env-file=.env
```

exact side effects は setup script とその tests を executable authority とします。この文書で script implementation を重複管理しません。

## First verification

1. dedicated client key で `/v1/models`
2. `/quota`
3. 小さい Chat Completions request
4. `X-OCTG-Request-Id`
5. expected pool accounting
6. unauthenticated Admin access が拒否されること
7. Worker observability

```bash
curl https://<worker-host>/v1/chat/completions \
  -H "Authorization: Bearer <octg-client-key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"<model-from-v1-models>","messages":[{"role":"user","content":"Hello"}]}'
```

利用可能 model は `/v1/models` を確認します。

## GitHub Actions

- `deploy-production.yml`: production Worker validation / deploy
- `preview-smoke.yml`: dedicated Preview environment smoke
- `deploy-deno-tokenizer.yml`: Deno tokenizer validation / deploy

workflow 自体を exact command sequence の executable authority とします。

## Production / Preview isolation

少なくとも Worker、D1、Durable Object state、client registry/key/pepper、audit/reconciliation state、Deno app/shared-auth を分離します。

deploy 後は [operations.md](./operations.md) の monitoring、reconciliation、canary、rollback、secret rotation を使用してください。
