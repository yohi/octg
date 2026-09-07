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

## HTTP Contract

The service exposes an unauthenticated health check and an authenticated
tokenization endpoint:

```text
GET  /health
POST /tokenize
```

`GET /health` returns a minimal healthy status. `POST /tokenize` requires
`Authorization: Bearer <OCTG_TOKENIZER_AUTH_TOKEN>` and accepts either a UTF-8
`text/plain` body or an `application/json` body with exactly one field:

```json
{"inputText":"text to count"}
```

The success response contains only the exact base BPE count:

```json
{"baseTokenCount":123}
```

The Gateway Worker adds opaque-input bytes and message overhead before quota
calculation. The service bounds both the raw request body and UTF-8 input text.
It returns a minimal error status for invalid authentication, media type, input,
size, or encoder failure and never exposes encoder exception details.

## Deployment

The runtime entry point is:

```text
apps/deno-tokenizer/src/main.ts
```

The repository-root `deno.json` controls the Deno deployment manifest.

The manifest includes `./deno.json`,
`./apps/deno-tokenizer/src/**`, and `./packages/shared/src/**`. Its dynamic
entrypoint is `./apps/deno-tokenizer/src/main.ts`. The production workflow
intentionally stages only these source trees and the required local WASM asset,
rather than uploading the npm workspace or `node_modules`.

The checked-in root manifest does not contain a Deno Deploy organization or app
identity. The workflow injects those non-secret values into an ephemeral
staging copy, checks the staged entrypoint, and deploys from that copy. The
checked-out repository remains unchanged.

Use the current Deno deployment workflow in
`.github/workflows/deploy-deno-tokenizer.yml`. It validates from
`apps/deno-tokenizer`, pins the Deno runtime and deploy wrapper, and deploys
only after validation. The workflow is the executable authority for the exact
command/version used to deploy.

At a minimum, configure the protected production Deno environment with the organization/app identity and deployment/authentication secrets listed in [configuration.md](./configuration.md).

## Rollout

Recommended rollout order, after establishing a Deno-disabled baseline with a
separate reviewed deployment procedure:

1. deploy the Deno tokenizer service;
2. verify its authentication and health behavior without logging payloads;
3. configure a measured positive threshold and timeout;
4. activate the complete four-setting Worker configuration together;
5. run a small-input request and confirm `cloudflare_do`;
6. run an accepted large-input canary and confirm `deno`;
7. monitor resource-stage events and quota accounting.

The current Production workflow requires the complete Deno setting group and
does not create the Deno-disabled baseline. Do not use it for that first stage.

Do not activate only one or two Deno settings.

For the resource-limit regression, use synthetic or sanitized text in the
approximately 74k-token class. Run concurrency 1, concurrency 2, and the
operator-defined expected peak. The acceptance result must show no Worker
`exceededCpu` outcome, paired gateway tokenization start/finish events, and
successful quota/upstream accounting for successful requests.

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

Cloudflare TokenizerController requests additionally emit
`octg.tokenizer_stage` events for `tokenizer_init` and `tokenizer_encode`.
Their safe metadata can distinguish initialization cost, encode cost, exact or
conservative estimation, and failure category without recording request
content.

## Preview Verification

Preview keeps the existing Deno-disabled Durable Object smoke separate from the
credential-bearing Deno smoke. The Deno smoke runs only for same-repository
pull requests in the `preview` Environment and uses a dedicated concurrency
group.

The Deno smoke performs two versioned checks beside the current 100% version:

1. An invalid-auth Worker version is routed at 0%. Its Version Override request
   must return HTTP 500 with `error.code` `internal_error`; HTTP 200 would mean
   the Worker silently fell back to the Durable Object tokenizer.
2. A valid-auth Worker version is routed at 0%. Its Version Override request
   must return HTTP 200 with a valid completion and the expected Worker version.

The original 100% version is restored with `wrangler rollback` in an unconditional
cleanup step. Fork pull requests receive secret-free validation only.

## Disable / Roll Back

To disable Deno routing, deploy a Worker configuration in which the Deno four-setting group is absent.

Do not leave a partially configured group as a rollback technique; partial configuration is intentionally invalid.

Disabling Deno returns all accepted inputs to the Cloudflare `TokenizerController` path, so validate Worker resource behavior before sending large traffic.

For the general Worker rollback procedure, see [operations.md](./operations.md).
