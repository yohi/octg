# Cloudflare AI Gateway Custom Provider

[日本語](./cloudflare-ai-gateway-custom-provider.ja.md)

This guide registers a deployed OCTG Worker as a Cloudflare AI Gateway Custom Provider.

The recommended topology uses two distinct AI Gateway instances:

```text
Client
  |
  v
Cloudflare AI Gateway A
  Custom Provider: OCTG
  |
  v
OCTG Worker
  |
  v
Cloudflare AI Gateway B
  OpenAI provider
  |
  v
OpenAI API
```

Gateway A is client ingress. Gateway B is OCTG's outbound OpenAI gateway. Do not point the Worker back at Gateway A's `custom-octg` route.

## Prerequisites

- OCTG Worker deployed.
- Gateway B configured for OCTG → OpenAI.
- `OCTG_UPSTREAM_BASE_URL` points to Gateway B and ends in `/openai`.
- An OCTG client key (`octg_sk_*`) exists and its key hash is registered in D1.
- Separate handling for Gateway A and Gateway B Run tokens.

AI Gateway Run tokens can have account-level scope. If the deployment requires a stronger authorization boundary than two gateway instances in one account provide, use separate accounts or another architecture that narrows the outbound credential boundary.

## Register Gateway A

In Cloudflare AI Gateway, create or select the ingress gateway and add a Custom Provider.

Use:

```text
Provider name: OCTG
Provider slug: octg
Base URL: https://octg-gateway.<subdomain>.workers.dev
```

Do not append `/v1` to the Custom Provider Base URL.

Enable authenticated gateway access and create a Run token for Gateway A.

Add the existing OCTG client key as the Custom Provider's provider credential. The value is an `octg_sk_*` key, not an OpenAI key.

Client request paths become:

```text
/custom-octg/v1/chat/completions
/custom-octg/v1/responses
```

## Credential Boundaries

Keep these credentials distinct:

| Credential | Used by |
| --- | --- |
| OCTG `octg_sk_*` key | Gateway A provider credential / direct OCTG client auth |
| Gateway A Run token | client → Gateway A |
| Gateway B Run token | OCTG Worker → Gateway B |
| OpenAI project credential | Gateway B provider credential |
| `OCTG_KEY_PEPPER` | OCTG Worker client-key hashing |

The Worker sends the Gateway B Run token through `cf-aig-authorization`.

Do not distribute the OpenAI key to OCTG clients.

Keep AI Gateway payload collection disabled for both ingress and outbound paths when prompt/response logging is not intended.

## OpenCode Responses Provider

A local OpenCode provider ID does not need to equal Cloudflare's provider slug.

Example:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "cloudflare-ai-gateway-octg/gpt-5.6-luna",
  "providers": {
    "cloudflare-ai-gateway-octg": {
      "name": "OCTG via Cloudflare AI Gateway",
      "package": "@opencode-ai/ai/providers/openai/responses",
      "settings": {
        "baseURL": "https://gateway.ai.cloudflare.com/v1/{env:OCTG_CF_ACCOUNT_ID}/{env:OCTG_CF_GATEWAY_ID}/custom-octg/v1"
      },
      "headers": {
        "cf-aig-authorization": "Bearer {env:OCTG_CF_API_TOKEN}",
        "cf-aig-collect-log-payload": "false",
        "cf-aig-skip-cache": "true"
      },
      "body": {
        "store": false
      },
      "models": {
        "gpt-5.6-luna": {
          "name": "gpt-5.6 Luna",
          "modelID": "gpt-5.6-luna"
        }
      }
    }
  }
}
```

For this client configuration, the token referenced by `OCTG_CF_API_TOKEN` is the Gateway A Run token, not a Cloudflare management token or OpenAI API key.

For Responses requests, OCTG requires the request body to contain the context it must estimate. Do not rely on `previous_response_id` or `conversation`. With `store: false`, resend the text/tool/reasoning history needed by the next request.

## Verify

Non-streaming example:

```bash
curl https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_a_id}/custom-octg/v1/chat/completions \
  -H "Authorization: Bearer <OCTG client key>" \
  -H "cf-aig-authorization: Bearer <Gateway A Run token>" \
  -H "cf-aig-collect-log-payload: false" \
  -H "cf-aig-skip-cache: true" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.6-luna","messages":[{"role":"user","content":"Hello"}]}'
```

Verify:

- Gateway A records the ingress request without an unintended payload log;
- OCTG returns an `X-OCTG-Request-Id`;
- `/quota` reflects the appropriate complimentary-pool accounting;
- Gateway B records the outbound provider call;
- the client receives the OpenAI-compatible response;
- the ingress response was not unexpectedly served from cache.

## Retry and Idempotency

OCTG fixes the outbound Gateway B maximum-attempt behavior to one.

If Gateway A or another trusted ingress can retry, use `Idempotency-Key` and ensure untrusted callers cannot weaken the ingress retry policy.

OCTG accepts an idempotency key up to 255 UTF-8 bytes and deduplicates it within the client/pool/day quota controller. An empty key is treated as absent.

Retry policy does not replace reconciliation for uncertain upstream outcomes.

## Troubleshooting

### Gateway A returns `Invalid provider`

- Custom Provider Base URL must point to the Worker root, not `/v1/chat/completions`.
- Confirm the Cloudflare Custom Provider path uses `custom-octg`.

### OCTG → Gateway B returns `Invalid provider`

Confirm `OCTG_UPSTREAM_BASE_URL` points to Gateway B's OpenAI provider endpoint and ends in `/openai`.

### OCTG returns 401

- Confirm Gateway A's provider credential is the exact `octg_sk_*` whose hash is stored in D1.
- Confirm `OCTG_KEY_PEPPER` matches the pepper used when that hash was produced.

### Routing loop

Confirm Gateway B is not Gateway A's `custom-octg` endpoint and is not the OCTG Worker itself.

### Responses tool/history failures

Do not send unsupported stored-context references. Include the text and supported tool/reasoning history required for OCTG's local quota estimation.

For shared configuration ownership, see [configuration.md](./configuration.md).
