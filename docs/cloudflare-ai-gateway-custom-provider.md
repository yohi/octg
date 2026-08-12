<!-- markdownlint-disable MD013 -->

# OCTG as a Cloudflare AI Gateway Custom Provider

This runbook registers an already-deployed OCTG Worker as a Cloudflare AI Gateway **Custom Provider**, so clients can call OCTG through Gateway A while OCTG still reaches OpenAI through Gateway B.

## Architecture

```text
Client
  │
  ▼
Cloudflare AI Gateway A  (Custom Provider: custom-octg)
  │
  ▼
OCTG Worker
  │
  ▼
Durable Object: QuotaController
  │
  ▼
Cloudflare AI Gateway B  (OpenAI provider-native endpoint)
  │
  ▼
OpenAI API
```

Gateway A and Gateway B must be separate gateway instances. This prevents an outbound request from returning to Gateway A's `custom-octg` route and keeps inbound and outbound logs, credentials, and policies separate.

## Prerequisites

- OCTG Worker is already deployed.
- Gateway B (OCTG → OpenAI) exists and `OCTG_UPSTREAM_BASE_URL` ends with `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_b_id}/openai`.
- Gateway B has OpenAI Project A (Data Sharing ON) API key registered as BYOK.
- At least one OCTG client key (`octg_sk_*`) exists and its `key_hash` is in D1.
- You understand that Gateway A and Gateway B Run tokens are account-wide; keep them separate and rotate them separately.

## Setting up Gateway A

1. Cloudflare Dashboard → AI Gateway → **Create Gateway**.
2. Name it, for example `octg-ingress`.
3. **Custom Providers** → **Add Custom Provider**:
   - **Provider Name**: `OCTG`
   - **Provider Slug**: `octg`
   - **Base URL**: `https://octg-gateway.<subdomain>.workers.dev` (no `/v1` suffix)
   - **Enable**: checked
4. **Save**.
5. Open Gateway A **Settings** and enable **Authenticated Gateway**.
6. **Create authentication token** for Gateway A, grant **Run** permission, and store it separately from OCTG client keys.
7. **Provider Keys** → **Add API Key**:
   - Provider: `octg`
   - Alias: `default`
   - API Key: an existing `octg_sk_*` client key

The client request path is `/custom-octg/v1/chat/completions`; the Custom Provider Base URL must not include `/v1` or an endpoint path.

## OCTG-side checks

- `OCTG_UPSTREAM_BASE_URL` points to Gateway B and ends with `/openai`.
- `OCTG_UPSTREAM_API_TOKEN` is Gateway B's **AI Gateway Run token**.
- `OCTG_UPSTREAM_API_TOKEN` is sent as `cf-aig-authorization: Bearer <token>` to Gateway B.
- OpenAI provider key on Gateway B is BYOK; the Worker does **not** send an OpenAI key.
- Client keys exist in D1 as `key_hash`.

> **Implementation note:** The current Worker sends the Gateway B token in the `Authorization` header. The design spec calls for `cf-aig-authorization`. If Cloudflare AI Gateway rejects the outbound request, update `apps/gateway-worker/src/upstream.ts` to use `cf-aig-authorization`. This is intentionally left as a future code change because the current scope is documentation-first.

## Verification

### Non-streaming

```bash
curl https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_a_id}/custom-octg/v1/chat/completions \
  -H "Authorization: Bearer <OCTG client key>" \
  -H "cf-aig-authorization: Bearer <Gateway A Run token>" \
  -H "cf-aig-collect-log-payload: false" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.6-luna",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### Streaming

```bash
curl -N https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_a_id}/custom-octg/v1/chat/completions \
  -H "Authorization: Bearer <OCTG client key>" \
  -H "cf-aig-authorization: Bearer <Gateway A Run token>" \
  -H "cf-aig-collect-log-payload: false" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.6-luna",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

### Checkpoints

- Request appears in Gateway A logs (metadata only).
- `/quota` on OCTG shows quota consumed for the relevant pool.
- Gateway B logs show the outbound OpenAI call.
- OpenAI-compatible response reaches the client.
- Gateway A response cache is disabled or bypassed (`cf-aig-skip-cache: true`); verify `cf-aig-cache-status` is not `HIT`.

Use `cf-aig-collect-log-payload: false` on both the client request to Gateway A and the Worker request to Gateway B. Do not store prompts or responses in D1.

## Troubleshooting

### `Invalid provider` from Gateway A

- Base URL must be `https://octg-gateway.<subdomain>.workers.dev` without `/v1/chat/completions`.
- Provider slug must be `octg`; request path must contain `/custom-octg/`.

### `Invalid provider` from OCTG → Gateway B

- `OCTG_UPSTREAM_BASE_URL` must end with `/openai`, for example `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_b_id}/openai`.

### 401 Unauthorized from OCTG

- The Provider Key value in Gateway A must exactly match the `octg_sk_*` whose hash is in D1.
- `OCTG_KEY_PEPPER` on the Worker must match the pepper used to hash that client key.

### Routing loop

- `OCTG_UPSTREAM_BASE_URL` must not point back to Gateway A's `custom-octg` endpoint or to the OCTG Worker itself.
- Always use separate Gateway A and Gateway B instances.

### No response / timeout

- Check remaining quota via `/quota`.
- Check Gateway A timeout settings.
- Check the `requests` table in D1 for request arrival.
- Disable or limit Gateway A retries to 1 to avoid duplicate reservations; OCTG generates a fresh `req_${ulid()}` per delivery.

### Streaming does not work

- Confirm non-streaming works first.
- Include `"stream": true` in the body.
- For `/chat/completions`, OCTG adds `stream_options: { include_usage: true }` automatically when streaming.
- For `/responses`, rely on `response.completed` `response.usage` for settlement.

## Token rotation

For **leaked tokens**: revoke immediately, issue a new least-privilege Run token, update the relevant Secret, deploy, then verify Gateway B connectivity. Do not wait for the old token to stop working before revoking.

For **planned rotation**: issue a new least-privilege Run token, update the Secret, deploy, verify Gateway B connectivity, then revoke the old token.

Keep Gateway A and Gateway B Run tokens separate. In multi-account setups, do not mix tokens or BYOK credentials across accounts.

## Logging policy

Default to metadata-only logging (`cf-aig-collect-log-payload: false`) on both gateways. If payload logging is required, obtain prior approval covering the target gateway, request/response side, log count cap, access controls, deletion procedure, and any external encrypted storage destination.
