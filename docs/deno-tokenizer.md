# Deno Tokenizer — Deployment, Operations, and Canary Acceptance

This document covers the deployment and operational procedures for the optional Deno-based tokenizer service (`apps/deno-tokenizer`), which provides exact `o200k_base` BPE tokenization as an external RPC endpoint for the OCTG Gateway Worker.

The repository-wide environment variable catalog is available in [CONFIGURATION.md](./CONFIGURATION.md).

## Overview

The Deno tokenizer is an **optional, opt-in** component. When enabled, the Gateway Worker routes large input texts (at or above a configurable byte threshold) to this service instead of the local Cloudflare Durable Object (`TokenizerController`). This offloads CPU-intensive BPE work from the Worker to a separate Deno Deploy instance.

```text
Gateway Worker
  ├── Small inputs / Deno disabled → TokenizerController (Cloudflare DO)
  └── Large inputs / Deno enabled  → Deno Tokenizer Service (Deno Deploy)
```

## Architecture

- **Gateway Worker** (`apps/gateway-worker/src/proxy.ts`): Routes tokenization
  requests based on the four `DENO_TOKENIZER_*` settings.
- **Deno Tokenizer** (`apps/deno-tokenizer/`): Standalone Deno service using
  `tiktoken/lite` for exact `o200k_base` BPE. Stateless — no input text, API
  keys, or tokenizer state is persisted.
- **Tokenization Router** (`apps/gateway-worker/src/tokenization-routing.ts`):
  Decides which provider to use based on configuration and input size.
- **Observability** (`apps/gateway-worker/src/resource-observation.ts`): Emits `tokenizationProvider` and `tokenizationFailureCategory` fields in resource stage events.

## 1. Deployment

### 1.1 Prerequisites

- **Deno** runtime (v2.x or later) installed locally for testing.
- **Deno Deploy** account (free tier available) for hosting.
- A **Gateway Worker** deployed with `TOKENIZER_CONTROLLER` binding and migration `v2` applied.

### 1.2 Deno Deploy Deployment

The Deno tokenizer runtime entrypoint remains `apps/deno-tokenizer/src/main.ts`.
The repository-root `deno.json` controls the deployment manifest. It uploads only
`./deno.json`, `apps/deno-tokenizer/src/**`, and `packages/shared/src/**`; npm
workspace manifests are intentionally excluded so Deno Deploy resolves npm
dependencies through Deno's global cache instead of an uploaded `node_modules` tree.

1. **Recommended: GitHub Actions**:
   - Create the Deno Deploy app in the current Deno Deploy console. Deno Deploy
     Classic and `deployctl` are not supported.
   - Configure the GitHub Environment `deno-production` with the non-secret variables
     `DENO_DEPLOY_ORG` and `DENO_DEPLOY_APP`.
   - Add the Deno access token as the Environment Secret `DENO_DEPLOY_TOKEN`.
     Create it at <https://console.deno.com/account/access-tokens> and do not print
     or commit it.
   - The repository workflow `.github/workflows/deploy-deno-tokenizer.yml` runs
     `deno install`, `deno task check`, and `deno task test` for pull requests and
     deploys only after those checks pass on a push to `master`. Before merging, add
     the `deploy-deno` label to a same-repository pull request, then approve the
     `deno-production` Environment deployment. This executes the same gated
     Production deployment path and verifies the Deno Deploy revision build and
     warmup. The workflow can also be started with **Run workflow** when available;
     fork pull requests remain validation-only.
   - The workflow runs the pinned `@deno/deploy@0.0.9904` implementation with
     `deno run -A jsr:@deno/deploy@0.0.9904 --prod --json --non-interactive`
     from the ephemeral staging directory `.deno-deploy-source`. This avoids a
     Deno 2.9.6 wrapper bug that duplicates passthrough arguments. Immediately
     before deployment it copies the root `deno.json` and injects the non-secret
     `DENO_DEPLOY_ORG` and `DENO_DEPLOY_APP` values into that staging copy;
     `DENO_DEPLOY_TOKEN` is never written to the file and the repository root
     remains unchanged.

2. **Push to Git** (if using Deno Deploy's integrated Git deployment instead):
   ```bash
   git add deno.json apps/deno-tokenizer/ packages/shared/src/
   git commit -m "feat(deno-tokenizer): add standalone BPE service"
   git push
   ```

3. **Configure the Deno Deploy app**:
   - Go to [Deno Deploy console](https://console.deno.com/).
   - Create an app and configure the repository root as its application directory.
   - Set the entrypoint to `apps/deno-tokenizer/src/main.ts`.
   - Ensure the deployment uses the checked-in root `deno.json` manifest. Its
     `deploy.include` entries are `./deno.json`, `apps/deno-tokenizer/src/**`, and
     `packages/shared/src/**`; do not add `package.json` or `package-lock.json` to
     the Deploy artifact.
   - Add environment variables (see §1.3).
   - Deploy.

4. **Manual Deploy (without GitHub Actions)**:
   ```bash
   # Run these commands from the repository root.
   staging="$PWD/.deno-deploy-source"
   mkdir -p "$staging/apps/deno-tokenizer/src" "$staging/packages/shared/src"
   cp -R apps/deno-tokenizer/src/. "$staging/apps/deno-tokenizer/src"
   cp -R packages/shared/src/. "$staging/packages/shared/src"
   deno cache --config apps/deno-tokenizer/deno.json \
     npm:tiktoken@1.0.22/lite/tiktoken_bg.wasm
   wasm_source="$(
     deno eval \
       --config apps/deno-tokenizer/deno.json \
       'console.log(import.meta.resolve("tiktoken/lite/tiktoken_bg.wasm"));'
   )"
   node - "$wasm_source" "$staging/apps/deno-tokenizer/src/tiktoken_bg.wasm" <<'NODE'
   const fs = require("node:fs");
   const { fileURLToPath } = require("node:url");
   const [source, destination] = process.argv.slice(2);
   fs.copyFileSync(fileURLToPath(source), destination);
   NODE
   printf 'Deno Deploy access token: '
   read -r -s DENO_DEPLOY_TOKEN
   printf '\n'
   export DENO_DEPLOY_TOKEN
   export DENO_DEPLOY_ORG="your-org"
   export DENO_DEPLOY_APP="your-app"
   cp deno.json "$staging/deno.json"
   node - "$staging/deno.json" <<'NODE'
   const fs = require("node:fs");
   const path = process.argv[2];
   const config = JSON.parse(fs.readFileSync(path, "utf8"));
   config.deploy.org = process.env.DENO_DEPLOY_ORG;
   config.deploy.app = process.env.DENO_DEPLOY_APP;
   fs.writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
   NODE
   (
     cd "$staging"
     deno run -A jsr:@deno/deploy@0.0.9904 \
       --prod --json --non-interactive
   )
   unset DENO_DEPLOY_TOKEN
   unset DENO_DEPLOY_ORG DENO_DEPLOY_APP
   ```

   The preparation command writes deployment identity only to the staging copy;
   the checked-out root remains portable and unmodified.

### 1.3 Environment Variables

The complete variable and Secret catalog, including where each value is obtained and
which environment owns it, is maintained in
[`docs/CONFIGURATION.md`](./CONFIGURATION.md). Use that catalog when provisioning a
new Production or Preview deployment.

The Deno app requires `OCTG_TOKENIZER_AUTH_TOKEN` as a Deno Deploy runtime Secret.
The matching Worker Secret is `DENO_TOKENIZER_AUTH_TOKEN`; both values must be the
same, but the Deno runtime Secret must not be added to GitHub or the workflow.
`MAX_INPUT_BYTES` is optional and must match the corresponding Worker limit.

The shared resolver supplies the default and clamps the effective input limit.

### 1.4 Gateway Worker Configuration

The checked-in `apps/gateway-worker/wrangler.jsonc` intentionally omits all
Deno settings. With all four settings absent, `resolveDenoTokenizerConfig`
returns `disabled`, so the Worker keeps using `TokenizerController`. Do not add
placeholder values: a partial or invalid configuration fails closed with a
generic `500` for authenticated requests.

After the Deno Deploy service is healthy, configure each Production or Preview
Worker independently. Add the three non-secret values to that deployment's
`vars`:

```jsonc
"vars": {
  // ... existing vars ...
  "DENO_TOKENIZER_ENDPOINT": "https://<your-project>.deno.dev/tokenize",
  "DENO_TOKENIZER_THRESHOLD_BYTES": "<measured-positive-integer>",
  "DENO_TOKENIZER_TIMEOUT_MS": "<measured-positive-integer>"
}
```

This is a deployment-provisioning step, not a checked-in default. Replace the
example values with measured values for the target deployment, and do not commit
the placeholders or the authentication Secret.

Set the matching Worker secret separately and deploy the same target:

```bash
npx wrangler secret put DENO_TOKENIZER_AUTH_TOKEN --config apps/gateway-worker/wrangler.jsonc
npx wrangler deploy --config apps/gateway-worker/wrangler.jsonc
```

The four values must be configured together. Do not reuse an endpoint or secret
between Production and Preview.

### 1.5 Threshold Configuration

- `DENO_TOKENIZER_THRESHOLD_BYTES` determines when to use the Deno tokenizer.
  Inputs with UTF-8 byte length greater than or equal to the threshold use Deno.
- `DENO_TOKENIZER_TIMEOUT_MS` bounds the complete Deno response lifecycle,
  including body processing.
- All four settings absent means disabled. Any missing or invalid setting means
  configuration invalid and fail-closed; it does not fall back to
  `TokenizerController`.
- Choose threshold and timeout from a measured canary for the target
  environment. Do not treat an unmeasured value as a production default.

## 2. Operations

### 2.1 Monitoring

The Deno tokenizer itself does **not** emit structured stdout logs. Its JSON request body contains only `inputText`; the HTTP transport still requires the `Authorization: Bearer <token>` header. It does not receive a request ID or upstream metadata and returns only the BPE count. All observability is owned by the Gateway Worker (`resource-observation.ts`).

**Gateway Worker observability** (`resource-observation.ts`):
- When Deno tokenizer is used: `tokenizationProvider: "deno"`
- When Cloudflare DO is used: `tokenizationProvider: "cloudflare_do"`
- When Deno configuration is invalid: `tokenizationProvider: "deno"`, `tokenizationFailureCategory: "configuration"`
- When Deno fails at runtime: `tokenizationProvider: "deno"`, `tokenizationFailureCategory: "timeout" | "network" | "upstream_status" | "malformed_response" | "arithmetic"`


### 2.2 Health Check

```bash
curl https://<your-project>.deno.dev/health
# Expected: {"status":"ok"}
```

### 2.3 Troubleshooting

| Gateway returns `500` with `error:internal_error` (public) / `error:tokenizer_unavailable` (internal event) | Deno endpoint unreachable or auth failure | Check `DENO_TOKENIZER_ENDPOINT` and `DENO_TOKENIZER_AUTH_TOKEN` match. Check Deno Deploy logs. |
|---|---|---|
| High latency on large inputs | Deno Deploy cold start | Ensure the Deno project is on a paid tier or keep it warm with periodic health checks. |
| Auth errors (`401`) in Deno logs | `Authorization` header mismatch | Regenerate token and update both Deno Deploy env and Gateway Worker secret/var. |

- If the Deno service is unreachable, times out, or returns an error, the Gateway Worker returns `500 internal_error` to the client.
- It does **not** fall back to approximate token counting, local BPE, unverified estimation, or the Cloudflare DO tokenizer.
- The `tokenizationFailureCategory` field in observability events records the exact failure mode (`configuration`, `timeout`, `network`, `upstream_status`, `malformed_response`, `arithmetic`).

## 3. Canary Acceptance Criteria

Before enabling the Deno tokenizer in production, verify the following:

### 3.1 Functional Criteria

- [ ] **Small input routing**: Requests with `inputTextBytes < threshold` route to `cloudflare_do` (TokenizerController).
- [ ] **Large input routing**: Requests with `inputTextBytes >= threshold` route to `deno` (Deno tokenizer).
- [ ] **Exact BPE parity**: Token counts from Deno tokenizer match TokenizerController for identical inputs (within the same `o200k_base` vocabulary).
- [ ] **74k token fixture**: A ~74,000 token input produces stable, correct counts and does not trigger Worker CPU limits.
- [ ] **Auth enforcement**: Requests without `Authorization: Bearer <token>` are rejected with `401`.
- [ ] **Timeout handling**: If Deno does not respond within the configured timeout, Gateway returns `500` with `tokenizationFailureCategory: "timeout"`.

### 3.2 Observability Criteria

- [ ] **Resource stage events** include `tokenizationProvider` (`"deno"` or `"cloudflare_do"`).
- [ ] **Deno failure events** include `tokenizationFailureCategory` (`timeout`, `network`, etc.).
- [ ] **Invalid configuration events** include `tokenizationProvider: "deno"` and `tokenizationFailureCategory: "configuration"`.
- [ ] **No credential leakage**: Logs and events do not contain `inputText`, `authToken`, or API keys.

### 3.3 Performance Criteria

- [ ] **Latency**: Deno tokenizer p95 latency for 64 KiB inputs is < 500 ms (excluding network RTT).
- [ ] **Worker CPU**: Gateway Worker CPU time does not spike on large inputs when Deno tokenizer is enabled.
- [ ] **Cold start**: First request after Deno Deploy idle period completes successfully (may be slower but must not fail).

### 3.4 Security Criteria

- [ ] **Token secrecy**: `OCTG_TOKENIZER_AUTH_TOKEN` and
  `DENO_TOKENIZER_AUTH_TOKEN` are not committed to the repository.
- [ ] **No data persistence**: Deno tokenizer does not write input text or tokens to disk/database.
- [ ] **HTTPS only**: Deno Deploy endpoint serves only over HTTPS.
- [ ] **Input validation**: Malformed JSON or oversized inputs are rejected with `400` or `413` before BPE processing.

### 3.5 Rollback Criteria

If any canary check fails:
- Remove or unset all four `DENO_TOKENIZER_*` settings, including the
  `DENO_TOKENIZER_AUTH_TOKEN` Secret.
- All traffic immediately falls back to `TokenizerController` (Cloudflare DO).
- No Durable Object migration or schema change is required for rollback.

## 4. Local Testing

```bash
cd apps/deno-tokenizer

# Start local server
deno task dev   # or: deno run --allow-net src/main.ts

# Test tokenization
curl -X POST http://localhost:8080/tokenize \
  -H "Authorization: Bearer <OCTG_TOKENIZER_AUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"inputText": "Hello world"}'

# Expected: {"baseTokenCount": 2}
```

## 5. References

- Design spec: `docs/superpowers/specs/2026-08-27-deno-tokenizer-design.md`
- Implementation plan: `docs/superpowers/plans/2026-08-27-deno-tokenizer.md`
- Gateway tokenization router: `apps/gateway-worker/src/tokenization-routing.ts`
- Deno tokenizer client: `apps/gateway-worker/src/deno-tokenizer-client.ts`
- Observability contract: `apps/gateway-worker/src/resource-observation.ts`
