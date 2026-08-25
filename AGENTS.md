# OCTG — Agent Guide

OCTG is an OpenAI-compatible API gateway that shares the OpenAI Data Sharing Program (Tier 3) complimentary token quota across multiple clients.

## Stack & Workspace

- TypeScript (strict)
- Cloudflare Workers + Durable Objects (SQLite-backed) + D1
- npm workspaces
- Vitest + `@cloudflare/vitest-pool-workers`

## Essential Commands

```bash
npm install
npm test            # all workspaces
npm run typecheck   # all workspaces
npm run dev -w apps/gateway-worker
```

## Universal Guardrails

- **Quota authority lives in Durable Objects.** D1 is audit-only. Never make quota decisions depend on D1 writes.
- **Never mix Production and Preview control planes.** Worker, D1, Durable Objects, client/policy/model registry, and reconciliation state must stay separate.
- **Shared upstream billing is allowed only with bounded coordination.** Preview must not consume Production quota unboundedly.
- **Store credentials as keyed hashes.** Never put raw `octg_sk_*` or OpenAI API keys in source, logs, or client configs.
- **Audit writes are best-effort.** Fail-closed quota behavior must not depend on audit log delivery.
- **Gateway A (Cloudflare AI Gateway Custom Provider) and Gateway B (a separate
  upstream Cloudflare AI Gateway instance used by the Worker) are separate.** Do
  not confuse the OpenCode provider ID, the registered provider slug, the URL
  slug, or the two gateway instances.

## Where to Look Next

- Architecture, API contracts, error semantics: [SPEC.md](./SPEC.md)
- Deployment, secrets, rotation, and operations: [README.md](./README.md)
- Cloudflare AI Gateway Custom Provider setup: [docs/cloudflare-ai-gateway-custom-provider.md](./docs/cloudflare-ai-gateway-custom-provider.md)
- Template-based new-instance setup: [docs/DEPLOY_FROM_TEMPLATE.md](./docs/DEPLOY_FROM_TEMPLATE.md)
