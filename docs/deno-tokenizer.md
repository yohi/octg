# Deno Tokenizer — Deployment, Operations, and Canary Acceptance

This document covers the deployment and operational procedures for the optional Deno-based tokenizer service (`apps/deno-tokenizer`), which provides exact `o200k_base` BPE tokenization as an external RPC endpoint for the OCTG Gateway Worker.

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

The Deno tokenizer is a single-file entrypoint (`src/main.ts`) with no external build step.

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
     deploys only after those checks pass on a push to `master`.
   - The workflow runs `deno deploy . --org ... --app ... --prod` from
     `apps/deno-tokenizer` in non-interactive mode.

2. **Push to Git** (if using Deno Deploy's integrated Git deployment instead):
   ```bash
   git add apps/deno-tokenizer/
   git commit -m "feat(deno-tokenizer): add standalone BPE service"
   git push
   ```

3. **Configure the Deno Deploy app**:
   - Go to [Deno Deploy console](https://console.deno.com/).
   - Create an app and configure `apps/deno-tokenizer` as its application directory.
   - Set the entrypoint to `src/main.ts`.
   - Add environment variables (see §1.3).
   - Deploy.

4. **Manual Deploy (without GitHub Actions)**:
   ```bash
   cd apps/deno-tokenizer
   printf 'Deno Deploy access token: '
   read -r -s DENO_DEPLOY_TOKEN
   printf '\n'
   export DENO_DEPLOY_TOKEN
   deno deploy . \
     --org=<your-org> --app=<your-app> --prod --non-interactive
   unset DENO_DEPLOY_TOKEN
   ```

### 1.3 Environment Variables

Configure these in the Deno Deploy dashboard or via CLI:

| Variable | Required | Description |
|---|---|---|
| `OCTG_TOKENIZER_AUTH_TOKEN` | **Yes** | Deno secret shared with the Worker. |
| `MAX_INPUT_BYTES` | No | Raw limit shared with the matching Worker. |

`OCTG_TOKENIZER_AUTH_TOKEN` is a Deno Deploy runtime secret. Configure it in the
Deno app and do not add it to the GitHub Environment or workflow.

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

The Deno tokenizer logs structured events to stdout. In Deno Deploy, these appear in the project logs.

**Successful request**:
```json
{"event":"deno_tokenizer.request","requestId":"req_abc123","method":"POST","durationMs":12,"status":200}
```

**Failed request** (e.g., auth failure):
```json
{"event":"deno_tokenizer.request","requestId":"req_abc123","method":"POST","durationMs":1,"status":401}
```

**Gateway Worker observability** (`resource-observation.ts`):
- When Deno tokenizer is used: `tokenizationProvider: "deno"`
- When Deno fails and fallback occurs: `tokenizationProvider: "deno"`, `tokenizationFailureCategory: "timeout" | "network" | ...`
- When Cloudflare DO is used: `tokenizationProvider: "cloudflare_do"`

### 2.2 Health Check

```bash
curl https://<your-project>.deno.dev/health
# Expected: {"status":"ok"}
```

### 2.3 Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| Gateway returns `500` with `error:tokenizer_unavailable` | Deno endpoint unreachable or auth failure | Check `DENO_TOKENIZER_ENDPOINT` and `DENO_TOKENIZER_AUTH_TOKEN` match. Check Deno Deploy logs. |
| All requests use `cloudflare_do` despite large inputs | Threshold not set or Deno config invalid | Verify `DENO_TOKENIZER_THRESHOLD_BYTES` is a positive integer. Verify `resolveDenoTokenizerConfig` returns `"enabled"`. |
| High latency on large inputs | Deno Deploy cold start | Ensure the Deno project is on a paid tier or keep it warm with periodic health checks. |
| Auth errors (`401`) in Deno logs | `Authorization` header mismatch | Regenerate token and update both Deno Deploy env and Gateway Worker secret/var. |

### 2.4 Fail-Closed Behavior

The Deno tokenizer is **fail-closed by design**:
- If the Deno service is unreachable, times out, or returns an error, the Gateway Worker returns `500 internal_error` to the client.
- It does **not** fall back to approximate token counting, local BPE, or unverified estimation.
- The `tokenizationFailureCategory` field in observability events records the exact failure mode (`timeout`, `network`, `upstream_status`, `malformed_response`, `arithmetic`).

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
- [ ] **No credential leakage**: Logs and events do not contain `inputText`, `authToken`, or API keys.
- [ ] **Request correlation**: Gateway request ID appears in both Gateway Worker and Deno tokenizer logs.

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
