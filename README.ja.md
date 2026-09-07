# OCTG — OpenAI Complimentary Token Gateway

[English](./README.md)

[![Deploy Production](https://github.com/yohi/octg/actions/workflows/deploy-production.yml/badge.svg)](https://github.com/yohi/octg/actions/workflows/deploy-production.yml)
[![Preview Smoke](https://github.com/yohi/octg/actions/workflows/preview-smoke.yml/badge.svg)](https://github.com/yohi/octg/actions/workflows/preview-smoke.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

OCTG は、OpenAI Data Sharing Program のプロジェクトに紐づく complimentary token allowance を複数クライアントで共有しつつ、OpenAI へ到達する前に fail-closed で quota を制御する OpenAI 互換 API Gateway です。

Cloudflare Workers、Durable Objects、D1 で動作します。共有無料枠の前段に単一の制御点を置きたい運用者と、OpenAI 互換 base URL を設定できるクライアントを対象とします。

> [!IMPORTANT]
> **Phase 1 は complimentary-only です。** complimentary pool で有効化されていないモデルは `model_requires_paid` で拒否します。`PAID_SHARED` 関連の policy field は将来互換用であり、paid fallback を有効化しません。

## Quick Start

### デプロイ済み OCTG を利用する

必要なもの:

- Gateway URL（例: `https://octg-gateway.<subdomain>.workers.dev`）
- `octg_sk_` で始まる OCTG client key

Chat Completions を呼び出します。

```bash
curl https://octg-gateway.<subdomain>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer octg_sk_xxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"<model-from-v1-models>","messages":[{"role":"user","content":"Hello"}]}'
```

成功時は OpenAI 互換 JSON response と `X-OCTG-Request-Id` response header が返ります。

OpenAI 互換クライアントには次を設定します。

```text
Base URL: https://octg-gateway.<subdomain>.workers.dev/v1
API key:  octg_sk_xxx
```

利用可能モデルの正本は runtime model registry です。

```bash
curl https://octg-gateway.<subdomain>.workers.dev/v1/models \
  -H "Authorization: Bearer octg_sk_xxx"
```

現在の complimentary pool 状態は `/quota` で確認できます。

```bash
curl https://octg-gateway.<subdomain>.workers.dev/quota \
  -H "Authorization: Bearer octg_sk_xxx"
```

## Features

- OpenAI 互換 `POST /v1/chat/completions` / `POST /v1/responses`
- Durable Object による pool × UTC day の request 前 quota enforcement
- Cloudflare Durable Object による exact `o200k_base` tokenization と、大きな入力向けの optional Deno Deploy offload
- reservation、settlement、uncertainty tracking、OpenAI Usage API との翌日 reconciliation
- D1 に keyed hash を保存する `octg_sk_*` client authentication
- client ごとの tool-use、output clamp、AI Gateway cache policy
- Cloudflare Access で保護された Admin API / Admin UI
- Preview、Production、Deno tokenizer、canary の運用 workflow

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
  ├─ usage 取得成功 ─► actual tokens で settle
  └─ outcome 不確実 ─► conservative uncertainty として保持

D1 は registry、policy、audit、usage、reconciliation の projection を保持します。
daily cron は直前の UTC day を OpenAI Usage API と reconciliation します。
```

詳細な技術契約の正本は [SPEC.md](./SPEC.md) です。

## Usage

| Endpoint | 用途 |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI 互換 Chat Completions proxy |
| `POST /v1/responses` | OpenAI 互換 Responses proxy |
| `GET /v1/models` | runtime registry で有効な complimentary model |
| `GET /quota` | STANDARD / MINI pool の現在状態 |
| `/admin/*` | Cloudflare Access で保護された operator API / UI |

対応する入力は text です。Tool use は client の `tools_mode` が `ALLOW` の場合のみ許可されます。

Cloudflare AI Gateway Custom Provider / OpenCode 連携は [docs/cloudflare-ai-gateway-custom-provider.md](./docs/cloudflare-ai-gateway-custom-provider.md) を参照してください。

## Configuration

machine-usable template は [.env.example](./.env.example) です。

重要な runtime controls は quota limits、input size、in-flight lease、upstream AI Gateway、client-key pepper、OpenAI Usage API、Cloudflare Access、optional Deno tokenizer です。

完全な reference は [docs/configuration.md](./docs/configuration.md) を参照してください。

## Documentation

| 読者 / 目的 | 正本 |
| --- | --- |
| 最初の入口・文書 routing | [README.md](./README.md) |
| 技術仕様・不変条件 | [SPEC.md](./SPEC.md) |
| AI coding agent instruction | [AGENTS.md](./AGENTS.md) |
| 完全な設定 reference | [docs/configuration.md](./docs/configuration.md) |
| provisioning / deployment | [docs/deployment.md](./docs/deployment.md) |
| monitoring / reconciliation / canary / rollback / secrets | [docs/operations.md](./docs/operations.md) |
| Deno tokenizer | [docs/deno-tokenizer.md](./docs/deno-tokenizer.md) |
| Cloudflare AI Gateway Custom Provider | [docs/cloudflare-ai-gateway-custom-provider.md](./docs/cloudflare-ai-gateway-custom-provider.md) |
| 過去の要件・設計記録 | `REQUIREMENTS*.md` と `docs/superpowers/` — 非 authoritative |

## Development

Node.js 22 以上が必要です。

```bash
npm install
cp .env.example .env
chmod 600 .env
npm run setup:local -- --env-file=.env
npm run dev -w apps/gateway-worker
```

default local setup では production credential は不要です。

変更前後の基本検証:

```bash
npm run typecheck
npm test
```

Deployment は [docs/deployment.md](./docs/deployment.md)、運用は [docs/operations.md](./docs/operations.md) を参照してください。

## License

[MIT](./LICENSE)
