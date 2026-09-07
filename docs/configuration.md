# Configuration

[日本語](./configuration.ja.md)

This is the human-readable configuration reference for OCTG.

The machine-usable input template is the repository-root [`.env.example`](../.env.example). Keep `.env.example` usable by scripts; keep explanations, acquisition guidance, and cross-setting rules in this document.

## Configuration Sources

OCTG configuration comes from four surfaces:

1. `.env` copied from `.env.example` for local setup/deployment scripts;
2. `apps/gateway-worker/wrangler.jsonc` for Worker runtime variables, bindings, migrations, and cron;
3. Cloudflare Worker Secrets / GitHub Environment Secrets for secret runtime values;
4. D1 rows for client policies and model registry entries.

Do not commit real client keys, OpenAI keys, Cloudflare API tokens, Run tokens, peppers, or Deno shared-auth tokens.

## Local Setup Inputs

Consumed by `npm run setup:local`.

| Variable | Default / example purpose |
| --- | --- |
| `OCTG_LOCAL_KEY_PEPPER` | Local-only client key pepper |
| `OCTG_LOCAL_UPSTREAM_BASE_URL` | Local upstream AI Gateway OpenAI endpoint |
| `OCTG_LOCAL_UPSTREAM_API_TOKEN` | Local upstream Run token placeholder |
| `OCTG_LOCAL_OPENAI_USAGE_API_KEY` | Local Usage API placeholder |
| `OCTG_LOCAL_CLIENT_ID` | Development client ID |
| `OCTG_LOCAL_CLIENT_NAME` | Development client display name |
| `OCTG_LOCAL_CLIENT_KEY` | Optional explicit `octg_sk_*`; blank lets setup generate one |
| `OCTG_LOCAL_CLIENT_TOOLS_MODE` | `REJECT` or `ALLOW` |

The default local setup does not require production credentials.

## Production Setup Inputs

Consumed by `npm run setup:deploy`.

| Variable | Kind | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | variable | Production Cloudflare account |
| `CLOUDFLARE_API_TOKEN` | secret | Wrangler/resource-management credential |
| `OCTG_DATABASE_ID` | variable | Existing production D1 database ID |
| `OCTG_UPSTREAM_BASE_URL` | variable | Gateway B OpenAI-provider endpoint; must end in `/openai` |
| `ACCESS_TEAM_DOMAIN` | variable | Cloudflare Access team domain |
| `ACCESS_AUD` | variable | Access application audience |
| `OCTG_KEY_PEPPER` | Worker secret | Keyed-hash pepper for OCTG client keys |
| `OCTG_UPSTREAM_API_TOKEN` | Worker secret | Gateway B AI Gateway Run token |
| `OPENAI_USAGE_API_KEY` | Worker secret | Credential used for Usage API reconciliation |

`OCTG_KEY_PEPPER` must remain consistent with the hashes stored for existing clients. Rotating it requires client-key migration or reissuance.

`OCTG_UPSTREAM_API_TOKEN` is an AI Gateway Run token. It is not an OCTG client key.

`OPENAI_USAGE_API_KEY` is used for reconciliation, not normal request authentication.

The runtime also supports optional `OPENAI_FREE_PROJECT_ID` to scope Usage API queries.

## Worker Runtime Controls

Checked-in defaults live in `apps/gateway-worker/wrangler.jsonc`.

| Variable | Checked-in value | Behavior |
| --- | ---: | --- |
| `QUOTA_LIMIT_STANDARD` | `1000000` | Operational STANDARD pool ceiling for one UTC day |
| `QUOTA_LIMIT_MINI` | `9950000` | Operational MINI pool ceiling for one UTC day |
| `MAX_INPUT_BYTES` | `1048576` | Maximum accepted raw/normalized input size before the hard tokenization ceiling |
| `MAX_IN_FLIGHT_REQUESTS` | `2` | Maximum concurrent admitted requests in a pool/day controller |
| `IN_FLIGHT_LEASE_TTL_MS` | `120000` | In-flight lease TTL; runtime enforces a 120 s minimum |
| `IN_FLIGHT_LEASE_RENEWAL_MS` | `30000` | Streaming lease renewal interval |

The shared-code fallback pool allowances are 1,000,000 STANDARD and 10,000,000 MINI. A lower runtime value is an intentional operational ceiling, not a contradiction.

Do not copy instance-specific account IDs, D1 IDs, Access audiences, or upstream URLs from the template repository into another deployment.

## Deno Tokenizer

The Worker-side Deno tokenizer configuration is all-or-nothing:

| Setting | Kind | Purpose |
| --- | --- | --- |
| `DENO_TOKENIZER_ENDPOINT` | variable | HTTPS `/tokenize` endpoint |
| `DENO_TOKENIZER_AUTH_TOKEN` | Worker secret | Shared request authentication |
| `DENO_TOKENIZER_THRESHOLD_BYTES` | variable | Route inputs at or above this text-byte threshold to Deno |
| `DENO_TOKENIZER_TIMEOUT_MS` | variable | Positive request timeout |

If all four settings are absent, the Deno tokenizer is disabled and tokenization uses `TokenizerController`.

If only some settings are present, or a value is invalid, the gateway fails closed. It does not silently fall back.

GitHub/Deno deployment inputs from `.env.example`:

| Variable | Scope |
| --- | --- |
| `DENO_DEPLOY_ORG` | Production Deno Deploy organization |
| `DENO_DEPLOY_APP` | Production Deno Deploy app |
| `DENO_DEPLOY_TOKEN` | Deno Deploy management secret |
| `PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN` | Protected production shared-auth source |

`DENO_DEPLOY_TOKEN` and the tokenizer's runtime shared-auth token are different credentials.

See [deno-tokenizer.md](./deno-tokenizer.md).

## Preview Inputs

Preview must use its own control-plane resources and credentials.

The setup template contains:

- `CLOUDFLARE_PREVIEW_ACCOUNT_ID`
- `CLOUDFLARE_PREVIEW_API_TOKEN`
- `OCTG_PREVIEW_UPSTREAM_API_TOKEN`
- `OCTG_PREVIEW_DATABASE_ID`
- `OCTG_PREVIEW_DATABASE_NAME`
- `OCTG_PREVIEW_WORKER_NAME`
- `OCTG_PREVIEW_UPSTREAM_BASE_URL`
- `OCTG_PREVIEW_BASE_URL`
- `OCTG_PREVIEW_QUOTA_LIMIT_STANDARD`
- `OCTG_PREVIEW_QUOTA_LIMIT_MINI`
- `OCTG_PREVIEW_CLIENT_ID`
- `OCTG_PREVIEW_CLIENT_NAME`
- `OCTG_PREVIEW_CLIENT_KEY`
- `OCTG_PREVIEW_KEY_PEPPER`
- `GITHUB_REPOSITORY`
- `SMOKE_MODEL`

Preview Deno settings are likewise separated:

- `DENO_PREVIEW_DEPLOY_ORG`
- `DENO_PREVIEW_DEPLOY_APP`
- `DENO_PREVIEW_DEPLOY_TOKEN`
- `DENO_PREVIEW_TOKENIZER_ENDPOINT`
- `DENO_PREVIEW_TOKENIZER_AUTH_TOKEN`
- `DENO_PREVIEW_TOKENIZER_THRESHOLD_BYTES`
- `DENO_PREVIEW_TOKENIZER_TIMEOUT_MS`

Do not reuse Production client keys, peppers, D1 state, or Deno shared-auth values in Preview.

## Worker Canary Inputs

Consumed by the Worker canary tooling:

| Variable | Purpose |
| --- | --- |
| `OCTG_CANARY_URL` | Production Chat Completions canary URL |
| `OCTG_CANARY_ALLOWED_HOSTS` | Explicit allowlist for the canary target |
| `OCTG_CANARY_CLIENT_KEY` | Dedicated production canary client |
| `CANARY_PAYLOAD_PATH` | Optional request payload path |
| `CANARY_CONCURRENCY` | Canary concurrency sequence |
| `CANARY_REQUEST_TIMEOUT_MS` | Per-request timeout |

The canary consumes real production complimentary quota. Use a dedicated client.

## OpenCode / Gateway A Inputs

For a client going through Cloudflare AI Gateway Custom Provider:

- `OCTG_CF_ACCOUNT_ID`
- `OCTG_CF_GATEWAY_ID`
- `OCTG_CF_API_TOKEN`

These identify/authenticate Gateway A. They are distinct from the Gateway B settings used by the OCTG Worker.

See [cloudflare-ai-gateway-custom-provider.md](./cloudflare-ai-gateway-custom-provider.md).

## D1 Client Policy

The effective policy fields are:

| Field | Values | Default | Phase 1 behavior |
| --- | --- | --- | --- |
| `overflow_mode` | `REJECT`, `PAID_SHARED` | `REJECT` | Stored for compatibility; no paid route exists |
| `output_limit_mode` | `REJECT`, `CLAMP` | `REJECT` | Reject or reduce output max when quota cannot fit |
| `max_paid_usd_day` | non-negative number | `0` | Stored for future paid behavior |
| `cache_enabled` | boolean | `false` | Enables AI Gateway cache use for that client |
| `tools_mode` | `REJECT`, `ALLOW` | `REJECT` | Allows tool-use requests into the complimentary flow |

Do not document `PAID_SHARED` as a currently available fallback.

## D1 Model Registry

Each model row includes:

- model ID;
- provider;
- `complimentary_pool` (`STANDARD`, `MINI`, or `NONE`);
- enabled flag;
- optional fallback-model field;
- update timestamp.

Runtime model eligibility is determined from this registry. `/v1/models` is the client-visible discovery surface.

The fallback-model field does not create a Phase 1 paid route.

## Durable Object Bindings and Migrations

The Worker requires:

- `QUOTA_CONTROLLER` → `QuotaController`;
- `TOKENIZER_CONTROLLER` → `TokenizerController`.

Applied Durable Object migration tags are operational history. Existing applied tags must not be renamed, deleted, or rewritten. Add a new migration tag when changing Durable Object class migrations.

## Cron

The checked-in Worker cron is:

```text
5 0 * * *
```

It starts the scheduled maintenance path at 00:05 UTC. Reconciliation behavior is defined in [../SPEC.md](../SPEC.md); operating it is covered in [operations.md](./operations.md).

## Source-of-Truth Rule

When configuration documentation and executable configuration differ:

- `.env.example` is authoritative for script-consumed input names;
- `wrangler.jsonc` is authoritative for checked-in Worker bindings/runtime defaults;
- D1 schema and code are authoritative for accepted policy/model fields;
- `SPEC.md` is the normative behavioral contract.

Update this document with any contract-changing configuration addition.
