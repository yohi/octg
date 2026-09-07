# Deno Tokenizer

The Deno tokenizer is an optional external tokenization service for OCTG. It offloads large exact `o200k_base` BPE work from the Gateway Worker while keeping the Cloudflare `TokenizerController` path for smaller inputs or deployments where Deno is disabled.

For repository-wide configuration names, see [configuration.md](./configuration.md). For general production rollout, monitoring, rollback, and secret rotation, see [deployment.md](./deployment.md) and [operations.md](./operations.md).

## Architecture

```text
Gateway Worker
  |
  +-- Deno disabled --------------------> TokenizerController DO
  |
  +-- Deno enabled
        |
        +-- inputTextBytes < threshold -> TokenizerController DO
        |
        `-- inputTextBytes >= threshold -> Deno tokenizer
```

The routing implementation is in `apps/gateway-worker/src/tokenization-routing.ts`.

Both providers return the information needed for the same gateway-side estimated-input calculation. Deno does not create a separate quota model.

## Activation Contract

The Worker treats these as one configuration group:

- `DENO_TOKENIZER_ENDPOINT`;
- `DENO_TOKENIZER_AUTH_TOKEN`;
- `DENO_TOKENIZER_THRESHOLD_BYTES`;
- `DENO_TOKENIZER_TIMEOUT_MS`.

All absent means **disabled**.

All valid means **enabled**.

A partial group or invalid value means **configuration error**. The Worker fails closed; it does not silently choose the Durable Object as a recovery path.

The endpoint must be HTTPS. Threshold and timeout must be positive values accepted by the runtime validators.

## Authentication

The Deno service uses a shared tokenizer authentication value.

Keep these concepts separate:

- `DENO_DEPLOY_TOKEN`: management credential used to deploy the Deno app;
- production shared-auth source stored in the protected GitHub Environment;
- `DENO_TOKENIZER_AUTH_TOKEN`: Worker-side secret;
- `OCTG_TOKENIZER_AUTH_TOKEN`: Deno runtime secret.

The deployment workflow maps the protected shared-auth value into the two runtime sides. Do not put it in repository variables or committed files.

## Service Properties

The Deno service is stateless for tokenization requests.

It must not persist:

- request input text;
- OCTG client API keys;
- tokenizer request state.

The gateway sends only the normalized tokenization workload required by the component contract.

## Deployment

The runtime entry point is:

```text
apps/deno-tokenizer/src/main.ts
```

The repository-root `deno.json` controls the Deno deployment manifest.

The production workflow intentionally stages only the Deno manifest and source trees needed by the service, rather than uploading the npm workspace or `node_modules`.

Use the current Deno deployment workflow in `.github/workflows/deploy-deno-tokenizer.yml`. The workflow is the executable authority for the exact command/version used to deploy.

At a minimum, configure the protected production Deno environment with the organization/app identity and deployment/authentication secrets listed in [configuration.md](./configuration.md).

## Rollout

Recommended rollout order:

1. deploy and validate the Gateway Worker with Deno disabled;
2. deploy the Deno tokenizer service;
3. verify its authentication and health behavior without logging payloads;
4. configure a measured positive threshold and timeout;
5. activate the complete four-setting Worker configuration together;
6. run a small-input request and confirm `cloudflare_do`;
7. run an accepted large-input canary and confirm `deno`;
8. monitor resource-stage events and quota accounting.

Do not activate only one or two Deno settings.

## Failure Semantics

Deno tokenization is before quota reservation.

Therefore a Deno configuration or tokenization failure does not deliberately reserve quota or call OpenAI.

A routed Deno failure is treated as tokenizer unavailable/internal error. OCTG does not retry the same request through `TokenizerController`.

A request judged too large by tokenization/input limits is rejected as `request_too_large`.

Arithmetic failure in token estimation is fail-closed.

## Canary Acceptance

A Deno canary should prove at least:

- a below-threshold request uses `TokenizerController`;
- an at/above-threshold request uses Deno;
- the request still returns normal OCTG quota headers on success;
- Deno authentication failure does not reach quota reservation/upstream;
- Deno network/timeout failure does not fall back to Durable Object tokenization;
- no input text or secret is introduced into logs;
- Worker resource usage improves or remains within the acceptance target that motivated offload.

Use representative synthetic text rather than production prompts.

## Observability

The Gateway Worker resource-stage telemetry includes tokenization details such as:

- `tokenizationProvider`;
- `tokenizationFailureCategory`;
- network error name when available;
- input text bytes;
- tokenization duration.

Use these fields with the Worker version ID to correlate resource-limit incidents.

## Disable / Roll Back

To disable Deno routing, deploy a Worker configuration in which the Deno four-setting group is absent.

Do not leave a partially configured group as a rollback technique; partial configuration is intentionally invalid.

Disabling Deno returns all accepted inputs to the Cloudflare `TokenizerController` path, so validate Worker resource behavior before sending large traffic.

For the general Worker rollback procedure, see [operations.md](./operations.md).
