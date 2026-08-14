# OpenCode Responses Text and Tool Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable OCTG to accept and conservatively meter OpenCode/AI SDK Responses text and tool histories without accepting multimodal or unmeterable reference inputs.

**Architecture:** Keep request normalization in `packages/shared/src/normalize.ts`; extend it with explicit allowlists for Responses top-level items and role-specific text parts. Continue forwarding the original body unchanged except for `max_output_tokens`; use normalized visible prompt text plus separately tracked opaque reasoning bytes solely for quota estimation. The Worker remains responsible for enforcing the existing tool policy before reservation.

**Tech Stack:** TypeScript strict mode, Vitest, Cloudflare Workers test pool, Durable Objects, js-tiktoken.

## Global Constraints

- Preserve the MVP pre-reservation rejection of images, audio, videos, and files.
- Preserve the existing OpenAI-compatible error envelope and error codes.
- Treat unknown top-level items, `item_reference`, `previous_response_id`, and `conversation` as invalid request input; do not resolve referenced server state.
- Meter every accepted prompt-bearing string conservatively before quota reservation.
- Count opaque reasoning state separately from visible text using a conservative UTF-8 byte upper bound.
- Do not change `tools_mode`, model aliases, BYOK plugin code, D1 schema, or Durable Object interfaces.
- Do not use `as any`, `@ts-ignore`, or `@ts-expect-error`.

---

## File Structure

- Modify `packages/shared/src/normalize.ts`: define the Responses allowlist, validate nested tool outputs, and collect all metered text.
- Modify `packages/shared/test/normalize.test.ts`: test accepted and rejected shapes plus conservative input-text extraction.
- Modify `packages/shared/src/estimate.ts`: include opaque reasoning bytes in the input estimate.
- Modify `packages/shared/test/estimate.test.ts`: test opaque byte accounting.
- Modify `apps/gateway-worker/test/proxy.test.ts`: verify pre-reservation tool policy and unchanged upstream forwarding for a composite Responses request.
- Modify `apps/gateway-worker/src/proxy.ts`: pass opaque reasoning bytes into token estimation.
- Modify `SPEC.md`: document the explicit Responses compatibility grammar and `item_reference` exclusion.
- Modify `docs/superpowers/specs/2026-08-14-opencode-responses-text-tools-compatibility-design.md`: keep the approved design aligned with the implementation grammar and accounting model.
- Modify `docs/cloudflare-ai-gateway-custom-provider.md`: record the OpenCode/BYOK configuration precondition that prevents `item_reference` payloads.

### Task 1: Lock the Responses compatibility boundary with failing shared tests

**Files:**
- Modify: `packages/shared/test/normalize.test.ts`
- Modify: `apps/gateway-worker/test/proxy.test.ts`
- Modify: `packages/shared/test/estimate.test.ts`

**Interfaces:**
- Consumes: `normalizeResponses(body: unknown): NormalizeResult`
- Produces: regression cases that define accepted role-specific text, tool histories, reasoning replay, and rejected unmeterable/multimodal shapes.

- [ ] **Step 1: Add a failing test for assistant `output_text` and role-aware text parts**

Add a `normalizeResponses` test with user `input_text` and assistant `output_text`. Assert `ok: true`, `inputText` contains both strings, `messageCount` equals the input item count, and `isToolUse` is false. Add a separate user `output_text` case asserting `{ ok: false, error: "invalid_body" }`.

```ts
expect(normalizeResponses({
  model: "gpt-5.6-luna",
  input: [
    { role: "user", content: [{ type: "input_text", text: "question" }] },
    { role: "assistant", content: [{ type: "output_text", text: "answer" }] },
  ],
})).toMatchObject({ ok: true, value: { inputText: "question\nanswer", messageCount: 2 } });

expect(normalizeResponses({
  model: "gpt-5.6-luna",
  input: [{ role: "user", content: [{ type: "output_text", text: "not input" }] }],
})).toEqual({ ok: false, error: "invalid_body" });
```

- [ ] **Step 2: Run the focused test and verify the expected RED result**

Run: `npm test -w packages/shared -- normalize.test.ts`

Expected: the assistant `output_text` case fails with `non_text`; the user role-specific case may currently fail with `non_text`, demonstrating the error-classification change required by the design.

- [ ] **Step 3: Add failing tests for metered tool and reasoning history**

Add one composite input containing unique markers in user `input_text`, a valid `function_call` with `arguments`, a valid `function_call_output` with string `output`, and a `reasoning` item with unique `summary_text` plus `encrypted_content`. Assert successful normalization, `isToolUse: true`, and that every marker occurs in `inputText`. Add a second test for a `function_call_output.output` array of `{ type: "input_text", text: "tool-output-marker" }`.

```ts
const normalized = normalizeResponses({
  model: "gpt-5.6-luna",
  instructions: "instructions-marker",
  tools: [{ type: "function", name: "tool-name-marker", description: "schema-marker", parameters: { type: "object", properties: {} } }],
  tool_choice: { type: "function", name: "choice-marker" },
  input: [
    { role: "user", content: [{ type: "input_text", text: "user-marker" }] },
    { type: "function_call", call_id: "call_1", name: "lookup-marker", arguments: "{\"city\":\"argument-marker\"}" },
    { type: "function_call_output", call_id: "call_1", output: "tool-output-marker" },
    { type: "reasoning", summary: [{ type: "summary_text", text: "summary-marker" }], encrypted_content: "opaque-marker" },
    { type: "reasoning", summary: [{ type: "summary_text", text: "summary-marker-2" }], encrypted_content: "opaque-marker-2" },
  ],
});

expect(normalized).toMatchObject({
  ok: true,
  value: { isToolUse: true, inputText: expect.stringContaining("tool-output-marker"), opaqueInputBytes: 28 },
});
```

The test must also assert `user-marker`, `lookup-marker`, `argument-marker`, `tool-output-marker`, `summary-marker`, `summary-marker-2`, `instructions-marker`, `tool-name-marker`, `schema-marker`, and `choice-marker` individually so omission of any one prompt-bearing field fails. The two opaque strings must be summed (`"opaque-marker"` is 13 bytes and `"opaque-marker-2"` is 15 bytes).

- [ ] **Step 4: Run the focused test and verify the expected RED result**

Run: `npm test -w packages/shared -- normalize.test.ts`

Expected: the composite test fails because `reasoning` is presently treated as a content-bearing message with missing `content`; the metered tool fields are absent from `inputText`.

- [ ] **Step 5: Add failing tests for the fail-closed boundary and external-state fields**

Add independent tests for:

```ts
{ type: "function_call_output", call_id: "call_1", output: [{ type: "input_image", image_url: "https://example.invalid/a.png" }] }
{ type: "item_reference", id: "resp_123" }
{ type: "unknown_item", content: [{ type: "input_text", text: "must not pass" }] }
```

Also add bodies containing `previous_response_id` and `conversation`. Assert the tool-output image returns `non_text`; assert `item_reference`, `previous_response_id`, `conversation`, and the unknown top-level item return `invalid_body`.

- [ ] **Step 6: Run the focused test and verify the expected RED result**

Run: `npm test -w packages/shared -- normalize.test.ts`

Expected: the tool-output image currently succeeds or is skipped; `item_reference` currently produces the wrong `non_text` classification; external-state fields and unknown items are not rejected by the current normalizer.

- [ ] **Step 7: Add Worker-level RED tests before production implementation**

In `apps/gateway-worker/test/proxy.test.ts`, add explicit-policy tests before Task 2 implementation. Use `model: "gpt-5"` to exercise the pool already returned by `todayStub()`. Seed `toolsMode: "REJECT"` and `toolsMode: "ALLOW"` independently, call `invalidateConfigCaches()`, and compare quota state before/after. Use a composite body with `store: false`, `instructions`, a function tool definition, user/assistant/tool history, and reasoning content. Assert REJECT returns 403 with no upstream call; assert ALLOW currently fails normalization; assert a tool-output `input_file` returns 400 with `param: "input"`, no upstream call, and no quota delta. Add a valid `item_reference`/`previous_response_id`/`conversation` body case and assert 400 with `param: null`.

- [ ] **Step 8: Add the opaque-byte RED test**

In `packages/shared/test/estimate.test.ts`, call the revised estimate API with the same visible text and different `opaqueInputBytes`; assert the larger opaque byte count yields the larger estimate and zero bytes preserves the existing estimate.

- [ ] **Step 9: Run all pre-implementation focused tests and verify RED**

Run: `npm test -w packages/shared -- normalize.test.ts estimate.test.ts`
Run: `npm test -w apps/gateway-worker -- proxy.test.ts`

Expected: the new shared and Worker tests fail for the current normalizer/estimate behavior, while existing baseline tests continue to run.

### Task 2: Implement explicit, conservative Responses normalization

**Files:**
- Modify: `packages/shared/src/normalize.ts`
- Test: `packages/shared/test/normalize.test.ts`
- Modify: `packages/shared/src/estimate.ts`
- Test: `packages/shared/test/estimate.test.ts`
- Modify: `apps/gateway-worker/src/proxy.ts`

**Interfaces:**
- Consumes: existing `NormalizeResult`, `NormalizedRequest`, `hasToolUse`, and `estimateInputTokens` callers.
- Produces: the same public `normalizeResponses` signature, with `inputText` containing visible prompt-bearing fields, `opaqueInputBytes` containing conservative reasoning-state bytes, and `messageCount` remaining the input-array item count.

- [ ] **Step 1: Add a role-aware text-content walker**

Replace the shared unqualified Responses use of `walkContent()` with a Responses-specific walker that accepts:

```ts
const allowedPartTypesByRole = {
  assistant: new Set(["output_text"]),
  developer: new Set(["input_text"]),
  system: new Set(["input_text"]),
  user: new Set(["input_text"]),
} as const;
```

Treat a top-level item with `type: "message"` or no `type` as a role-bearing message. For each part, reject the explicit multimodal types with `non_text`; return `invalid_body` for a missing/unknown role, missing/unknown part type, or a text part that is invalid for that role. Preserve string `content` only for the same four roles. Do not accept nested `text` parts on the Responses wire; AI SDK uses `input_text`/`output_text`.

- [ ] **Step 2: Add explicit top-level Responses-item handling**

In the `input` array loop, discriminate by `entry.type` before reading `content`:

```ts
switch (entry.type) {
  case undefined:
  case "message":
    // Validate a role-bearing message via the new role-aware walker.
    break;
  case "function_call":
    // Require string name and arguments; meter both.
    break;
  case "function_call_output":
    // Require string call_id; validate and meter output.
    break;
  case "reasoning":
    // Require summary array and encrypted_content; meter visible and opaque fields separately.
    break;
  default:
    return { ok: false, error: "invalid_body" };
}
```

Treat malformed scalar fields as `invalid_body`. Require `call_id`, `name`, and string `arguments` for `function_call`; require string `call_id` for `function_call_output`. Mark both function item types as tool use. Reject `item_reference`, `previous_response_id`, and `conversation` before input traversal.

- [ ] **Step 3: Define and use a tool-output walker**

Accept `function_call_output.output` only as a string or an array of `{ type: "input_text", text: string }`. Reuse the explicit `NON_TEXT_PART_TYPES` set so listed modalities (`input_image`, `input_audio`, `input_file`, `file`, `audio`, `video`) return `non_text`; unknown or malformed parts return `invalid_body`.

Append valid `function_call.arguments`, function name, string tool output, `instructions`, and JSON-serializable tool definitions/named tool choice to visible metering text. If serialization of a prompt-bearing field fails, return `invalid_body` rather than forwarding an unmetered request.

- [ ] **Step 4: Define conservative reasoning metering**

Accept a reasoning item only when `summary` is an array of `{ type: "summary_text", text: string }` and `encrypted_content` is a string. Append summary text to `inputText`; add the UTF-8 byte length of every reasoning item's `encrypted_content` to the accumulated `opaqueInputBytes` (never overwrite a prior item's value). Reject an invalid summary part or non-string encrypted content as `invalid_body`; reject an explicit multimodal summary part as `non_text`.

- [ ] **Step 5: Keep metering and reservation semantics unchanged outside normalization**

Change `NormalizedRequest` to include `opaqueInputBytes: number`, set it to `0` for Chat Completions, and pass it from `proxy.ts` into `estimateInputTokens(text, messageCount, opaqueInputBytes)`. Add opaque bytes to the estimate as a conservative upper bound before `safetyMargin`, `upperBoundOf`, and reservation arithmetic. Reject `previous_response_id` and `conversation` before traversal. Do not alter Durable Object code or upstream construction.

- [ ] **Step 6: Update existing normalized-result expectations**

Add `opaqueInputBytes: 0` to every existing `normalizeChatCompletions` and non-reasoning `normalizeResponses` expected value. Update the existing function-call fixture to include valid `call_id`, `name`, and string `arguments`, then add the exact expected opaque byte count to the reasoning fixture. Keep `messageCount` as the number of input items, not a token proxy.

- [ ] **Step 7: Run shared tests and verify GREEN**

Run: `npm test -w packages/shared -- normalize.test.ts`

Expected: all existing normalization tests and every new boundary test pass.

- [ ] **Step 8: Run type checking for the modified workspace**

Run: `npm run typecheck -w packages/shared`

Expected: exit code 0 with no TypeScript diagnostics.

### Task 3: Prove Worker policy and forwarding behavior for composite Responses history

**Files:**
- Modify: `apps/gateway-worker/test/proxy.test.ts`

**Interfaces:**
- Consumes: `SELF.fetch`, `seedPolicy`, `todayStub`, and the existing authenticated request helpers.
- Produces: end-to-end assurance that normalization precedes reservation, `tools_mode` is honored, and the upstream request preserves composite input.

- [ ] **Step 1: Complete the Worker integration assertions from Task 1**

Ensure the pre-implementation tests explicitly seed `toolsMode: "REJECT"` and `toolsMode: "ALLOW"`, invalidate policy caches, and compare before/after `confirmedTokens`, `reservedTokens`, and `uncertainTokens`. The ALLOW case must capture the full upstream body and assert `upstreamBody` deep-equals `{ ...originalBody, max_output_tokens: 64 }`, and the response settles quota. The REJECT case must assert HTTP 403 with `model_not_allowed`, `param: "model"`, no upstream call, and no quota delta. The tool-output `input_file` case must assert HTTP 400 with `invalid_request`, `param: "input"`, no upstream call, and no quota delta. The external-state cases must assert HTTP 400 with `param: null`.

- [ ] **Step 2: Run the Worker test suite and verify GREEN**

Run: `npm test -w apps/gateway-worker -- proxy.test.ts`

Expected: all proxy tests pass, including REJECT/ALLOW and non-text pre-reservation assertions.

- [ ] **Step 3: Run type checking for the modified workspace**

Run: `npm run typecheck -w apps/gateway-worker`

Expected: exit code 0 with no TypeScript diagnostics.

### Task 4: Document the wire contract and verify the complete artifact

**Files:**
- Modify: `SPEC.md`
- Modify: `docs/cloudflare-ai-gateway-custom-provider.md`
- Modify: `docs/superpowers/specs/2026-08-14-opencode-responses-text-tools-compatibility-design.md`

**Interfaces:**
- Consumes: implemented `normalizeResponses` behavior and existing error contract.
- Produces: an operator-facing contract for supported OpenCode Responses input and the required configuration to avoid `item_reference`.

- [ ] **Step 1: Update `SPEC.md` with the Responses allowlist and metering rules**

Add a concise subsection under input normalization that states:

```text
Accepted: user/system/developer input_text or string content; assistant output_text;
function_call arguments; string or input_text function_call_output; reasoning summary_text
and encrypted_content.
Rejected before reservation: image/audio/file/video parts, item_reference,
previous_response_id, conversation, and unknown items.
All accepted prompt-bearing strings participate in token estimation; encrypted
reasoning state is counted separately by conservative UTF-8 byte upper bound.
```

Retain the existing non-text HTTP 400 contract. State that malformed and unknown structural items use the existing invalid-request contract.

- [ ] **Step 2: Update the custom-provider runbook**

Add an OpenCode/BYOK compatibility note requiring `store: false` and replay of required history instead of sending `item_reference`, `previous_response_id`, or `conversation`. Document that OCTG rejects those fields intentionally because it cannot conservatively meter referenced server state. Include the deployment-version check for the BYOK plugin configuration.

- [ ] **Step 3: Update the approved design spec**

Align the design spec with the implementation: explicit `message`/omitted-type handling, role-specific `input_text`/`output_text`, required reasoning fields, separate `opaqueInputBytes`, tool argument/output metering, and rejection of `item_reference`, `previous_response_id`, and `conversation`.

- [ ] **Step 4: Verify documentation consistency**

Read `SPEC.md`, `docs/cloudflare-ai-gateway-custom-provider.md`, and `docs/superpowers/specs/2026-08-14-opencode-responses-text-tools-compatibility-design.md`. Confirm they agree on accepted item types, the `item_reference` rejection, and the unchanged non-text error response.

- [ ] **Step 5: Run the full validation suite**

Run in parallel:

```bash
npm test
```

```bash
npm run typecheck
```

Expected: both commands exit 0.

- [ ] **Step 6: Manually exercise the HTTP surface**

Start the gateway development Worker using the project-prescribed command, then make two authenticated `POST /v1/responses` requests:

1. A composite text/tool request with `store: false` under a client policy with `tools_mode: "ALLOW"`; verify it reaches the configured test upstream and returns a successful OpenAI-compatible response.
2. A request with `function_call_output.output` containing `input_image`; verify HTTP 400, `error.param: "input"`, and no upstream request.

Expected: only the first request reaches upstream; the second is rejected before reservation.

## Self-Review

- Spec coverage: Task 1 locks role-aware `output_text`, tool history, reasoning, multimodal rejection, `item_reference` rejection, and unknown-item rejection. Task 2 implements conservative normalization/metering. Task 3 proves tool policy and forwarding at the Worker boundary. Task 4 documents the contract and runs full/manual verification.
- Placeholder scan: completed; all test cases, commands, expected results, and supported fields are named explicitly.
- Type consistency: the plan preserves `normalizeResponses(body: unknown): NormalizeResult`, `NormalizedRequest.inputText`, and `NormalizedRequest.messageCount`; no new external API is introduced.
