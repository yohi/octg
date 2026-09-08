# Large Responses CPU-Limit Mitigation

## Status

- Approved architecture: 2026-09-09
- Implementation: pending

## Problem

Large `POST /v1/responses` requests can hit the Cloudflare Workers Free CPU
limit before the existing Deno tokenizer is reached. The current Worker reads
the complete request body, concatenates chunks, decodes UTF-8, parses JSON, and
normalizes the Responses payload before it sends only the derived text to Deno
for BPE counting.

Observed failures are in the approximately 760 KB request class. The Worker
resource events show `body_read`, `parse`, and `normalize` work without a
corresponding tokenization or upstream completion.

## Goals

- Keep `MAX_INPUT_BYTES` at its current 1 MiB value.
- Avoid requiring a paid Cloudflare Workers plan.
- Move large Responses parse, normalization, and exact BPE work out of the
  Worker.
- Preserve fail-closed quota behavior and existing public error semantics.
- Preserve the existing small-input and Durable Object tokenizer paths.
- Make the change measurable and independently rollbackable.

## Non-goals

- Do not introduce a paid fallback path.
- Do not change quota authority from the QuotaController Durable Object.
- Do not persist request bodies or tokenizer state in Deno.
- Do not initially change the large-request route for Chat Completions.
- Do not add request payloads, client keys, or authentication values to logs.

## Invariants

- D1 remains audit-only and never decides quota availability.
- Deno processing occurs before quota reservation.
- A Deno prepare failure never falls back to the Durable Object tokenizer.
- Quota reservation, in-flight admission, release, settlement, and uncertain
  upstream handling remain unchanged.
- `MAX_INPUT_BYTES` applies to both the gateway raw body and normalized input
  bytes.
- The existing `/tokenize` endpoint remains available for the legacy route and
  rollback.

## Design

### Stage 1: Worker Body-Read Optimization

`apps/gateway-worker/src/request-body.ts` will use the runtime-native text body
consumer for requests with a valid, in-bound `Content-Length`, instead of the
JavaScript `chunks` plus `Buffer.concat` path. JSON parsing remains explicit so
body-read and parse timings remain separately observable.

For non-prepared requests without a usable `Content-Length`, the bounded reader
remains in place so the gateway can stop at the configured limit. Malformed
`Content-Length` values keep the current Worker behavior. The implementation
must retain the current 413 response, UTF-8 behavior, invalid-JSON behavior,
and cancellation on an oversize body.

This stage is safe to deploy with prepare routing disabled. It is measured
independently and is not treated as the complete mitigation because JSON parse
and Responses normalization still run in the Worker on this path.

### Stage 2: Deno Prepare

The Deno service will expose an authenticated `POST /prepare` endpoint in
addition to the existing `/tokenize` endpoint. The initial caller is only the
large `/v1/responses` route.

The Worker selects prepare routing before consuming the request body:

- A valid `Content-Length` above the configured prepare threshold uses Deno.
- A request without `Content-Length` uses Deno when prepare is enabled.
- A valid `Content-Length` below the threshold uses the existing Worker path.
- A malformed `Content-Length` uses the existing Worker path.
- A valid `Content-Length` above `MAX_INPUT_BYTES` is rejected by the Worker
  before forwarding.

Deno bounds the `/prepare` raw body at the gateway maximum, parses the JSON,
calls the shared `normalizeResponses` implementation, computes the exact
`o200k_base` count, and serializes the normalized upstream request. The existing
`/tokenize` raw-body bound and contract remain unchanged. Deno returns the
serialized request as the response body, without asking the Worker to parse the
large response.

The Worker uses Deno metadata to perform model classification, policy checks,
quota budgeting, and reservation. It then forwards the prepared body as a
stream to the upstream gateway.

### Configuration

The existing Deno authentication and timeout settings are reused. Prepare
routing adds an optional endpoint and raw-body threshold:

- `DENO_PREPARE_ENDPOINT`
- `DENO_PREPARE_THRESHOLD_BYTES`

Both absent disables prepare routing and leaves current behavior unchanged. A
partial or invalid prepare configuration is a configuration error. Existing
Deno tokenizer configuration remains independently validated.

The prepare endpoint must be HTTPS and must not contain URL credentials. The
shared Deno authentication value remains a secret on both runtime sides.

### Prepare Response Contract

The successful response is `200 application/json` with a bounded,
base64url-encoded `X-OCTG-Prepare-Metadata` header. The decoded JSON object is
versioned and contains exactly these fields:

```json
{
  "version": 1,
  "model": "model-name",
  "inputBytes": 123,
  "inputTextBytes": 123,
  "opaqueInputBytes": 0,
  "messageCount": 1,
  "estimatedInputTokens": 123,
  "estimationPath": "exact_bpe",
  "maxOutputTokens": 123,
  "stream": false,
  "isToolUse": false,
  "outputMarker": "request-specific-marker"
}
```

The Worker validates the metadata version, exact field set, string lengths,
booleans, and safe-integer ranges before using it. The metadata header has a
4 KiB maximum.

The response body is a normalized upstream JSON object. Deno always writes a
single `max_output_tokens` property whose JSON value is the quoted,
request-specific `outputMarker`. Deno regenerates the marker if it appears
elsewhere in the serialized body, so the marker has exactly one occurrence.

After quota budgeting, the Worker attaches a byte `TransformStream` that
replaces exactly the quoted marker with the decimal final output token count.
The stream transform rejects a missing or duplicate marker. The replacement is
performed without `response.json()` or a second large `JSON.stringify()` in the
Worker. `callUpstream` accepts either the existing string/object body or a
`ReadableStream<Uint8Array>`.

### Worker Data Flow

The prepare branch follows this order:

1. Authenticate the client and validate idempotency headers.
2. Apply the raw `Content-Length` size gate when available.
3. Forward the raw body to Deno `/prepare`, or use the existing Worker body
   path for non-prepared requests.
4. Validate Deno metadata and map prepare validation errors to existing OCTG
   errors.
5. Classify the model and load the client policy.
6. Reject disallowed models or tool use before quota reservation.
7. Read quota state and call the existing token budget resolver with Deno's
   exact estimated input token count.
8. Reserve quota and acquire in-flight capacity using the existing Durable
   Object methods.
9. Replace the output marker while forwarding the prepared body to the
   upstream gateway.
10. Run the existing stream settlement or non-stream settlement path.

If the request is rejected before upstream, the Worker cancels the Deno body
stream. If a stream transform or upstream fetch fails after the upstream
attempt begins, the existing uncertain-outcome handling applies.

## Error Handling

The Deno endpoint returns a small JSON error body with one allowed `code` and
no input-derived text. The Worker only accepts the following error codes:

| Deno code | Worker response |
| --- | --- |
| `invalid_body` | `errInvalidRequest` |
| `non_text` | `errNonTextInput` |
| `max_tokens_conflict` | `errMaxTokensConflict` |
| `input_too_large` | `errInputTooLarge` |
| `request_too_large` | `errInputTooLarge` |
| timeout, network, malformed response, or 5xx | `errInternal` |

Authentication failure, unsupported media type, and unknown error responses are
treated as internal prepare failures by the Worker. No Deno failure reserves
quota or calls the upstream gateway.

## Observability

The Worker adds a `prepare` resource stage for the Deno prepare branch. The
finish event includes the raw body size, normalized input sizes, estimation
path, and `tokenizationProvider: "deno"`. Existing `body_read`, `parse`, and
`normalize` stages continue to describe the legacy branch and are not falsely
reported for work performed remotely.

The Deno service reports no request body, marker value, client key, or secret.
Errors remain status-only or use the bounded allowlisted error code.

## Testing

### Worker body reader

- Native in-bound body path.
- Missing and malformed `Content-Length`.
- Exact 1 MiB boundary and oversize cancellation.
- Invalid JSON and invalid UTF-8 behavior.
- Non-ASCII byte accounting.

### Deno prepare service

- Authentication and method/path checks.
- JSON content type and bounded raw body.
- Responses normalization parity with the shared implementation.
- Exact BPE count and estimated input token metadata.
- All normalization error codes.
- Single marker generation and body serialization.
- No input-derived error detail.

### Worker prepare client and stream

- Metadata version and field validation.
- Bounded error response parsing.
- Timeout, network, non-2xx, malformed metadata, and malformed body handling.
- Marker replacement across chunk boundaries.
- Missing and duplicate marker rejection.
- Final output token count remains the value selected after quota budgeting.

### Proxy behavior

- Prepare routing occurs before Worker JSON parsing for large Responses bodies.
- Small Responses and all Chat Completions retain the legacy path.
- Model, policy, tool, quota, reservation, and in-flight failures match current
  semantics.
- Deno failure does not invoke the Durable Object tokenizer.
- Upstream receives normalized Responses JSON with the final output limit.
- Streaming and non-streaming upstream settlement remain correct.

## Rollout and Acceptance

1. Deploy Stage 1 with prepare configuration absent.
2. Run the existing test suite and a sanitized large-body CPU canary.
3. Deploy the Deno service with `/prepare` and verify health/authentication.
4. Enable prepare routing for production with a measured threshold.
5. Run sanitized approximately 74k-token payloads at concurrency 1 and 2.
6. Confirm no Worker `exceededCpu` outcome for the incident payload class.
7. Confirm a `prepare` finish event, successful quota reservation, and correct
   upstream settlement.
8. Roll back by removing prepare configuration; keep `/tokenize` available.

Acceptance requires all of the following:

- `MAX_INPUT_BYTES` remains 1 MiB.
- Large Responses requests no longer fail at Worker CPU limits under the
  operator-defined representative load.
- Small and legacy requests pass existing regression tests.
- No quota decision depends on D1 or Deno state.
- Deno failures fail closed without Durable Object fallback.
- No raw request content or credentials appear in logs or telemetry.

## Files in Scope

- `apps/gateway-worker/src/request-body.ts`
- `apps/gateway-worker/src/proxy.ts`
- `apps/gateway-worker/src/upstream.ts`
- `apps/gateway-worker/src/resource-observation.ts`
- `apps/gateway-worker/src/deno-tokenizer-config.ts`
- `apps/gateway-worker/src/deno-tokenizer-client.ts`
- `apps/gateway-worker/src/tokenization-routing.ts` or a new prepare client
- `apps/deno-tokenizer/src/http.ts`
- `apps/deno-tokenizer/src/config.ts`
- Shared normalization/prepare helpers under `packages/shared/src/`
- Related Worker and Deno tests
- `SPEC.md`, `docs/deno-tokenizer.md`, `docs/configuration.md`, and deployment
  configuration documentation
