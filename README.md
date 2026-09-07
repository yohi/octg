# OCTG — OpenAI Complimentary Token Gateway

[日本語](./README.ja.md)

[![Deploy Production](https://github.com/yohi/octg/actions/workflows/deploy-production.yml/badge.svg)](https://github.com/yohi/octg/actions/workflows/deploy-production.yml)
[![Preview Smoke](https://github.com/yohi/octg/actions/workflows/preview-smoke.yml/badge.svg)](https://github.com/yohi/octg/actions/workflows/preview-smoke.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

OCTG is an OpenAI-compatible API gateway that lets multiple clients share the complimentary token allowance associated with an OpenAI Data Sharing Program project while enforcing a fail-closed quota before requests reach OpenAI.

It runs on Cloudflare Workers, Durable Objects, and D1. It is intended for operators who want one controlled gateway in front of a shared complimentary allowance, and for clients that can use an OpenAI-compatible base URL.

> [!IMPORTANT]
> **Phase 1 is complimentary-only.** Requests for models that are not enabled in a complimentary pool are rejected with `model_requires_paid`. `PAID_SHARED`-related policy fields exist for future compatibility but do not enable a paid fallback path.

## Quick Start

### Use an existing OCTG gateway

You need:

- the gateway URL, for example `https://octg-gateway.<subdomain>.workers.dev`;
- an OCTG client key beginning with `octg_sk_`.

Send a Chat Completions request:

```bash
curl https://octg-gateway.<subdomain>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer octg_sk_xxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.6-luna","messages":[{"role":"user","content":"Hello"}]}'
```

A successful request returns an OpenAI-compatible JSON response and includes an `X-OCTG-Request-Id` response header.

Use the gateway as an OpenAI-compatible client endpoint:

```text
Base URL: https://octg-gateway.<subdomain>.workers.dev/v1
API key:  octg_sk_xxx
```

The runtime model registry is authoritative. Query the models available to your client:

```bash
curl https://octg-gateway.<subdomain>.workers.dev/v1/models \
  -H "Authorization: Bearer octg_sk_xxx"
```

Check the current complimentary-pool state:

```bash
curl https://octg-gateway.<subdomain>.workers.dev/quota \
  -H "Authorization: Bearer octg_sk_xxx"
```

## Features

- OpenAI-compatible `POST /v1/chat/completions` and `POST /v1/responses`.
- Shared per-pool, per-UTC-day quota enforced by a Durable Object before the upstream call.
- Exact `o200k_base` input tokenization through a Cloudflare Durable Object, with optional Deno Deploy offload for large inputs.
- Reservation, settlement, uncertainty tracking, and next-day reconciliation against the OpenAI Usage API.
- Client authentication with `octg_sk_*` keys whose keyed hashes are stored in D1.
- Optional client tool-use, output clamping, and AI Gateway cache policies.
- Cloudflare Access-protected Admin API and Admin UI.
- Preview, production, Deno tokenizer, and canary workflows for operators.

## How It Works

```text
Client
  │  Authorization: Bearer octg_sk_*
  ▼
Gateway Worker
  │  authenticate → normalize → classify model → load policy
  │
  ├─ small input / Deno disabled ─► TokenizerController DO
  │
  └─ large input / Deno enabled ──► Deno tokenizer
  │
  ▼
QuotaController DO (pool × UTC day)
  │  reserve → in-flight admission
  ▼
Cloudflare AI Gateway
  ▼
OpenAI API
  │
  ├─ success with usage ─► settle actual tokens
  └─ uncertain outcome ──► retain conservative uncertainty

D1 stores registry, policy, audit, usage, and reconciliation projections.
A daily cron reconciles the previous UTC day with the OpenAI Usage API.
```

The detailed behavioral contract is in [SPEC.md](./SPEC.md).

## Usage

OCTG currently exposes:

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI-compatible Chat Completions proxy |
| `POST /v1/responses` | OpenAI-compatible Responses proxy |
| `GET /v1/models` | Enabled complimentary models from the runtime registry |
| `GET /quota` | Current STANDARD and MINI pool state |
| `/admin/*` | Cloudflare Access-protected operator API and UI |

Text input is supported. Tool use is rejected unless the client's `tools_mode` is `ALLOW`.

For Cloudflare AI Gateway Custom Provider and OpenCode integration, see [docs/cloudflare-ai-gateway-custom-provider.md](./docs/cloudflare-ai-gateway-custom-provider.md).

## Configuration

The machine-usable environment template is [.env.example](./.env.example).

The important runtime controls are:

- complimentary limits for the `STANDARD` and `MINI` pools;
- maximum accepted input bytes;
- maximum in-flight requests and lease timings;
- Cloudflare AI Gateway upstream URL and Run token;
- OCTG client-key pepper;
- OpenAI Usage API credential;
- Cloudflare Access settings;
- optional Deno tokenizer endpoint, authentication, threshold, and timeout.

Do not treat this list as a complete configuration reference. See [docs/configuration.md](./docs/configuration.md).

## Documentation

| Reader / task | Canonical document |
| --- | --- |
| Get started and find the right document | [README.md](./README.md) |
| Technical behavior and invariants | [SPEC.md](./SPEC.md) |
| AI coding-agent instructions | [AGENTS.md](./AGENTS.md) |
| Complete human-readable configuration reference | [docs/configuration.md](./docs/configuration.md) |
| Provisioning and deployment | [docs/deployment.md](./docs/deployment.md) |
| Monitoring, reconciliation, canary, rollback, and secrets | [docs/operations.md](./docs/operations.md) |
| Deno tokenizer component | [docs/deno-tokenizer.md](./docs/deno-tokenizer.md) |
| Cloudflare AI Gateway Custom Provider | [docs/cloudflare-ai-gateway-custom-provider.md](./docs/cloudflare-ai-gateway-custom-provider.md) |
| Historical requirements and design records | `REQUIREMENTS*.md` and `docs/superpowers/` — non-authoritative |

## Development

Requires Node.js 22 or later.

```bash
npm install
cp .env.example .env
chmod 600 .env
npm run setup:local -- --env-file=.env
npm run dev -w apps/gateway-worker
```

The default local setup does not require production credentials. `setup:local` creates local development configuration, applies the local D1 migrations, and registers a development client.

Before submitting changes:

```bash
npm run typecheck
npm test
```

For deployment, use [docs/deployment.md](./docs/deployment.md). For operational procedures, use [docs/operations.md](./docs/operations.md).

## License

[MIT](./LICENSE)
