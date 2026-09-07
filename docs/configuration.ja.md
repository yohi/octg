# Configuration

[English](./configuration.md)

この文書は [configuration.md](./configuration.md) の日本語版です。英語版を正本とします。

machine-usable な入力 template は repository root の [`.env.example`](../.env.example) です。`.env.example` は script が利用できる形を維持し、説明・取得元・設定間のルールはこの文書へ置きます。

## 設定の正本

OCTG の設定は主に次の surface から構成されます。

1. `.env.example` / private `.env`: setup script の入力名
2. `apps/gateway-worker/wrangler.jsonc`: Worker runtime variables、bindings、migrations、cron
3. Worker Secrets / GitHub Environment Secrets: secret values
4. D1: client policy / model registry

real client key、OpenAI key、Cloudflare token、Run token、pepper、Deno shared-auth token を commit しないでください。

## Local

`npm run setup:local` が使用します。

- `OCTG_LOCAL_KEY_PEPPER`
- `OCTG_LOCAL_UPSTREAM_BASE_URL`
- `OCTG_LOCAL_UPSTREAM_API_TOKEN`
- `OCTG_LOCAL_OPENAI_USAGE_API_KEY`
- `OCTG_LOCAL_CLIENT_ID`
- `OCTG_LOCAL_CLIENT_NAME`
- `OCTG_LOCAL_CLIENT_KEY`
- `OCTG_LOCAL_CLIENT_TOOLS_MODE`

default local setup では production credential は不要です。`OCTG_LOCAL_CLIENT_KEY` を空にすると setup が local key を生成できます。

## Production

`npm run setup:deploy` が使用する主要値:

| Variable | 種別 | 用途 |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | variable | Production Cloudflare account |
| `CLOUDFLARE_API_TOKEN` | secret | Wrangler/resource management |
| `OCTG_DATABASE_ID` | variable | existing D1 database |
| `OCTG_UPSTREAM_BASE_URL` | variable | Gateway B OpenAI endpoint (`/openai` で終了) |
| `ACCESS_TEAM_DOMAIN` | variable | Cloudflare Access team domain |
| `ACCESS_AUD` | variable | Access audience |
| `OCTG_KEY_PEPPER` | Worker secret | client key hash pepper |
| `OCTG_UPSTREAM_API_TOKEN` | Worker secret | Gateway B Run token |
| `OPENAI_USAGE_API_KEY` | Worker secret | reconciliation Usage API credential |

`OCTG_KEY_PEPPER` を変更すると stored client hash と一致しなくなるため、通常の stateless secret と同様に即時 rotation しません。

optional `OPENAI_FREE_PROJECT_ID` は Usage API query の project scope に使用されます。

## Worker runtime controls

checked-in `wrangler.jsonc` の current defaults:

| Variable | Value | 用途 |
| --- | ---: | --- |
| `QUOTA_LIMIT_STANDARD` | `1000000` | STANDARD operational ceiling |
| `QUOTA_LIMIT_MINI` | `9950000` | MINI operational ceiling |
| `MAX_INPUT_BYTES` | `1048576` | accepted input limit |
| `MAX_IN_FLIGHT_REQUESTS` | `2` | pool/day in-flight limit |
| `IN_FLIGHT_LEASE_TTL_MS` | `120000` | lease TTL |
| `IN_FLIGHT_LEASE_RENEWAL_MS` | `30000` | streaming renewal interval |

shared-code fallback allowance と deployed operational ceiling は同一概念ではありません。MINI の fallback は 10,000,000 ですが、checked-in operational ceiling は 9,950,000 です。

instance-specific account ID、D1 ID、Access audience、upstream URL を template repository から別 deployment へそのままコピーしないでください。

## Deno tokenizer

Worker-side Deno config は4設定を一組として扱います。

- `DENO_TOKENIZER_ENDPOINT`
- `DENO_TOKENIZER_AUTH_TOKEN`
- `DENO_TOKENIZER_THRESHOLD_BYTES`
- `DENO_TOKENIZER_TIMEOUT_MS`

全て absent: Deno disabled。

全て valid: Deno enabled。

partial / invalid: fail-closed configuration error。

Deno Deploy 管理用の `DENO_DEPLOY_TOKEN` と tokenizer runtime shared-auth secret は別 credential です。

詳細は [deno-tokenizer.md](./deno-tokenizer.md) を参照してください。

## Preview

Preview は Production から Worker、D1、client key/pepper、control-plane state、Deno application/shared auth を分離します。

`.env.example` の `CLOUDFLARE_PREVIEW_*`、`OCTG_PREVIEW_*`、`DENO_PREVIEW_*` を使用してください。Production credential を Preview へ再利用しません。

## Canary

`.env.example` の以下を使用します。

- `OCTG_CANARY_URL`
- `OCTG_CANARY_ALLOWED_HOSTS`
- `OCTG_CANARY_CLIENT_KEY`
- `CANARY_PAYLOAD_PATH`
- `CANARY_CONCURRENCY`
- `CANARY_REQUEST_TIMEOUT_MS`

canary は実際の Production complimentary quota を消費するため dedicated client を使用します。

## OpenCode / Gateway A

Custom Provider ingress 用:

- `OCTG_CF_ACCOUNT_ID`
- `OCTG_CF_GATEWAY_ID`
- `OCTG_CF_API_TOKEN`

これは Worker outbound Gateway B の設定とは別です。[cloudflare-ai-gateway-custom-provider.md](./cloudflare-ai-gateway-custom-provider.md) を参照してください。

## D1 client policy

| Field | Default | Phase 1 |
| --- | --- | --- |
| `overflow_mode` | `REJECT` | `PAID_SHARED` は storage/API compatibility のみ。paid route なし |
| `output_limit_mode` | `REJECT` | `REJECT` / `CLAMP` |
| `max_paid_usd_day` | `0` | future paid behavior 用 |
| `cache_enabled` | `false` | client ごとの AI Gateway cache opt-in |
| `tools_mode` | `REJECT` | `ALLOW` の場合のみ tool-use request を complimentary flow へ許可 |

## Model registry

Runtime model eligibility は D1 model registry が決定し、client-facing discovery は `/v1/models` です。static model list を documentation の独立正本にしません。

## Durable Objects / Cron

bindings:

- `QUOTA_CONTROLLER`
- `TOKENIZER_CONTROLLER`

適用済み Durable Object migration tag は削除・rename・rewrite せず、新変更は新 tag とします。

checked-in cron は `5 0 * * *`（00:05 UTC）です。reconciliation contract は [../SPEC.md](../SPEC.md)、運用は [operations.md](./operations.md) を参照してください。
