# Deployment

[日本語](./deployment.ja.md)

This document covers provisioning and deployment of an OCTG instance. Configuration values and secret classifications live in [configuration.md](./configuration.md). Runtime procedures after deployment live in [operations.md](./operations.md).

## Deployment Model

A production OCTG deployment uses:

- a Cloudflare Worker;
- a D1 database;
- `QuotaController` and `TokenizerController` Durable Objects;
- a Cloudflare AI Gateway used for OCTG → OpenAI traffic (Gateway B);
- a Cloudflare Access application for `/admin/*`;
- OpenAI credentials configured for the intended complimentary project;
- optionally, a Deno Deploy tokenizer service.

If clients reach OCTG through Cloudflare AI Gateway Custom Provider, use a separate ingress Gateway A. See [cloudflare-ai-gateway-custom-provider.md](./cloudflare-ai-gateway-custom-provider.md).

## Prerequisites

Local tooling:

- Node.js 22 or later;
- npm;
- an authenticated Cloudflare/Wrangler setup for the target account.

Cloud resources that must exist before `setup:deploy`:

- D1 database;
- outbound AI Gateway B;
- Cloudflare Access application.

The setup script does not create those services for you.

## Create from the Template Repository

1. Create a repository from the `yohi/octg` GitHub template.
2. Clone your new repository.
3. Install dependencies:

```bash
npm install
```

4. Copy the environment template:

```bash
cp .env.example .env
chmod 600 .env
```

5. Fill the Production section with values for your own resources.

Do not reuse the template repository's instance-specific account IDs, D1 IDs, Access audience, or upstream endpoint.

## Provision Cloudflare Resources

### D1

Create a D1 database and place its database ID in the deployment configuration.

For example:

```bash
npx wrangler d1 create octg
```

The Worker binding name is `DB`, and migrations are under `db/migrations`.

### Outbound AI Gateway B

Create the AI Gateway that OCTG will use to call the OpenAI provider.

`OCTG_UPSTREAM_BASE_URL` must be the OpenAI provider endpoint and end in:

```text
/openai
```

Configure the OpenAI project credential on the Cloudflare side according to your deployment's credential model. The Worker itself authenticates to Gateway B with `OCTG_UPSTREAM_API_TOKEN`.

### Cloudflare Access

Create an Access application for the Admin surface and configure:

- `ACCESS_TEAM_DOMAIN`;
- `ACCESS_AUD`.

Admin API and Admin UI requests are rejected if the Access JWT cannot be verified.

## Prepare Secrets

The production Worker uses these core request-path secrets:

- `OCTG_KEY_PEPPER`;
- `OCTG_UPSTREAM_API_TOKEN`.

`OPENAI_USAGE_API_KEY` is a Worker secret used by `fetchUsage` for scheduled or manual Usage API reconciliation. It is not used for normal request authentication or proxying. The deployment setup currently registers it as a Worker secret, so provide it when using `npm run setup:deploy`.

Keep all secret values outside committed files. `OCTG_KEY_PEPPER` must match the value used to create stored client-key hashes.

Optional Deno tokenization introduces its own shared-auth secret. See [deno-tokenizer.md](./deno-tokenizer.md).

## Validate Before Deployment

Run:

```bash
npm run typecheck
npm test
```

Then validate deployment inputs without changing the target:

```bash
npm run setup:deploy -- --env-file=.env --dry-run
```

Resolve every reported placeholder or invalid target before the real run.

## Deploy

Run:

```bash
npm run setup:deploy -- --env-file=.env
```

The setup path uses existing resources, updates Worker configuration as designed by the script, applies remote D1 migrations, registers secrets, and deploys the Worker.

Treat the script and its tests as authoritative for its exact side effects; do not duplicate a step-by-step script implementation in this guide.

## First Verification

After deployment:

1. verify `/v1/models` with a dedicated OCTG client key;
2. verify `/quota`;
3. make one small Chat Completions request;
4. confirm the response has an `X-OCTG-Request-Id`;
5. confirm the expected pool changes;
6. confirm the Admin UI/API is not accessible without Cloudflare Access;
7. inspect Worker observability for an expected request flow.

Example:

```bash
curl https://<worker-host>/v1/chat/completions \
  -H "Authorization: Bearer <octg-client-key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"<model-from-v1-models>","messages":[{"role":"user","content":"Hello"}]}'
```

Use `/v1/models` rather than a copied model list to select a model available in your deployment.

## GitHub Actions

### Production Worker

`.github/workflows/deploy-production.yml` runs on changes to `master` and validates the repository before deploying the production Worker. The workflow includes type checking, tests, contract checks, D1 migration handling, and versioned Worker deployment.

Repository/environment credentials used by the workflow must match the target instance. Do not copy another deployment's secrets.

### Preview

`.github/workflows/preview-smoke.yml` validates pull requests against a dedicated Preview environment.

Preview is a separate control plane. Use separate Worker, D1, client, pepper, and related credentials. Version Override-based smoke traffic must not require production resources.

See [configuration.md](./configuration.md) for Preview input names.

### Deno Tokenizer

The Deno tokenizer has a separate deployment workflow and deployment model. See [deno-tokenizer.md](./deno-tokenizer.md).

The Production Worker workflow reads the three non-secret Deno settings from
GitHub Repository Variables and the shared-auth source from the protected
`deno-production` Environment Secret. It validates them before applying remote
D1 migrations, then uploads a version containing the explicit Variables and
Worker Secret together. The checked-in Worker configuration intentionally does
not hard-code these environment-owned Deno values.

The Deno Deploy workflow validates from `apps/deno-tokenizer` and deploys from
the staged repository-root source described in
[deno-tokenizer.md](./deno-tokenizer.md). `DENO_DEPLOY_TOKEN` is a Deno Deploy
management credential; `OCTG_TOKENIZER_AUTH_TOKEN` remains a Deno runtime
Secret.

Preview has a separate Deno application and `preview` Environment. Its
credential-bearing smoke first proves that invalid Deno authentication fails
closed, then proves the valid route, and always restores the previous Worker
version. Fork pull requests do not receive Preview credentials.

## Production and Preview Isolation

Production and Preview SHOULD be separate for:

- Worker;
- D1 database;
- Durable Object state;
- client registry;
- client keys and pepper;
- audit and reconciliation state;
- Deno tokenizer application and shared-auth secret.

If an upstream billing principal is shared, that does not make D1 or Durable Object state interchangeable. Apply explicit Preview limits and keep failures conservative.

## After Deployment

Use [operations.md](./operations.md) for:

- monitoring;
- quota inspection;
- reconciliation;
- manual reserve-unknown resolution;
- canary acceptance;
- rollback;
- secret rotation;
- incident handling.
