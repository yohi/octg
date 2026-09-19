# Free-Tier CPU-Limit Remediation

## Status

- Design approved: 2026-09-20
- Runtime constraint: Cloudflare Workers Free and Deno Deploy Free
- Paid-plan CPU increases: not allowed
- Implementation: pending

## Problem

Large `POST /v1/responses` requests can terminate the Cloudflare Worker with
`exceededCpu` before the request completes. The current production path already
uses Deno `/prepare` for large requests, but the Worker still performs an
unbounded scan of the prepared upstream body in `replaceOutputMarker`.

The Deno service currently parses, normalizes, tokenizes, and serializes the
request with a generated marker in `max_output_tokens`. After quota state is
known, the Worker replaces that marker with the resolved output budget before
calling the upstream gateway. This preserves output clamping, but the marker
can occur near the end of a large body, so the Worker pays CPU proportional to
the complete body size.

Recent production evidence includes four current-version CPU failures with
10-48 ms CPU time and wall time up to approximately 16.8 seconds. Quota RPCs
completed normally. Three failures ended during prepare/upstream setup and one
ended after prepare completed. The failure pattern is consistent with a
remaining Worker-side large-body CPU path, not with D1 or quota authority.

## Goals

- Prevent large Responses requests from requiring Cloudflare paid CPU time.
- Keep Deno Deploy on its Free plan and treat its capacity as bounded.
- Preserve exact token estimation and output-budget clamping.
- Remove any Worker operation whose CPU cost grows with the entire prepared
  body solely to replace the output-budget marker.
- Preserve fail-closed quota behavior and existing public error semantics.
- Keep `MAX_INPUT_BYTES` at 1 MiB unless a later design explicitly changes it.
- Make configuration, deployment ordering, and rollback deterministic.
- Keep the change observable without logging request bodies, prompts, responses,
  client keys, or credentials.

## Non-goals

- Do not upgrade Cloudflare Workers or Deno Deploy to a paid plan.
- Do not use a paid route or a paid fallback when either runtime is unavailable.
- Do not move quota authority from the QuotaController Durable Object.
- Do not make quota decisions depend on D1 writes.
- Do not persist request bodies or tokenizer state in Deno between requests.
- Do not initially change the large-request route for Chat Completions.
- Do not increase the accepted input limit to compensate for a CPU failure.
- Do not silently fall back to the legacy Worker-heavy Responses path.

## Constraints and Invariants

- Cloudflare Workers, Durable Objects, D1, Deno Deploy, client/policy/model
  registry, and reconciliation state remain separated by environment.
- Deno `/prepare` completes before quota reservation.
- A prepare failure never reserves quota, calls upstream, or falls back to the
  Durable Object tokenizer for the prepared route.
- Quota reservation, in-flight admission, release, settlement, uncertainty,
  and reconciliation semantics remain unchanged.
- D1 remains audit-only.
- `MAX_INPUT_BYTES` is resolved from deployment configuration and must match the
  Deno runtime assertion.
- Deno accepts no body above the configured raw and normalized input limits.
- Deno timeouts, network failures, free-tier capacity failures, and malformed
  responses are unavailable outcomes, not fallback signals.
- The prefix preflight owns the prepared-body reader until it returns a
  replacement stream. On preflight rejection, the proxy invokes the resolved
  prepare cancellation exactly once before releasing its reservation and
  in-flight lease.
- After a successful preflight, the returned replacement stream owns reader
  cancellation. Its cancellation is idempotent and is the only cancellation
  callback passed to the prepared-body observer.
- A prepared body stream failure after upstream was attempted uses the existing
  uncertain accounting path.
- The Worker may inspect only a fixed-size prefix of a prepared request body to
  apply the output budget. It must not scan or buffer the remainder for marker
  replacement.
- The Deno prepare contract guarantees that `max_output_tokens` is the first
  JSON property and contains exactly one generated marker. A violation is a
  fail-closed contract error.

## Design

### 1. Deno Prepare Body Layout

Change Deno `/prepare` serialization so the generated `max_output_tokens`
property is always the first JSON property. If the source body already contains
`max_output_tokens`, remove that property before constructing the serialized
body and add the generated marker first. The metadata header continues to carry
the marker and the existing validation fields.

The generated body remains stateless and is still returned as a bounded
response body. Deno does not retain the request body after the HTTP request.

The first bytes must have the following logical shape, with normal JSON
escaping:

```text
{"max_output_tokens":"octg_prepare_[0-9a-f]{32}",...
```

The exact prefix is a protocol contract, not a best-effort optimization.

### 2. Bounded Worker Prefix Preflight

Replace the current whole-body `replaceOutputMarker` path with an asynchronous
prefix preflight that completes before the Worker calls the upstream gateway.
The preflight inspects and marker-matches at most `512` bytes. A stream read can
return a larger runtime chunk; in that case the implementation retains the
chunk's unread suffix as opaque pass-through data and never scans or copies that
suffix. It returns a replacement stream only after all of the following checks
succeed:

1. the body begins with `{"max_output_tokens":`;
2. that first property contains the quoted marker from metadata and is followed
   by a comma;
3. the quoted marker bytes occur exactly once in the complete retained prefix;
4. the first property's `completionOffset`, defined as the exclusive byte count
   through the property and its terminating comma, satisfies
   `completionOffset <= 512`. The 512th byte is therefore successful;
   completion at byte 513 or later is unsuccessful.

The returned stream emits the retained prefix with the complete quoted marker
replaced from its opening quote through its closing quote by the decimal
resolved output budget bytes. The replacement has no JSON quotes, so the
resulting JSON `max_output_tokens` property is a number, not a string. It then
emits any opaque suffix of the final preflight chunk and every later source
chunk unchanged. It never searches, copies, or decodes bytes after the
inspected prefix.

A missing, malformed, duplicate, or too-late marker is a pre-upstream contract
failure. The proxy cancels the resolved prepare request, releases its
reservation and in-flight lease, and returns the existing internal error before
it invokes the upstream transport. A source read failure during preflight uses
the same path.

The `512`-byte limit is a protocol constant. Tests must cover the 511-, 512-,
and 513-byte boundaries, a marker split across chunks, a duplicate marker in
the retained prefix, a tail in the same input chunk, and a tail in a later
chunk. A ready-stream test must parse the emitted body as JSON and assert that
`max_output_tokens` has numeric type and equals the resolved output budget.

### 3. Free-Tier Request Flow

```text
Client
  -> Worker authentication and request admission
  -> Deno /prepare for large Responses
  -> Worker validates bounded metadata
  -> QuotaController get_state and token-budget calculation
  -> QuotaController reserve
  -> Worker bounded prefix preflight and prepared-body validation
  -> upstream gateway with the prepared stream
  -> existing stream settlement / uncertainty handling
```

The Worker still performs authentication, policy/model decisions, quota RPCs,
and upstream stream accounting. Those operations are bounded and do not parse
or scan the complete large request body.

Small Responses requests, Chat Completions, Deno-disabled environments, and
the explicit rollback path retain their existing behavior.

### 4. Free-Tier Capacity Controls

The implementation must keep all of the following bounded:

- `MAX_INPUT_BYTES=1048576` for production;
- Deno `/prepare` raw-body reading and normalized-input validation;
- Deno prepare timeout;
- Worker in-flight admission, currently configured for three requests;
- a prepared-body preflight that inspects at most 512 bytes;
- metadata header size and validation;
- response stream tail inspection for usage accounting.

Deno Free is not treated as an unlimited compute bypass. If its free capacity
is exhausted, a request times out, or the service returns an unavailable
status, OCTG returns the existing internal failure response and preserves
fail-closed accounting. It must not retry through the Worker-heavy legacy route
or reserve quota before a successful prepare.

### 5. Quota and Error Semantics

- Prepare rejected with a validation code: return the existing mapped client
  error; no quota reservation and no upstream call.
- Prepare unavailable or metadata-contract violation before reservation: return
  the existing internal error; no quota reservation and no upstream call.
- Quota rejected after successful prepare: cancel the prepared stream exactly
  once and return the existing quota error.
- Reservation outcome unknown: retain the existing unknown-reservation handling
  and do not assume that upstream usage was zero.
- Prefix-preflight failure after reservation but before upstream attempt: cancel
  the prepared stream exactly once, release the reservation and in-flight lease
  as currently required, then return the internal error.
- A replacement-stream or upstream stream failure after upstream attempt: use
  the existing uncertain path, including Durable Object state and audit
  behavior.

### 6. Deployment and Rollback

Deploy in this order:

1. a `master` push deploys Deno for its immutable commit SHA, even when the
   changed paths are Worker-only;
2. only a successful Deno deployment for that same SHA triggers the Worker
   production workflow, which checks out that SHA rather than the current
   branch tip;
3. the Worker workflow probes `/health` and the first-property `/prepare`
   contract before D1 migration, Worker version upload, or version deployment;
4. canary large Responses traffic with the explicit Responses canary mode and
   inspect CPU, wall time, prepare outcome, upstream outcome, and quota
   accounting;
5. promote only after the canary acceptance gates pass.

The production workflow must continue to validate all Deno and prepare
variables before D1 migration, Worker upload, or Worker deployment. It must
not add a paid-plan check or a paid fallback.

The rollback matrix is mandatory: new Deno with the old Worker must continue
to work through the old marker scanner; old Deno with the new Worker must fail
closed before upstream; and a Worker rollback must restore the legacy route
only after its known version is explicitly deployed. The rollback test must
also prove that the new Worker never re-enables the unbounded marker scan.

## Observability

Retain and use the existing resource-stage events for:

- prepare duration and outcome;
- raw, normalized, text, and opaque input byte counts;
- tokenization provider and failure category;
- quota reservation outcome;
- upstream reached and final outcome;
- request ID and Worker revision ID.

Add a bounded-prefix preflight contract failure category to resource-stage
telemetry. Never include request body bytes, prompt text, response text, API
keys, bearer tokens, or markers in telemetry.

Monitor separately:

- Cloudflare `exceededCpu` count and rate by revision;
- Deno prepare unavailable/timeout rate;
- Deno Free usage and remaining allowance when the platform exposes it;
- prepare-to-upstream latency for representative body-size buckets;
- uncertain reservations and upstream reaches after prepare failures.

The free-tier design accepts bounded availability under exhausted Deno quota;
it does not claim unlimited traffic capacity. The operator must configure and
test a Deno allowance alert when the platform exposes allowance telemetry. When
it does not, the operator must use the documented Deno prepare unavailable-rate
alert as the capacity-exhaustion signal. This external alert configuration is a
promotion prerequisite recorded in the operations runbook, not a repository
secret or a Worker control-plane dependency.

## Verification

### Unit Tests

- Deno serializes `max_output_tokens` as the first property.
- Deno removes a source `max_output_tokens` before adding the marker.
- The Worker replaces a marker split across prefix chunks.
- The Worker rejects duplicate markers in the complete 512-byte prefix.
- The Worker passes a large tail through without reading it for matching,
  including when the tail shares the final preflight chunk.
- A marker absent from the bounded prefix fails closed.
- A malformed first property fails closed.
- Preflight cancellation and replacement-stream cancellation are idempotent.
- Existing token-budget, quota, and uncertainty branches remain unchanged.

### Integration Tests

- Synthetic Responses raw bodies at 778240 bytes and exactly 1048576 bytes.
- Content-Length present, absent, malformed, and over-limit.
- Deno success, validation rejection, timeout, network failure, and 5xx.
- Quota rejection, unknown reservation, in-flight rejection, and upstream
  failure.
- Streaming and non-streaming Responses.
- A preflight failure makes no upstream call and releases the reservation;
  a post-upstream replacement-stream failure retains uncertainty.
- New Deno plus old Worker and old Deno plus new Worker have the required
  rollback behavior.
- The Worker path inspects no more than 512 prepared-body bytes before upstream
  invocation and does not scan the complete body.
- No request payload or credential appears in logs or telemetry.

### Canary Acceptance Gates

- Zero `exceededCpu` failures for representative large Responses traffic.
- No large prepared request enters the legacy Worker-heavy route.
- Deno Free usage remains within the measured account allowance.
- Successful requests settle quota correctly.
- Pre-upstream failures release reservations correctly.
- Post-upstream failures retain uncertainty correctly.
- Rollback and fail-closed behavior are demonstrated before promotion.

## Files Expected to Change During Implementation

- `apps/deno-tokenizer/src/http.ts`
- `apps/gateway-worker/src/prepared-body.ts` with a bounded-prefix transform
- `apps/gateway-worker/src/proxy.ts`
- `apps/gateway-worker/src/prepare-contract.ts`
- `apps/deno-tokenizer/test/http.test.ts`
- `apps/gateway-worker/test/prepared-body.test.ts`
- `apps/gateway-worker/test/proxy-prepare.test.ts`
- `apps/gateway-worker/test/prepare-contract.test.ts`
- `scripts/run-worker-canary.mjs`
- `scripts/run-worker-canary.test.mjs`
- `scripts/canary-worker-resource-limits.mjs`
- `.github/workflows/deploy-deno-tokenizer.yml`
- `.github/workflows/deploy-production.yml`
- `scripts/production-deno-config.mjs` only if the free-tier validation changes
  require it
- `scripts/production-deno-config.test.mjs` only if the free-tier validation
  changes require it
- `scripts/deploy-production-workflow.test.mjs` if deployment ordering or
  preflight assertions change

No implementation is part of this design document.
