# Roadmap

This document is the canonical record of work that is outside the current
Phase 1 contract. Current behavior is defined by [SPEC.md](../SPEC.md). A
roadmap item does not change the current behavior until its design, tests,
implementation, and the specification are updated together.

## Statuses

- **Planned**: an accepted direction that still needs implementation.
- **Candidate**: a possible direction that still needs product or architecture
  decisions.
- **Completed**: a recently completed migration retained here for traceability.

## Current Boundary

Phase 1 is complimentary-only. There is no paid upstream route, paid fallback,
or provider fallback. The following remain hard requirements for future work:

- QuotaController remains the authoritative live quota decision point.
- Upstream execution requires a successful reservation and in-flight admission.
- Actual usage settles a reservation; uncertain outcomes consume capacity until
  explicitly reconciled.
- Paid or private routing must be explicit client opt-in and must not be an
  emergency bypass.
- Production and Preview control planes, credentials, and persistent state stay
  separate.
- Request content, credentials, and raw client keys are not added to logs or
  persistent audit state.

## Planned

### Operator and Product Surface

- Add usage graphs and alerting for pool utilization, rejected requests,
  uncertain tokens, reconciliation differences, and provider failures.
- Add richer client management, model-registry editing, and fallback-policy
  editing to the Admin surface.
- Add per-agent or per-client budgets with explicit daily paid limits.
- Add cost-aware routing that can consider quality, cost, remaining quota,
  privacy, latency, availability, and task type.

### API and Provider Expansion

- Add `/v1/embeddings`, `/v1/audio/*`, and `/v1/images/*` only after each
  endpoint has an explicit normalization, eligibility, token-accounting, and
  privacy contract.
- Add Workers AI, Anthropic, and Gemini routes as separately governed provider
  integrations.
- Add a dynamic-routing layer for explicitly permitted overflow traffic. It
  must not replace the Durable Object quota decision.
- Evaluate a universal multi-provider gateway only after provider-specific
  accounting, privacy, and failure semantics are defined.

### Quota and Tokenization

- Optimize tokenization by model where the model's accounting contract is
  known.
- Add TokenizerController sharding only when measured serialization pressure
  justifies it; object identity and quota authority must remain separate.
- Evaluate tokenizer-result, prompt-hash, and D1 token caches with tenant
  isolation, privacy, invalidation, and idempotency rules.
- Revisit the token upper-bound algorithm against OpenAI actual usage. A new
  algorithm must preserve conservative admission and be validated with
  adversarial inputs before adoption.
- Evaluate AI Gateway Spend Limits as a secondary guard only. They must not
  become the authoritative complimentary quota counter.

### Reconciliation and Performance

- Extend reconciliation to support richer history and controlled processing of
  older unresolved rows without weakening the explicit reserve-unknown path.
- Measure and, if still appropriate, adopt a Worker-plus-Durable-Object
  overhead target of p50 below 50 ms and p95 below 150 ms, excluding provider
  latency.
- Apply non-default input-size limits consistently to every tokenizer runtime
  and add an automated cross-runtime resolved-limit check.

### Paid and Private Routing

- Evaluate `PAID_SHARED` and `PAID_PRIVATE` routes only with explicit opt-in,
  per-client budgets, OpenAI project separation, privacy classification,
  reconciliation, and an independently tested failure policy.
- If paid or private routing is introduced, use separate OpenAI Projects for
  complimentary shared traffic and non-shared traffic. Data Sharing settings,
  project credentials, and route classification must remain explicit.
- Evaluate AI Gateway custom-cost metadata for cost visibility and virtual token
  metering. It must remain an observability aid and never become the quota
  authority.
- Evaluate a Workers Paid migration only after the cost model and fail-closed
  behavior are documented. It is not required by the current system.

## Candidates

These items require a decision before becoming planned work:

- Additional complimentary pool types or changes to the OpenAI program
  eligibility model.
- Cache policy improvements beyond the current client-level opt-in.
- A broader OpenAI-compatible surface beyond the currently supported text
  endpoints.
- Cross-provider fallback for availability or cost optimization.

## Completed Migrations

The following work was previously captured in design and implementation
records and is now represented by the executable configuration and canonical
documents:

- Exact large-input tokenization can be offloaded to the optional Deno
  tokenizer while preserving the Cloudflare TokenizerController path.
- Deno Deploy uses a repository-root manifest and staged source containing the
  tokenizer and its shared arithmetic dependency.
- Production and Preview Deno applications, Worker settings, authentication
  values, and control-plane resources are separated.
- Production and Preview workflows validate their own configuration and use
  secret-safe versioned deployment and rollback procedures.
- Configuration ownership and first-deploy guidance are consolidated in
  [configuration.md](./configuration.md).

See [deno-tokenizer.md](./deno-tokenizer.md), [deployment.md](./deployment.md),
and [operations.md](./operations.md) for the current procedures.
