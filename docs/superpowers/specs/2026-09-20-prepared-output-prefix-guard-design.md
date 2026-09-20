# Prepared Output Prefix Guard

## Status

- Design approved: 2026-09-20
- Implementation: in progress

## Problem

The Deno `/prepare` handler constructs a response body with
`max_output_tokens` as the first property in an object literal. ECMAScript
property ordering still serializes canonical array-index keys such as `"0"`
before ordinary string keys. Because the shared Responses normalizer preserves
unknown top-level properties, a valid request containing `"0"` produces a
successful response whose first property is `"0"` instead of
`max_output_tokens`.

The Worker `preflightPreparedOutput` contract requires the exact prefix
`{"max_output_tokens":` before upstream invocation. The current Deno response
therefore reports success and is rejected later as an internal failure.

## Goals

- Never return a successful `/prepare` response that violates the first-property
  contract.
- Preserve the existing `preflightPreparedOutput` prefix requirement.
- Preserve the existing marker collision check and metadata behavior.
- Keep the shared Responses normalization contract unchanged.
- Add a regression test for a canonical array-index top-level key.

## Non-goals

- Do not change public Responses validation errors or shared normalization.
- Do not strip or reorder arbitrary user properties to hide the contract error.
- Do not change Worker preflight behavior.
- Do not reject non-index numeric-looking keys such as `"01"` unless the
  serialized prefix is actually invalid.

## Design

After serializing each marker candidate, validate the complete required prefix:

```text
{"max_output_tokens":"<generated-marker>",
```

If the serialized candidate does not begin with that prefix, return the
existing `prepareInternalFailure()` response immediately. The existing exact
marker occurrence check remains responsible for regenerating a marker when a
candidate occurs elsewhere in the body.

This validates the protocol contract at the producer boundary rather than
changing the shared normalizer's accepted input shape. It also catches the
specific ECMAScript property-ordering case without duplicating array-index
classification logic.

## Error Semantics

- A valid request with a top-level canonical array-index key receives HTTP 500
  with an empty body from `/prepare`.
- The Worker therefore never receives a malformed successful prepare body and
  never starts upstream processing for this case.
- Existing 400/413 validation responses and successful normal requests remain
  unchanged.

## Verification

- Add a Deno HTTP regression test with top-level `"0"` and assert status 500,
  empty body, and no leaked error details.
- Keep the existing successful-response test asserting the exact required
  prefix and marker occurrence.
- Run the Deno tokenizer typecheck and test suite.
- Run the repository typecheck and test suite before committing.

## Files

- `apps/deno-tokenizer/src/http.ts`
- `apps/deno-tokenizer/test/http.test.ts`
