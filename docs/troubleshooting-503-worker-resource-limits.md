# 503 / Cloudflare Error 1102 Incident Record

[日本語](./troubleshooting-503-worker-resource-limits.ja.md)

This document preserves the evidence and lessons from the OCTG Worker resource-limit incident observed on 2026-08-16. It is an incident record, not the canonical description of the current request architecture.

For the current architecture and behavior, use [../SPEC.md](../SPEC.md). For the current runbook, use [operations.md](./operations.md).

## Observed Incident

Between 02:16:29 and 02:16:47 JST on 2026-08-16, large `/v1/responses` requests sent through Cloudflare AI Gateway Custom Provider produced a mix of HTTP 200 and HTTP 503 responses.

The successful requests were roughly 74,000 input tokens. The 503 responses were Cloudflare `Worker exceeded resource limits` / Error 1102 HTML rather than OCTG's normal structured OpenAI-compatible error.

That evidence establishes a Worker resource-limit failure, but by itself does not establish whether CPU or memory was the specific limiting resource.

No request payload, authentication material, or tokenizer source text should be added to logs to investigate this class of incident.

## Evidence That Must Be Correlated

For a reproducible diagnosis, collect:

- Worker deployment/version ID;
- commit/revision associated with that deployment;
- effective Worker resource limits;
- Cloudflare invocation outcome;
- CPU time and wall time;
- request concurrency;
- OCTG request ID;
- resource-stage telemetry;
- tokenization provider and measured input bytes;
- whether quota reservation was reached;
- whether upstream execution was reached.

Do not infer the incident deployment's effective limits from current defaults or unrelated plan documentation.

## Current Request Path

The current implementation has evolved since the original incident baseline.

Tokenization is now routed as follows:

```text
authenticate
  -> body read / parse
  -> normalize
  -> model / policy
  -> quota state
  -> tokenization routing
       small or Deno disabled -> TokenizerController DO
       large and Deno enabled -> Deno tokenizer
  -> token budget
  -> quota reserve
  -> in-flight admission
  -> upstream
  -> settle / uncertain / release
```

Therefore, current incident triage must identify the actual tokenization provider instead of assuming every request executed BPE in `TokenizerController`.

## Current Mitigations and Signals

Relevant current controls include:

- bounded request-body size;
- a hard tokenization input ceiling;
- optional Deno offload for large input text;
- per-pool in-flight admission;
- streaming lease renewal;
- request-stage duration telemetry;
- tokenization provider/failure telemetry;
- no upstream call before successful tokenization and quota reservation.

These controls reduce ambiguity but do not prove that a specific 503 was CPU or memory exhaustion.

## Triage Procedure

1. Confirm whether the response is OCTG JSON or Cloudflare HTML.
2. Record the exact timestamp and target hostname.
3. Capture `X-OCTG-Request-Id` and Worker version headers when present.
4. Find the matching Worker invocation and outcome.
5. Correlate body size and tokenization provider.
6. Determine the last completed OCTG resource stage.
7. Check whether a reservation exists for the request ID.
8. If the upstream may have been attempted, preserve fail-closed uncertainty.
9. Compare CPU/wall-time/resource evidence across successful and failed requests on the same version.
10. Reproduce only with synthetic payloads and explicit production-safety limits.

## Quota Safety During a Resource-Limit Incident

A client-visible failure does not prove that upstream usage is zero.

Do not manually release an uncertain reservation solely because the client observed 503/timeout/disconnect.

Use canonical QuotaController state and reconciliation evidence. Reserve-unknown cases require the explicit operator reconciliation path described in [operations.md](./operations.md).

## Acceptance for a Tokenizer-Offload Change

When changing tokenization to reduce Worker resource pressure, validate:

- below-threshold traffic stays on `TokenizerController`;
- at/above-threshold traffic goes to Deno when enabled;
- Deno failure is fail-closed;
- quota reservation still occurs only after successful tokenization;
- representative large synthetic traffic stays within the intended Worker resource envelope;
- no payload or secret is logged;
- success/uncertainty accounting remains correct.

The original 2026-08-16 observations remain historical evidence. They must not be rewritten to imply that Deno routing existed at the time of the incident.
