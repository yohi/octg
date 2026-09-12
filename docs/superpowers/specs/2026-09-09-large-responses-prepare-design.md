# Large Responses CPU-Limit Mitigation

## Status

- Original prepare architecture approved: 2026-09-09
- Free-tier activation revision approved: 2026-09-12
- Original prepare implementation: complete
- Activation and legacy-route hardening: pending

## Problem

Large `POST /v1/responses` requests can hit the Cloudflare Workers Free CPU
limit before the existing Deno tokenizer is reached. The current Worker reads
the complete request body, concatenates chunks, decodes UTF-8, parses JSON, and
normalizes the Responses payload before it sends only the derived text to Deno
for BPE counting.

Observed failures are in the approximately 760 KB request class. The Worker
resource events show `body_read`, `parse`, and `normalize` work without a
corresponding tokenization or upstream completion. Production has the Deno
tokenizer group configured, but its prepare pair is absent, so the existing
prepare implementation is currently disabled for production Responses
requests.

## Goals

- Keep `MAX_INPUT_BYTES` at its current 1 MiB value.
- Avoid requiring a paid Cloudflare Workers plan.
- Move large Responses parse, normalization, and exact BPE work out of the
  Worker.
- Make the existing Deno `/prepare` route the production path for ordinary
  Responses bodies without requiring a paid Workers plan.
- Preserve fail-closed quota behavior and existing public error semantics.
- Preserve the existing legacy paths for Chat Completions, non-production
  prepare-disabled environments, and rollback.
- Make the change measurable and independently rollbackable.

## Non-goals

- Do not introduce a paid fallback path.
- Do not change quota authority from the QuotaController Durable Object.
- Do not persist request bodies or tokenizer state in Deno.
- Do not initially change the large-request route for Chat Completions.
- Do not add request payloads, client keys, or authentication values to logs.
- Do not migrate the complete gateway, quota control plane, or persistence
  layer to Deno Deploy as part of this change.

## Invariants

- D1 remains audit-only and never decides quota availability.
- Deno processing occurs before quota reservation.
- The transport-neutral prepare metadata and validation-code types are owned by
  `@octg/shared`; neither runtime imports the other runtime's source tree.
- A prepare-resolution failure never falls back to the Durable Object tokenizer,
  reserves quota, or calls the upstream gateway.
- A prepared body stream failure after resolution uses the existing
  `upstreamAttempted` state to select pre-upstream cleanup or the existing
  uncertain semantics.
- Quota reservation, in-flight admission, release, settlement, and uncertain
  upstream handling remain unchanged.
- `MAX_INPUT_BYTES` applies to both the gateway raw body and normalized input
  bytes.
- `MAX_INPUT_BYTES` is resolved once by the deployment configuration and
  propagated as the same decimal value to the Worker binding and Deno runtime.
  Deno startup compares its resolved value with the generated, Deno-only
  `OCTG_EXPECTED_MAX_INPUT_BYTES` assertion from the same source and fails
  closed before serving when either value is missing, invalid, or mismatched.
- Prepare validation error bodies are at most `4096` UTF-8 bytes. The Worker
  reads candidate validation bodies with a bounded reader and cancels an
  oversized response body exactly once before classifying it as unavailable.
- The final prepared `estimatedInputTokens` uses the same
  `estimatedInputTokensOf` formula as the legacy route.
- The Worker never reconstructs the large normalized `inputText` on the
  prepared route and never invokes a second tokenizer for that route.
- The existing `/tokenize` endpoint remains available for the legacy route and
  rollback.
- The free-tier mitigation does not depend on a paid Cloudflare Workers plan.
- In production, a missing or incomplete prepare pair blocks deployment rather
  than silently deploying a Worker that can route large Responses requests
  through the CPU-heavy legacy path.
- In production, the trimmed `DENO_PREPARE_THRESHOLD_BYTES` value is exactly
  `"1"`; any other value is invalid, even when it is a positive safe integer
  within `MAX_INPUT_BYTES`.
- Invalid production Worker configuration causes the `deploy-production`
  workflow to fail before its first remote mutation: D1 migration, Worker
  version upload, or Worker version deployment. The independent Deno
  `/prepare` service prerequisite deployment or verification is outside this
  validation boundary and remains unchanged.

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

The Worker selects prepare routing before consuming the request body. Prepare
selection uses the raw request `Content-Length`, not normalized text bytes:

- A valid `Content-Length` above the configured prepare threshold uses Deno.
- A request without `Content-Length` uses Deno when prepare is enabled.
- A valid `Content-Length` below the threshold uses the existing Worker path.
- A malformed `Content-Length` uses Deno when prepare is enabled; it never
  falls back to Worker-side Responses normalization.
- A valid `Content-Length` above the resolved `MAX_INPUT_BYTES` is rejected by
  the Worker before forwarding, and the incoming request body is canceled.

Production sets `DENO_PREPARE_THRESHOLD_BYTES` to `1`. Consequently, every
ordinary non-empty accepted Responses body is sent to Deno, while only
zero-byte or one-byte declared bodies can remain on the legacy path. Those
bodies fail at the existing invalid-body boundary without performing
large-payload normalization. The prepare client sends canonical headers and
does not forward a malformed original `Content-Length`, so Deno remains the
bounded reader for that case.

Deno receives the canonical `MAX_INPUT_BYTES` value and the generated
`OCTG_EXPECTED_MAX_INPUT_BYTES` assertion through the Deno Deploy runtime
environment. Its startup configuration compares the two before `Deno.serve`; a
missing, invalid, or mismatched value prevents startup. The assertion is not an
independently configurable limit. The `/prepare` raw body is bounded at the
same resolved maximum. It decodes the raw JSON with the same replacement-style
UTF-8 behavior as the legacy Worker body reader, parses the JSON, calls the
shared `normalizeResponses` implementation with that same maximum, computes
the exact `o200k_base` count, applies the existing final token-accounting
formula, calls `normalizeResponsesUpstreamBody`, and serializes the normalized
upstream request once. The existing `/tokenize` raw-body bound, fatal UTF-8
decoder, and contract remain unchanged. Deno returns the serialized request as
the response body, without asking the Worker to parse the large response.

The `/prepare` raw-body reader cancels a present request body stream exactly
once when a declared length exceeds the limit. When oversize is discovered
while reading, it cancels the active reader exactly once before returning
`request_too_large`; reader cleanup must not repeat that cancellation. A
`getReader()` or `reader.read()` rejection remains an internal status-only
failure, while normal end-of-stream, including an empty body, remains a
completed read without oversize cancellation.

The shared helper call is defined as:

```ts
const normalized = normalizeResponses(parsedBody, maxInputBytes);
if (!normalized.ok) return prepareValidationError(normalized.error);

const baseTokenCount = exactEncoder.count(normalized.value.inputText);
const estimatedInputTokens = estimatedInputTokensOf({
  baseTokenCount,
  messageCount: normalized.value.messageCount,
  opaqueInputBytes: normalized.value.opaqueInputBytes,
});
const upstreamBody = normalizeResponsesUpstreamBody(parsedBody);
```

`estimationPath: "exact_bpe"` means that `baseTokenCount` came from the exact
encoder; it does not omit message or opaque-input overhead. The prepared
metadata reports `inputBytes = inputTextBytes + opaqueInputBytes`, and
`maxOutputTokens` is a positive safe integer.

The Worker uses Deno metadata to perform model classification, policy checks,
quota budgeting, and reservation. It then forwards the prepared body as a
stream to the upstream gateway.

### Configuration

The Worker prepare client reuses the existing tokenizer authentication token
and timeout. The Deno service reuses its existing authentication and input-size
settings; no new prepare-specific auth token or timeout is introduced. Prepare
routing adds an optional endpoint and raw-body threshold:

- `DENO_PREPARE_ENDPOINT`
- `DENO_PREPARE_THRESHOLD_BYTES`

The existing tokenizer group remains the four-setting all-or-nothing group:

- `DENO_TOKENIZER_ENDPOINT`;
- `DENO_TOKENIZER_AUTH_TOKEN`;
- `DENO_TOKENIZER_THRESHOLD_BYTES`;
- `DENO_TOKENIZER_TIMEOUT_MS`.

The effective configuration for proxy requests is defined by this truth table:

| Existing tokenizer group | Prepare pair | Chat Completions | Responses |
| --- | --- | --- | --- |
| all absent | both absent | legacy DO tokenizer | legacy DO tokenizer; prepare disabled |
| enabled and valid | both absent | legacy Deno tokenizer behavior | legacy Deno tokenizer behavior; prepare disabled |
| enabled and valid | complete and valid | legacy Deno tokenizer behavior | prepare enabled in addition to legacy behavior |
| partial or invalid | any | existing tokenizer configuration error | existing tokenizer configuration error |
| all absent | complete or partial/invalid | legacy DO tokenizer behavior | prepare configuration error |
| enabled and valid | partial or invalid | legacy Deno tokenizer behavior | prepare configuration error |

The final two rows make prepare-only invalidity fail closed for Responses while
preserving the Chat Completions non-goal. A complete prepare pair is valid only
when the existing tokenizer group supplies the shared auth token and timeout.
`DENO_PREPARE_THRESHOLD_BYTES` is a positive safe integer no greater than the
resolved `MAX_INPUT_BYTES`. An invalid prepare pair affects all Responses
requests, including requests that would otherwise be below the prepare
threshold; it never changes Chat configuration semantics.

The truth table defines runtime resolver semantics for non-production and
rollback environments. Production applies the following stricter deployment
contract before the Worker version is uploaded:

- The prepare pair is mandatory. Missing, empty, partial, or otherwise invalid
  values are configuration errors.
- After trimming surrounding whitespace, `DENO_PREPARE_THRESHOLD_BYTES` must be
  exactly the canonical string `"1"`. Leading-zero, decimal, exponent, and
  other numeric representations such as `"01"`, `"1.0"`, and `"1e0"` are
  rejected.
- Invalid production Worker configuration causes the `deploy-production`
  workflow to fail before its first remote mutation: D1 migration, Worker
  version upload, or Worker version deployment. The independent Deno
  `/prepare` service prerequisite deployment or verification is outside this
  validation boundary and remains unchanged.
- The complete production pair is passed explicitly to the Worker upload; it
  is never omitted to represent the disabled state.

The prepare endpoint must be HTTPS and must not contain URL credentials. The
shared Deno authentication value remains a secret on both runtime sides.

For non-production environments, the prepare pair remains optional so the
existing local and rollback paths can be exercised. Production is stricter:
`validateProductionDenoConfig` requires
`DENO_PREPARE_ENDPOINT` and `DENO_PREPARE_THRESHOLD_BYTES`, validates them as
a complete pair, and the workflow passes them explicitly to every production
Worker upload. The checked-in Wrangler file remains free of production secret
and environment-specific prepare values.

`MAX_INPUT_BYTES` is not independently selected by the Worker and Deno
services. Production deployment resolves one positive safe-integer value and
writes it to the Worker `MAX_INPUT_BYTES` binding and the Deno runtime
environment. Preview uses its isolated `OCTG_PREVIEW_MAX_INPUT_BYTES` source
and applies the same mapping only within the Preview control plane. The Deno
deployment writes `OCTG_EXPECTED_MAX_INPUT_BYTES` from that same source and
does not expose it as an independent operator setting. `resolveServiceConfig`
fails closed before `Deno.serve` if the runtime value and assertion do not
resolve to the same value. The assertion is configuration metadata, never
request data or telemetry.

### Prepare Response Contract

The transport-neutral protocol types live in
`packages/shared/src/prepare.ts` and are exported from
`packages/shared/src/index.ts`. The Deno deployment already includes
`packages/shared/src/**`, so the Deno service consumes the same source as the
Worker without importing any Worker module. Worker-specific base64url decoding
and runtime validation remain in
`apps/gateway-worker/src/prepare-contract.ts`; the marker transform remains
Worker-specific.

The successful response is `200 application/json` with a bounded,
base64url-encoded `X-OCTG-Prepare-Metadata` header. The header value is at most
4096 ASCII bytes. The decoded JSON object is versioned and contains exactly
these fields:

```json
{
  "version": 1,
  "model": "model-name",
  "rawBodyBytes": 123,
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

The shared TypeScript shape is:

```ts
export interface PrepareMetadata {
  readonly version: 1;
  readonly model: string;
  readonly rawBodyBytes: number;
  readonly inputBytes: number;
  readonly inputTextBytes: number;
  readonly opaqueInputBytes: number;
  readonly messageCount: number;
  readonly estimatedInputTokens: number;
  readonly estimationPath: "exact_bpe";
  readonly maxOutputTokens: number;
  readonly stream: boolean;
  readonly isToolUse: boolean;
  readonly outputMarker: string;
}
```

`PrepareMetadata` has an exact field set. `version` is exactly `1`.
`rawBodyBytes`, `inputBytes`, `inputTextBytes`, `opaqueInputBytes`,
`messageCount`, and `estimatedInputTokens` are non-negative safe integers.
`maxOutputTokens` is a positive safe integer. The semantic constraints are:

- `rawBodyBytes` is the number of raw request bytes actually read by Deno and
  is no greater than the resolved `MAX_INPUT_BYTES`;
- `inputBytes = inputTextBytes + opaqueInputBytes` and `inputBytes` is no
  greater than the resolved `MAX_INPUT_BYTES`;
- `inputTextBytes` and `opaqueInputBytes` are no greater than `inputBytes`;
- `messageCount` is the count produced by `normalizeResponses`, including zero
  for an accepted empty input array;
- `estimatedInputTokens` is the result of `estimatedInputTokensOf` using the
  exact BPE base count, `messageCount`, and `opaqueInputBytes`;
- `stream` and `isToolUse` are booleans;
- `model` remains subject only to the existing non-empty string contract; no
  new public model-length restriction is introduced;
- `outputMarker` is the ASCII string `octg_prepare_` followed by 32 lowercase
  hexadecimal characters generated solely from 128 bits of cryptographically
  random data; it contains no input-derived text.

If the encoded metadata value cannot fit within 4096 bytes, Deno returns an
internal prepare failure rather than inventing a model validation rule. The
Worker treats that response as an internal prepare failure. This is the explicit
transport decision for unusually long model strings.

The Worker validates the metadata version, exact field set, the non-empty
`model` string, the exact `outputMarker` format, booleans, safe-integer ranges,
and the semantic relationships above before using it. A malformed or oversized
metadata header is never accepted.

Success validation has two separate phases:

1. **Prepare-resolution validation:** Before returning `PrepareOutcome.resolved`,
   the Worker checks only facts available without consuming the response body:
   the status is exactly `200`, the response `Content-Type` is the expected
   `application/json` media type, the metadata header is present and no more
   than 4096 ASCII bytes, the decoded metadata passes all validation above, and
   `response.body` is not `null`. Any failure is
   `unavailable: malformed_response`; no quota is reserved and no upstream call
   is made.
2. **Resolved-body stream validation:** After resolution, the Worker owns the
   response body as a stream and does not call `response.text()` or
   `response.json()` to validate or buffer it. The marker transform and stream
   observer validate only the stream invariants that can be observed while the
   body is consumed: exactly one quoted marker, normal close, and read/error
   termination. Missing or duplicate markers, EOF-only truncation, and body
   read failures are resolved-body failures, not new `PrepareOutcome.unavailable`
   results. Their cleanup phase is selected from the existing
   `upstreamAttempted` state.

The response body is a single-pass normalized upstream JSON stream. Deno always
writes a single `max_output_tokens` property whose JSON value is the quoted,
request-specific `outputMarker`. Deno regenerates the marker if it appears
elsewhere in the serialized body, so the serialized body contains exactly one
occurrence of the quoted marker. Marker generation is bounded to 16 attempts;
failure to obtain a collision-free marker is an internal prepare failure.

HTTP status is classified before an error body is considered. Only `200` can
produce a successful response. A successful `200` is resolved after the
header-level checks above; the body is not parsed in the Worker. Normal Deno
behavior never emits a `200` error envelope. If a body stream violates the
marker or stream invariants after resolution, it follows the resolved-body
failure path rather than being converted to `unavailable` by buffering it.
Only the exact validation status/code combinations defined in `Error Handling`
can produce `rejected`; an allowlisted code on an authentication, media-type,
server-error, or other status never changes that status classification.

After quota budgeting, the Worker attaches a byte `TransformStream` that
replaces exactly the quoted marker with the decimal final output token count.
The stream transform rejects a missing or duplicate marker. The replacement is
performed without `response.json()` or a second large `JSON.stringify()` in the
Worker. `callUpstream` accepts either the existing string/object body or a
`ReadableStream<Uint8Array>`. The replacement bytes are the UTF-8 bytes of
`JSON.stringify(outputMarker)` and the decimal token count is emitted as JSON
number bytes.

Validation failures from Deno use a bounded JSON error envelope with exactly
one allowlisted code:

```ts
export type PrepareErrorCode =
  | "invalid_body"
  | "non_text"
  | "max_tokens_conflict"
  | "input_too_large"
  | "request_too_large";

export interface PrepareErrorBody {
  readonly code: PrepareErrorCode;
}
```

`request_too_large` is mandatory for raw-body limit rejection, whether the
limit is detected from `Content-Length` or while reading. The fixed validation
status/code matrix is:

| HTTP status | Response contract | Worker outcome |
| --- | --- | --- |
| `400` | `invalid_body`, `non_text`, or `max_tokens_conflict` | `rejected` |
| `413` | `input_too_large` or `request_too_large` | `rejected` |
| `200` | Expected success media type, valid metadata, and non-null body | `resolved` |
| `200` | Missing/wrong success media type, malformed/oversized metadata, or null body | `unavailable: malformed_response` |
| `500` | Internal prepare failure with no validation envelope | `unavailable` |
| Any other status, including `401`, `415`, and all other `5xx` | Any body, including an allowlisted-looking code | `unavailable` |

Only the first two rows are validation responses. The Worker classifies the
status before inspecting a body. For `400` and `413`, the body must have the
expected `application/json` media type and be read through a bounded reader
with a fixed `4096` UTF-8-byte limit. It must parse as a JSON object with
exactly one `code` field, and the code must match the status row. A reader
rejection, invalid JSON, wrong/unknown code, wrong content type, or measured
oversize is `unavailable: malformed_response`; measured oversize invokes the
active response reader's `cancel()` exactly once before returning. For `500`
and every other non-`200` status, the Worker does not parse an
allowlisted-looking body and classifies the result as `unavailable` by status
after best-effort body cleanup. A `2xx` status other than `200`, an unknown
code, malformed error body, or an oversized error body is unavailable. Error
bodies never contain input-derived text. Raw-body `request_too_large` continues
to use Deno HTTP `413`; normalized `input_too_large` also uses `413` so the
status/code combination is fixed rather than implementation-defined. A `200`
error envelope is not a valid Deno success response, but the Worker does not
parse a resolved body to discover one; the normal Deno implementation never
produces it, and any observable stream/marker violation follows the
resolved-body failure contract above.

`invalid_body` is reserved for a request whose raw body was read to completion
but whose JSON or normalized Responses shape is invalid. If `getReader()` or
`reader.read()` rejects before the raw body is read to completion, Deno returns
HTTP `500` with no `PrepareErrorBody` and no validation code. The Worker
classifies that response by status first as `unavailable` and returns
`errInternal`; it never upgrades the transport failure to a public validation
error. An empty body that reaches normal end-of-stream is a completed read and
therefore follows the `invalid_body` JSON parsing path.

The Worker client returns three variants and preserves the response-body
ownership on success. `unavailable: malformed_response` applies only to
resolution-time status, success media type, metadata, or null-body failures;
it is not used for a body-stream failure after `resolved` has been returned:

```ts
type PrepareOutcome =
  | {
      readonly kind: "resolved";
      readonly metadata: PrepareMetadata;
      readonly body: ReadableStream<Uint8Array>;
      readonly cancel: () => Promise<void>;
    }
  | { readonly kind: "rejected"; readonly code: PrepareErrorCode }
  | {
      readonly kind: "unavailable";
      readonly failure: "timeout" | "network" | "upstream_status" | "malformed_response";
    };
```

`cancel` is idempotent and aborts the underlying Deno request and response
body. `DENO_TOKENIZER_TIMEOUT_MS` is one deadline beginning at `/prepare`
dispatch and ending only when the prepared response body closes or is canceled;
the timer is not cleared merely because response headers were received. A
timeout before resolution produces `unavailable: timeout`; a timeout after
resolution is a resolved-body failure and uses the same pre/post-upstream
cleanup classification as any other body terminal event.

### Worker Data Flow

The prepare branch follows this order:

1. Authenticate the client and validate idempotency headers.
2. Resolve the existing four-setting tokenizer group and the prepare pair using
   the configuration truth table. A Responses configuration error returns
   before body dispatch; a Chat-only prepare error is ignored.
3. Apply the raw `Content-Length` size gate when available. A declared raw size
   above the resolved maximum cancels the incoming request body and returns
   `errInputTooLarge` without a Deno call.
4. Dispatch the raw body to Deno `/prepare`, or use the existing Worker body
   path only for requests below the configured threshold or when prepare is
   disabled outside production. A malformed `Content-Length` does not select
   the legacy path when prepare is enabled.
5. Parse the three-variant prepare outcome. A `rejected` code maps to the
   existing public OCTG error; an `unavailable` outcome maps to
   `errInternal`. Neither outcome invokes the Durable Object tokenizer.
6. For a resolved outcome, retain `metadata`, `body`, and `cancel` as one
   prepared-body ownership record. Classify `metadata.model` and load the
   client policy.
7. Reject disallowed models or tool use before quota reservation. Every
   terminal path before upstream ownership transfer calls `cancel`.
8. Read quota state and call `resolveTokenBudget` exactly once with
   `metadata.estimatedInputTokens` and `metadata.maxOutputTokens`. The Worker
   does not add message or opaque-input overhead again.
9. Reserve quota and acquire in-flight capacity using the existing Durable
   Object methods. Reservation rejection, unknown reservation, exceptions, and
   in-flight rejection all cancel the prepared body before returning.
10. Attach the marker transform and pass the resulting stream to `callUpstream`.
    Ownership transfers only at this call. Stream setup failure and
    `UpstreamConfigError` before the upstream transport wrapper runs cancel the
    body, release the in-flight lease when acquired, release the resolved
    reservation when present, and use the existing pre-upstream error path.
    Once the transport wrapper runs, marker-transform, body-read, and transport
    failures are post-attempt failures even if the upstream response has not
    yet been received.
11. Run the existing stream settlement or non-stream settlement path. A body or
    transport failure after the upstream attempt begins marks the request
    uncertain and releases only the in-flight lease, as in the existing path.

The two failure phases are explicit:

1. **Prepare-resolution failure:** `prepareWithDeno` has not returned
   `resolved`; only status, success media type, metadata, and null-body checks
   can classify a `200` response at this point. There is no quota reservation,
   upstream call, or Durable Object tokenizer fallback.
2. **Resolved prepared-body failure:** ownership has been returned to the
   proxy. Before the transport wrapper runs, cancel and release known state.
   After the transport wrapper runs, use existing uncertain semantics. The
   statement that no Deno failure reserves quota or calls upstream applies only
   to phase 1.

## Error Handling

Validation failures from the Deno endpoint return a small JSON error body with
one allowed `code` and no input-derived text. The serialized UTF-8 body must
not exceed `4096` bytes. Internal and raw-body transport failures are
status-only and do not carry a `PrepareErrorBody`. The Worker only accepts the
following validation error codes. Resolution-time malformed responses mean
invalid status, success media type, metadata, null-body, or bounded error-body
conditions; a body-stream failure after resolution is not mapped through this
table:

| Prepare failure or Deno code | Worker response |
| --- | --- |
| `invalid_body` | `errInvalidRequest` |
| `non_text` | `errNonTextInput` |
| `max_tokens_conflict` | `errMaxTokensConflict` |
| `input_too_large` | `errInputTooLarge` |
| `request_too_large` | `errInputTooLarge` |
| status-only internal prepare failure (`500`, including raw-body read failure, with no validation envelope) | `errInternal` |
| timeout, network, resolution-time malformed response, other `5xx`, auth failure, unsupported media type, unknown code, or malformed/oversized error body | `errInternal` |

The public `errInputTooLarge` response uses the existing OCTG
`request_too_large` code for both normalized-input and raw-body limits. The
prepare protocol still distinguishes `input_too_large` from
`request_too_large` so the Worker can identify which validation boundary
failed. No prepare-resolution failure reserves quota or calls the upstream
gateway. A raw-body read failure is a prepare-resolution failure, not an
`invalid_body` validation result. The existing `/tokenize` endpoint and its
error mapping are unchanged. A resolved-body read, timeout, marker, or other
stream-integrity failure is classified by whether the existing
`upstreamAttempted` flag is false or true: known state is released only in the
former case, and the latter uses `markUncertain` without releasing the
reservation as known-unused.

Production configuration errors are evaluated outside the request path by the
deployment validator. Missing, empty, partial, invalid, or non-canonical
prepare values, including any trimmed threshold other than `"1"`, cause the
`deploy-production` workflow to stop before its first remote mutation: D1
migration, Worker upload, or Worker deployment. The independent Deno
`/prepare` service prerequisite deployment or verification is outside this
validation boundary and remains unchanged. This strict production rule does
not change the non-production runtime truth table: both prepare values absent
remains disabled, and a complete non-production pair may use any positive safe
integer threshold no greater than `MAX_INPUT_BYTES`.

## Observability

The Worker adds a `prepare` resource stage for the Deno prepare branch. The
finish event for a resolved outcome includes `rawBodyBytes`, normalized input
sizes, estimation path, and `tokenizationProvider: "deno"`. A rejected or
unavailable outcome includes only safe route, failure, and upstream-attempt
fields; raw size is included only when it came from validated prepare metadata.
Existing `body_read`, `parse`, and `normalize` stages continue to describe the
legacy branch and are not falsely reported for work performed remotely.

The prepare stage remains open until the prepared body closes or is canceled,
so its timeout and stream-failure telemetry covers the entire prepared-body
ownership period. It records no body content, marker, client key, auth token, or
other secret.

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
- A request-body reader rejection returns HTTP `500` with no validation code;
  it is distinct from a complete body followed by invalid JSON.
- Declared raw-body oversize cancels the request body stream exactly once, and
  measured raw-body oversize cancels the active reader exactly once; normal
  end-of-stream, including an empty body, does not take the oversize path.
- Replacement-style UTF-8 decode parity with the legacy Worker reader.
- Responses normalization parity with the shared implementation.
- One resolved `MAX_INPUT_BYTES` value bounds both `/prepare` raw-body reads and
  the `normalizeResponses` input-size check; startup rejects a missing,
  invalid, or mismatched Worker/Deno value before serving.
- Exact BPE count and final estimated input token metadata using
  `estimatedInputTokensOf`.
- All five allowlisted protocol error-code mappings, including
  `max_tokens_conflict` at the Worker protocol boundary.
- Raw-body oversize from both declared and measured limits returns
  `request_too_large`.
- `rawBodyBytes` for absent `Content-Length` and non-ASCII raw JSON byte counts.
- Generic `text` normalization to `input_text` for user/system/developer and
  `function_call_output`, and to `output_text` for assistant content.
- Single marker generation, collision regeneration, and the exactly-one
  quoted-marker invariant.
- Single final upstream-body serialization.
- No input-derived error detail.

### Worker prepare client and stream

- Metadata version and field validation.
- Bounded error response parsing with a fixed `4096`-byte limit.
- Error-body reader rejection, malformed JSON/shape/code, wrong media type, and
  measured oversize classify as `unavailable: malformed_response`; measured
  oversize cancels the active response reader exactly once.
- HTTP status/body precedence matrix, including `500` plus an allowlisted code,
  `500` with no body from a Deno body-read failure, `401` plus an allowlisted
  code, `415` plus an allowlisted code, valid `400` and `413` validation
  envelopes, and unknown status/code combinations.
- All three `PrepareOutcome` variants and all five allowlisted error codes.
- Successful `200` resolution checks the expected success media type, bounded
  metadata, and non-null body without reading the body; missing or wrong
  `Content-Type`, invalid/oversized metadata, and null body are
  `unavailable: malformed_response`.
- Timeout deadline through body close/cancel, network, non-2xx, malformed
  metadata, oversized metadata header, and resolution-time malformed response
  handling.
- A resolved-body `reader.read()` rejection invokes `cancelSource()` and the
  active reader's `cancel()` exactly once before `notify("error")`, reader
  release, and `controller.error()`; a later stream cancellation does not
  repeat either operation.
- Marker replacement across chunk boundaries.
- Missing and duplicate marker rejection after resolution, including EOF-only
  missing-marker detection and body read failure during consumption.
- Final output token count remains the value selected after quota budgeting.

### Production configuration validation

- A complete production tokenizer group plus a complete prepare pair with the
  trimmed threshold string `"1"` is accepted.
- Missing, empty, partial, invalid, or non-canonical production prepare values
  are rejected. This includes `"0"`, `"01"`, `"1.0"`, `"1e0"`, and every
  positive threshold other than `"1"`, including `"700000"`.
- A production Worker configuration validation failure causes
  `deploy-production` to stop before its first remote mutation: D1 migration,
  Worker version upload, or Worker version deployment. The independent Deno
  prerequisite deployment remains outside this guarantee and unchanged.
- Non-production configuration tests continue to prove that both prepare
  values absent disables prepare and that a complete valid pair may use any
  positive safe-integer threshold no greater than `MAX_INPUT_BYTES`.

### Proxy behavior

- Prepare routing occurs before Worker JSON parsing for large Responses bodies.
- With the production threshold of `1`, accepted non-empty Responses bodies
  route to prepare even when `Content-Length` is malformed.
- Small Responses retain the legacy path when prepare is disabled or a
  non-production threshold explicitly leaves them there. All Chat Completions
  retain the legacy path.
- Model, policy, tool, quota, reservation, and in-flight failures match current
  semantics.
- Deno failure does not invoke the Durable Object tokenizer.
- Deno body-read internal failure maps to `errInternal` without invoking
  `routeTokenization`, quota reservation, or upstream transport.
- Upstream receives normalized Responses JSON with the final output limit.
- Prepared and legacy routes produce the same final estimated input tokens for
  the same accepted normalized request, including message and opaque-input
  overhead.
- Every pre-upstream terminal path cancels a resolved prepared body.
- A resolved prepare body finishes its resource stage exactly once on normal
  close, read error, timeout, or cancellation, including races between an
  explicit cancel and a stream terminal callback.
- Prepared body failure before upstream releases known state; failure after an
  upstream attempt uses uncertain semantics.
- Missing or duplicate markers and EOF-only body failures are resolved-body
  failures; they are classified by the existing upstream-attempt state rather
  than by the prepare-resolution error mapping.
- Streaming and non-streaming upstream settlement remain correct.

## Rollout and Acceptance

1. As an independent prerequisite, deploy or verify the Deno service with
   `/prepare`, then verify health and authentication without exposing the
   shared auth value. This operation belongs to the independent
   `.github/workflows/deploy-deno-tokenizer.yml` workflow and is outside the
   `deploy-production` Worker configuration validation boundary; that Deno
   workflow remains unchanged.
2. Set the complete production pair in the `deno-production` GitHub
   Environment: `DENO_PREPARE_ENDPOINT` to the production `/prepare` URL and
   `DENO_PREPARE_THRESHOLD_BYTES` to `1`.
3. Require the production configuration validator and Worker upload step to
   reject an absent, partial, empty, invalid, or non-canonical prepare pair,
   including every threshold other than the trimmed string `"1"`. The
   `deploy-production` validation must finish before its first remote mutation:
   D1 migration, Worker upload, or Worker deployment. Never pass an empty
   `--var` as a disabled placeholder.
4. Run the existing test suite and a sanitized large-body CPU canary in the
   isolated Preview control plane.
5. Run sanitized approximately 74k-token payloads at concurrency 1 and 2.
6. Confirm no Worker `exceededCpu` outcome for the incident payload class.
7. Confirm a `prepare` finish event, successful quota reservation, and correct
   upstream settlement.
8. Roll back to a known Worker version that predates prepare when required.
   Omitting prepare variables from a later `--keep-vars` upload is not a
   rollback because remote variables persist.

Rollback verification uses the same synthetic Responses payload that routed to
prepare before rollback. After the version rollback, verify that:

- no `prepare` resource stage is emitted;
- legacy `body_read`, `parse`, and `normalize` stages are emitted;
- the existing `/tokenize` route remains available;
- tokenization provider behavior follows the retained
  `DENO_TOKENIZER_THRESHOLD_BYTES` setting and is not assumed to be the DO;
- quota reservation and upstream settlement remain correct.

Production and Preview mappings are explicit. Production deployment resolves
one canonical `MAX_INPUT_BYTES` value and maps it to both the Worker binding
and the Deno runtime environment; it also passes generated
`OCTG_EXPECTED_MAX_INPUT_BYTES` to Deno startup. Production
`DENO_PREPARE_ENDPOINT` and
`DENO_PREPARE_THRESHOLD_BYTES` map directly to the same Worker bindings.
Preview uses isolated input-limit and prepare values in three distinct layers:

| Layer | Prepare endpoint | Prepare threshold |
| --- | --- | --- |
| `.env` / GitHub Environment variable | `DENO_PREVIEW_PREPARE_ENDPOINT` | `DENO_PREVIEW_PREPARE_THRESHOLD_BYTES` |
| Workflow / process environment | `PREVIEW_DENO_PREPARE_ENDPOINT` | `PREVIEW_DENO_PREPARE_THRESHOLD_BYTES` |
| Generated Worker binding | `DENO_PREPARE_ENDPOINT` | `DENO_PREPARE_THRESHOLD_BYTES` |

| Layer | Shared input limit |
| --- | --- |
| Preview `.env` / GitHub Environment variable | `OCTG_PREVIEW_MAX_INPUT_BYTES` |
| Preview workflow / process environment | `PREVIEW_MAX_INPUT_BYTES` |
| Preview generated Worker binding and isolated Deno runtime | `MAX_INPUT_BYTES` |

The deployment tests must prove that the generated Worker binding, Deno
runtime value, and `OCTG_EXPECTED_MAX_INPUT_BYTES` are identical within each
control plane. A mismatch fails before the runtime serves traffic.

`setup-preview.zsh` reads and publishes the first-layer
`OCTG_PREVIEW_MAX_INPUT_BYTES` and `DENO_PREVIEW_*`
names. `preview-smoke.yml` maps those values into the second-layer
`PREVIEW_MAX_INPUT_BYTES` and `PREVIEW_DENO_*` names, and
`preview-worker-config.mjs` writes the final Worker binding while the Deno
Deploy setup receives the same limit plus generated
`OCTG_EXPECTED_MAX_INPUT_BYTES`. These names are not interchangeable.

The checked-in `apps/gateway-worker/wrangler.jsonc` remains without optional
prepare variables. Disabled-by-default is represented by variable absence, not
empty-string placeholders. The existing Deno deployment manifest and staging
workflow already include `apps/deno-tokenizer/src/**` and
`packages/shared/src/**`; they require verification but no new source-tree
dependency. The independent `.github/workflows/deploy-deno-tokenizer.yml`
workflow is outside the `deploy-production` validation boundary and remains
unchanged.

Acceptance requires all of the following:

- `MAX_INPUT_BYTES` remains 1 MiB.
- Production cannot deploy without a complete valid prepare pair and uses
  the canonical trimmed threshold string `"1"`; numeric alternatives such as
  `"01"`, `"1.0"`, and `"1e0"` are invalid.
- Production configuration validation fails within `deploy-production` before
  its first remote mutation: D1 migration, Worker upload, or Worker
  deployment. It performs no remote mutation in that workflow when invalid;
  the independent Deno prerequisite deployment is outside this guarantee.
- Production and Preview deployment checks propagate one control-plane-local
  input-limit value to both Worker and Deno, and Deno startup fails closed on a
  missing, invalid, or mismatched value.
- Large Responses requests no longer fail at Worker CPU limits under the
  operator-defined representative load.
- Small and legacy requests pass existing regression tests.
- No quota decision depends on D1 or Deno state.
- Deno failures fail closed without Durable Object fallback.
- No raw request content or credentials appear in logs or telemetry.

## Files in Scope

The original prepare implementation is already present in the repository. The
following are the activation and legacy-route hardening targets for this
revision:

- `apps/gateway-worker/src/proxy.ts`
- `.github/workflows/deploy-production.yml`
- `scripts/production-deno-config.mjs`
- `scripts/production-deno-config.test.mjs`
- `scripts/deploy-production-workflow.test.mjs`
- `apps/gateway-worker/test/proxy-prepare.test.ts`
- `SPEC.md` (`§9.4`, `§17`, and `§18`)
- `docs/configuration.md`
- `docs/deno-tokenizer.md`
- `docs/operations.md`

The implementation must synchronize the public documentation in the same
change. `SPEC.md §9.4` must define the production/non-production prepare
semantics and the exact threshold rule. `SPEC.md §17` must define the
production mandatory-pair, threshold, and pre-mutation validation invariants.
`SPEC.md §18` must define activation verification and rollback requirements.
`docs/configuration.md` must distinguish the production-required pair from the
non-production optional pair. `docs/deno-tokenizer.md` must document the
production threshold and routing boundary. `docs/operations.md` must document
the mandatory production activation, validation-before-mutation rule, canary,
monitoring, and rollback procedure.

`apps/gateway-worker/wrangler.jsonc` and `deno.json` are read-only verification
references for this revision. The existing Deno deployment workflow, source
staging, shared input-limit propagation, startup assertion, and secret
isolation must remain unchanged.
