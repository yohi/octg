# Deno Deploy External Tokenizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:executing-plans` to implement this plan task-by-task. Do not use
> subagents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep OCTG on Cloudflare while routing only large normalized
`inputText` values to an authenticated Deno Deploy service for exact
`o200k_base` BPE counting.

**Architecture:** Gateway Worker resolves one opt-in Deno configuration and
selects either the existing `TokenizerController` or one direct Deno HTTP call
from `inputTextBytes`. Deno returns only `baseTokenCount`; shared arithmetic in
`@octg/shared` completes the existing estimate before quota reservation.

**Tech Stack:** TypeScript strict mode, Cloudflare Workers and Durable Objects,
Deno 2, Deno Deploy, `tiktoken@1.0.22`, Vitest, Deno native tests.

## Global Constraints

- `QuotaController` remains the quota authority. D1 remains audit-only.
- Production and Preview use different Deno applications, endpoints, and
  Bearer secrets.
- Deno integration is disabled only when all four Deno Worker settings are
  absent.
- Partial or invalid Deno settings fail authenticated `/v1` requests with the
  existing `500 / api_error / internal_error` response.
- `inputTextBytes < threshold` uses `TokenizerController`; equality and larger
  values use Deno.
- Deno receives only `{"inputText":"..."}` and returns only
  `{"baseTokenCount": number}`.
- Deno performs exact BPE only. It never estimates conservatively.
- Deno failures have no retry, Durable Object fallback, or conservative
  fallback.
- Deno failure occurs before quota reservation, in-flight admission, and
  upstream access.
- The timeout covers request start through response body read and schema
  validation.
- Prompt text, request bodies, credentials, authorization values, and arbitrary
  exception messages must never be logged or persisted.
- Do not add a generic external-tokenizer provider abstraction.
- Threshold, timeout, and target concurrency remain operational values chosen
  from profiling and canary evidence, not source defaults.
- Run Git commands only when the user explicitly requests them. Commit steps
  below are gated checkpoints, not automatic actions.

## File Structure

### Shared contracts and arithmetic

- Create `packages/shared/src/tokenization.ts` for input ceilings, the shared
  resolver, and safe final input-token arithmetic.
- Create `packages/shared/test/tokenization.test.ts` for resolver and arithmetic
  boundaries.
- Modify `packages/shared/src/index.ts` to export the new API.
- Modify `durable-objects/tokenizer-controller/src/contracts.ts` to consume the
  shared input-text ceiling.
- Modify `durable-objects/tokenizer-controller/src/estimator.ts` to consume the
  shared arithmetic helper while preserving its existing fallback behavior.

### Deno service

- Create `apps/deno-tokenizer/package.json` for npm-workspace test and typecheck
  integration.
- Create `apps/deno-tokenizer/deno.json` and `apps/deno-tokenizer/deno.lock` for
  pinned Deno and npm resolution.
- Create `apps/deno-tokenizer/src/config.ts` for secret and input-limit parsing.
- Create `apps/deno-tokenizer/src/encoder.ts` for the single reusable exact BPE
  encoder.
- Create `apps/deno-tokenizer/src/http.ts` for authentication, bounded input,
  schema validation, and minimal responses.
- Create `apps/deno-tokenizer/src/main.ts` as the `Deno.serve` entrypoint.
- Create focused Deno tests under `apps/deno-tokenizer/test/`.

### Gateway routing

- Create `apps/gateway-worker/src/deno-tokenizer-config.ts` for the three-state
  disabled, invalid, and enabled configuration.
- Create `apps/gateway-worker/src/deno-tokenizer-client.ts` for one bounded HTTP
  attempt.
- Create `apps/gateway-worker/src/tokenization.ts` for concrete DO-versus-Deno
  routing without a provider framework.
- Modify `apps/gateway-worker/src/proxy.ts` to call the concrete router and keep
  the quota boundary unchanged.
- Modify `apps/gateway-worker/src/models.ts` so invalid Deno configuration also
  rejects authenticated `GET /v1/models`.
- Modify `apps/gateway-worker/src/index.ts` to add optional Deno bindings.
- Modify `apps/gateway-worker/src/resource-observation.ts` to allowlist provider
  and failure category.
- Add unit and integration tests under `apps/gateway-worker/test/`.

### Documentation

- Create `docs/deno-tokenizer.md` as the deployment and operations runbook.
- Modify `README.md`, `SPEC.md`, and `docs/DEPLOY_FROM_TEMPLATE.md` to describe
  the opt-in architecture and link the runbook.

---

### Task 1: Centralize input limits and token arithmetic

**Files:**

- Create: `packages/shared/src/tokenization.ts`
- Create: `packages/shared/test/tokenization.test.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `durable-objects/tokenizer-controller/package.json`
- Modify: `durable-objects/tokenizer-controller/src/contracts.ts`
- Modify: `durable-objects/tokenizer-controller/src/estimator.ts`
- Modify: `durable-objects/tokenizer-controller/test/estimator.test.ts`
- Modify: `apps/gateway-worker/src/proxy.ts`
- Modify: `apps/gateway-worker/test/proxy-failures.test.ts`

**Interfaces:**

- Produces:

```typescript
export const MAX_INPUT_TEXT_BYTES = 16 * 1024 * 1024 - 65_536;

export function resolveMaxInputBytes(
  configured: string | undefined,
): number;

export function estimatedInputTokensOf(args: {
  readonly baseTokenCount: number;
  readonly messageCount: number;
  readonly opaqueInputBytes: number;
}): number;
```

- Consumers: Gateway configuration, Deno configuration, and
  `TokenizerEstimator`.

- [ ] **Step 1: Write failing shared boundary tests**

Create `packages/shared/test/tokenization.test.ts` with the exact resolver and
arithmetic matrix:

```typescript
import { describe, expect, it } from "vitest";
import {
  MAX_INPUT_TEXT_BYTES,
  estimatedInputTokensOf,
  resolveMaxInputBytes,
} from "../src/index";

describe("resolveMaxInputBytes", () => {
  it.each([undefined, "", "0", "-1", "1.5", "invalid",
    "9007199254740992"])("uses 1 MiB for invalid value %s", (value) => {
    expect(resolveMaxInputBytes(value)).toBe(1_048_576);
  });

  it("preserves valid values and clamps the tokenizer ceiling", () => {
    expect(resolveMaxInputBytes("2")).toBe(2);
    expect(resolveMaxInputBytes(String(MAX_INPUT_TEXT_BYTES))).toBe(
      MAX_INPUT_TEXT_BYTES,
    );
    expect(resolveMaxInputBytes(String(MAX_INPUT_TEXT_BYTES + 1))).toBe(
      MAX_INPUT_TEXT_BYTES,
    );
  });
});

describe("estimatedInputTokensOf", () => {
  it("adds base, opaque bytes, message overhead, and framing once", () => {
    expect(estimatedInputTokensOf({
      baseTokenCount: 2,
      messageCount: 2,
      opaqueInputBytes: 11,
    })).toBe(24);
  });

  it.each([
    { baseTokenCount: -1, messageCount: 0, opaqueInputBytes: 0 },
    { baseTokenCount: 1.5, messageCount: 0, opaqueInputBytes: 0 },
    {
      baseTokenCount: Number.MAX_SAFE_INTEGER,
      messageCount: 1,
      opaqueInputBytes: 0,
    },
  ])("rejects invalid or overflowing arithmetic %#", (args) => {
    expect(() => estimatedInputTokensOf(args)).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run the shared test and confirm the red state**

Run:

```bash
npm test -w packages/shared -- tokenization.test.ts
```

Expected: FAIL because the three shared exports do not exist.

- [ ] **Step 3: Implement the minimal shared helpers**

Create `packages/shared/src/tokenization.ts`:

```typescript
import { MAX_NORMALIZED_INPUT_BYTES } from "./normalize";

export const MAX_INPUT_TEXT_BYTES = 16 * 1024 * 1024 - 65_536;

export function resolveMaxInputBytes(
  configured: string | undefined,
): number {
  const parsed = Number(configured);
  const resolved = Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : MAX_NORMALIZED_INPUT_BYTES;
  return Math.min(resolved, MAX_INPUT_TEXT_BYTES);
}

export function estimatedInputTokensOf(args: {
  readonly baseTokenCount: number;
  readonly messageCount: number;
  readonly opaqueInputBytes: number;
}): number {
  const { baseTokenCount, messageCount, opaqueInputBytes } = args;
  const messageOverhead = messageCount * 4;
  const estimated = baseTokenCount + opaqueInputBytes + messageOverhead + 3;
  if (
    !Number.isSafeInteger(baseTokenCount) ||
    baseTokenCount < 0 ||
    !Number.isSafeInteger(messageCount) ||
    messageCount < 0 ||
    !Number.isSafeInteger(opaqueInputBytes) ||
    opaqueInputBytes < 0 ||
    !Number.isSafeInteger(messageOverhead) ||
    !Number.isSafeInteger(estimated) ||
    estimated < 0
  ) {
    throw new RangeError("Tokenizer arithmetic overflow.");
  }
  return estimated;
}
```

Export it from `packages/shared/src/index.ts`.

- [ ] **Step 4: Route existing consumers through the shared implementation**

Add `"@octg/shared": "*"` to the tokenizer-controller dependencies. Import
`MAX_INPUT_TEXT_BYTES` in `contracts.ts`, export it there only if existing
callers still require that package path, and replace `estimatedTokensOf` calls
in `estimator.ts` with:

```typescript
estimatedInputTokensOf({
  baseTokenCount: base,
  messageCount: request.messageCount,
  opaqueInputBytes: request.opaqueInputBytes,
});
```

Delete the local arithmetic helper. Import `resolveMaxInputBytes` and
`MAX_INPUT_TEXT_BYTES` from `@octg/shared` in Gateway code and tests, then
delete the duplicate resolver from `proxy.ts`.

- [ ] **Step 5: Verify shared behavior and existing DO fallback behavior**

Run:

```bash
npm test -w packages/shared
npm test -w durable-objects/tokenizer-controller
npm run typecheck -w packages/shared
npm run typecheck -w durable-objects/tokenizer-controller
```

Expected: all pass, including existing conservative fallback and overflow
tests.

- [ ] **Step 6: Optional commit checkpoint**

Only after explicit user authorization:

```bash
git add packages/shared durable-objects/tokenizer-controller \
  apps/gateway-worker/src/proxy.ts \
  apps/gateway-worker/test/proxy-failures.test.ts package-lock.json
git commit -m "refactor(tokenizer): 入力上限と算術を共有化"
```

### Task 2: Add the exact Deno encoder and parity gate

**Files:**

- Create: `apps/deno-tokenizer/package.json`
- Create: `apps/deno-tokenizer/deno.json`
- Create: `apps/deno-tokenizer/deno.lock`
- Create: `apps/deno-tokenizer/src/encoder.ts`
- Create: `apps/deno-tokenizer/test/encoder.test.ts`
- Modify: `package-lock.json`

**Interfaces:**

- Consumes: `tiktoken@1.0.22` and the existing golden fixture.
- Produces:

```typescript
export interface ExactEncoder {
  readonly count: (inputText: string) => number;
}

export const exactEncoder: ExactEncoder;
```

- [ ] **Step 1: Add the Deno workspace shell and failing parity test**

Create a private workspace `package.json` whose `test` and `typecheck` scripts
run `deno task test` and `deno task check`. Pin these imports in `deno.json`:

```json
{
  "lock": true,
  "imports": {
    "@octg/shared": "../../packages/shared/src/index.ts",
    "tiktoken/lite/init": "npm:tiktoken@1.0.22/lite/init",
    "tiktoken/lite/tiktoken_bg.wasm":
      "npm:tiktoken@1.0.22/lite/tiktoken_bg.wasm",
    "tiktoken/encoders/o200k_base":
      "npm:tiktoken@1.0.22/encoders/o200k_base"
  },
  "tasks": {
    "check": "deno check src/main.ts test/*.test.ts",
    "test": "deno test --allow-env --allow-read test"
  }
}
```

Create `test/encoder.test.ts` and derive the expected base count from the
existing final-estimate fixture:

```typescript
import { assertEquals } from "jsr:@std/assert@1";
import golden from
  "../../../durable-objects/tokenizer-controller/test/fixtures/tokenization-golden.json"
  with { type: "json" };
import { exactEncoder } from "../src/encoder.ts";

for (const testCase of golden.cases) {
  Deno.test(`exact parity: ${testCase.name}`, () => {
    const inputText = testCase.repeat === undefined
      ? testCase.inputText
      : testCase.inputText.repeat(testCase.repeat);
    const expectedBase = testCase.expected - testCase.opaqueInputBytes
      - (testCase.messageCount * 4) - 3;
    assertEquals(exactEncoder.count(inputText), expectedBase);
  });
}
```

- [ ] **Step 2: Run the parity test and confirm the red state**

Run:

```bash
npm test -w apps/deno-tokenizer
```

Expected: FAIL because `src/encoder.ts` does not exist.

- [ ] **Step 3: Initialize one reusable lite/WASM encoder**

Implement `src/encoder.ts` using the empirically verified Deno 2.9 path:

```typescript
import { init, Tiktoken } from "tiktoken/lite/init";
import o200kBase from "tiktoken/encoders/o200k_base";

const wasmUrl = import.meta.resolve(
  "tiktoken/lite/tiktoken_bg.wasm",
);
const wasm = await Deno.readFile(new URL(wasmUrl));
await init((imports) => WebAssembly.instantiate(wasm, imports));

const encoding = new Tiktoken(
  o200kBase.bpe_ranks,
  o200kBase.special_tokens,
  o200kBase.pat_str,
);

export interface ExactEncoder {
  readonly count: (inputText: string) => number;
}

export const exactEncoder: ExactEncoder = {
  count: (inputText) => encoding.encode(inputText).length,
};
```

Do not add a conservative path or fetch encoding data at request time.

- [ ] **Step 4: Generate the lock and verify the 74k fixture**

Run:

```bash
deno task --config apps/deno-tokenizer/deno.json test
deno task --config apps/deno-tokenizer/deno.json check
```

Expected: all golden cases pass; `long_english_7400x` reports base count
`74_000`. Commit the generated `deno.lock`.

- [ ] **Step 5: Optional commit checkpoint**

Only after explicit user authorization:

```bash
git add apps/deno-tokenizer package-lock.json
git commit -m "feat(deno): exact BPE encoder を追加"
```

### Task 3: Implement the authenticated Deno HTTP boundary

**Files:**

- Create: `apps/deno-tokenizer/src/config.ts`
- Create: `apps/deno-tokenizer/src/http.ts`
- Create: `apps/deno-tokenizer/src/main.ts`
- Create: `apps/deno-tokenizer/test/config.test.ts`
- Create: `apps/deno-tokenizer/test/http.test.ts`
- Modify: `apps/deno-tokenizer/deno.json`

**Interfaces:**

- Consumes: `resolveMaxInputBytes`, `ExactEncoder`, and runtime environment.
- Produces:

```typescript
export interface DenoTokenizerServiceConfig {
  readonly authToken: string;
  readonly maxInputBytes: number;
  readonly maxRawBodyBytes: number;
}

export function resolveServiceConfig(
  readEnv: (name: string) => string | undefined,
): DenoTokenizerServiceConfig;

export function createTokenizerHandler(args: {
  readonly config: DenoTokenizerServiceConfig;
  readonly encoder: ExactEncoder;
}): (request: Request) => Promise<Response>;
```

- [ ] **Step 1: Write configuration and HTTP rejection tests**

Cover the concrete matrix in Deno tests:

```typescript
Deno.test("requires a non-empty dedicated auth token", () => {
  assertThrows(
    () => resolveServiceConfig(() => undefined),
    TypeError,
    "Invalid Deno tokenizer configuration.",
  );
});

Deno.test("derives the raw envelope ceiling from resolved input bytes", () => {
  const values = new Map([
    ["OCTG_TOKENIZER_AUTH_TOKEN", "test-secret"],
    ["MAX_INPUT_BYTES", "2"],
  ]);
  assertEquals(resolveServiceConfig((name) => values.get(name)), {
    authToken: "test-secret",
    maxInputBytes: 2,
    maxRawBodyBytes: 28,
  });
});
```

In `http.test.ts`, inject `{ count: () => 7 }` and assert exact statuses:

```typescript
const validRequest = (inputText: string, token = "test-secret") =>
  new Request("https://deno.test/v1/tokenize", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ inputText }),
  });

Deno.test("returns only the exact base token count", async () => {
  const response = await handler(validRequest("hello"));
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { baseTokenCount: 7 });
});
```

Add separate assertions for wrong path `404`, wrong method `405`, missing or
wrong Bearer token `401`, wrong content type `415`, invalid JSON or shape `400`,
and over-limit raw or parsed input `413`. Assert that the fake encoder has zero
calls for every rejection.

- [ ] **Step 2: Add exact raw-versus-text boundary tests**

Use a two-byte effective input ceiling and verify:

```typescript
Deno.test("accepts inputText exactly at the UTF-8 ceiling", async () => {
  const response = await handler(validRequest("aa"));
  assertEquals(response.status, 200);
});

Deno.test("rejects inputText one UTF-8 byte above the ceiling", async () => {
  const response = await handler(validRequest("aaa"));
  assertEquals(response.status, 413);
});

Deno.test(
  "does not apply inputText ceiling to escaped JSON bytes",
  async () => {
    const response = await handler(validRequest("\n\n"));
    assertEquals(response.status, 200);
  },
);
```

Create a custom `ReadableStream` request with no `Content-Length` that exceeds
the derived raw ceiling and assert the reader is cancelled after `413`. Also
send a declared `Content-Length` above the ceiling and assert the stream is not
read.

- [ ] **Step 3: Implement constant-time authentication and bounded parsing**

Hash both expected and presented Bearer values with SHA-256, then compare all
32 digest bytes with XOR accumulation. Authenticate before reading the body.
Use `maxRawBodyBytes = (6 * maxInputBytes) + 16`; apply it to declared length
and streamed bytes only. After JSON shape validation, measure
`new TextEncoder().encode(inputText).byteLength` and reject only when it is
greater than `maxInputBytes`.

Return JSON with `content-type: application/json; charset=utf-8`. Catch encoder
exceptions and return a minimal `500` body without exception text. Do not call
`console` from request handling.

- [ ] **Step 4: Add the Deno entrypoint and no-log test**

Create `src/main.ts`:

```typescript
import { resolveServiceConfig } from "./config.ts";
import { exactEncoder } from "./encoder.ts";
import { createTokenizerHandler } from "./http.ts";

const config = resolveServiceConfig((name) => Deno.env.get(name));
Deno.serve(createTokenizerHandler({ config, encoder: exactEncoder }));
```

Patch `console.log`, `console.info`, `console.warn`, and `console.error` in a
test, send a unique prompt and credential, and assert neither value appears in
captured arguments for success, authentication failure, invalid input, and
encoder failure.

- [ ] **Step 5: Verify the Deno service**

Run:

```bash
npm test -w apps/deno-tokenizer
npm run typecheck -w apps/deno-tokenizer
```

Expected: all tests pass without application-log output.

- [ ] **Step 6: Optional commit checkpoint**

Only after explicit user authorization:

```bash
git add apps/deno-tokenizer
git commit -m "feat(deno): 認証済み tokenizer endpoint を追加"
```

### Task 4: Parse opt-in Gateway configuration

**Files:**

- Create: `apps/gateway-worker/src/deno-tokenizer-config.ts`
- Create: `apps/gateway-worker/test/deno-tokenizer-config.test.ts`
- Modify: `apps/gateway-worker/src/index.ts`
- Modify: `apps/gateway-worker/src/models.ts`
- Modify: `apps/gateway-worker/test/models-api.test.ts`

**Interfaces:**

```typescript
export type DenoTokenizerConfig =
  | { readonly kind: "disabled"; readonly maxInputBytes: number }
  | { readonly kind: "invalid"; readonly maxInputBytes: number }
  | {
      readonly kind: "enabled";
      readonly endpoint: string;
      readonly authToken: string;
      readonly thresholdBytes: number;
      readonly timeoutMs: number;
      readonly maxInputBytes: number;
    };

export function resolveDenoTokenizerConfig(env: {
  readonly MAX_INPUT_BYTES?: string;
  readonly DENO_TOKENIZER_ENDPOINT?: string;
  readonly DENO_TOKENIZER_AUTH_TOKEN?: string;
  readonly DENO_TOKENIZER_THRESHOLD_BYTES?: string;
  readonly DENO_TOKENIZER_TIMEOUT_MS?: string;
}): DenoTokenizerConfig;
```

- [ ] **Step 1: Write the complete configuration-state matrix**

Test all-absent as disabled, all-present valid as enabled, each one-field
omission as invalid, and each invalid value as invalid:

```typescript
const complete = {
  MAX_INPUT_BYTES: "1024",
  DENO_TOKENIZER_ENDPOINT: "https://tokenizer.example/v1/tokenize",
  DENO_TOKENIZER_AUTH_TOKEN: "test-secret",
  DENO_TOKENIZER_THRESHOLD_BYTES: "512",
  DENO_TOKENIZER_TIMEOUT_MS: "3000",
};

expect(resolveDenoTokenizerConfig({ MAX_INPUT_BYTES: "invalid" })).toEqual({
  kind: "disabled",
  maxInputBytes: 1_048_576,
});
expect(resolveDenoTokenizerConfig(complete)).toEqual({
  kind: "enabled",
  endpoint: "https://tokenizer.example/v1/tokenize",
  authToken: "test-secret",
  thresholdBytes: 512,
  timeoutMs: 3000,
  maxInputBytes: 1024,
});
```

Reject HTTP URLs, URLs with embedded credentials, empty secrets, threshold 0,
threshold above `maxInputBytes`, fractional or unsafe integers, and timeout
above `2_147_483_647`.

- [ ] **Step 2: Implement the three-state parser**

Treat only the four `DENO_TOKENIZER_*` values as integration presence. Resolve
`MAX_INPUT_BYTES` independently through the shared helper. Return no detailed
error strings and never include the secret in an exception or log.

- [ ] **Step 3: Add environment types and reject invalid `/v1/models` config**

Add the four optional fields to `Env`. In `handleModels`, run authentication
first, then resolve configuration. For `kind === "invalid"`, return
`errInternal(requestId)` through `errorResponse` before registry access.

Test unauthenticated `/v1/models` remains `401`, valid all-absent config remains
`200`, and authenticated partial config becomes generic `500`.

- [ ] **Step 4: Verify configuration behavior**

Run:

```bash
npm test -w apps/gateway-worker -- \
  deno-tokenizer-config.test.ts models-api.test.ts
npm run typecheck -w apps/gateway-worker
```

Expected: all pass. Do not add Deno vars to `wrangler.jsonc`; absence is the
backward-compatible default.

- [ ] **Step 5: Optional commit checkpoint**

Only after explicit user authorization:

```bash
git add apps/gateway-worker/src/deno-tokenizer-config.ts \
  apps/gateway-worker/src/index.ts apps/gateway-worker/src/models.ts \
  apps/gateway-worker/test/deno-tokenizer-config.test.ts \
  apps/gateway-worker/test/models-api.test.ts
git commit -m "feat(gateway): Deno tokenizer 設定を検証"
```

### Task 5: Implement one bounded Gateway-to-Deno attempt

**Files:**

- Create: `apps/gateway-worker/src/deno-tokenizer-client.ts`
- Create: `apps/gateway-worker/test/deno-tokenizer-client.test.ts`

**Interfaces:**

```typescript
export type DenoTokenizationFailure =
  | "timeout"
  | "network"
  | "upstream_status"
  | "malformed_response";

export type DenoTokenizationOutcome =
  | { readonly kind: "resolved"; readonly baseTokenCount: number }
  | {
      readonly kind: "unavailable";
      readonly failureCategory: DenoTokenizationFailure;
    };

export async function tokenizeWithDeno(args: {
  readonly endpoint: string;
  readonly authToken: string;
  readonly timeoutMs: number;
  readonly inputText: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<DenoTokenizationOutcome>;
```

- [ ] **Step 1: Write success, failure, and privacy tests**

Assert the outgoing request has only `Authorization`, `Content-Type`, and body
`{"inputText":"hello"}`. Assert it contains no request ID, quota state,
policy, OpenAI key, or client key. Add one-attempt tests for network rejection,
non-2xx, wrong content type, invalid JSON, extra or missing response fields,
negative/fractional/unsafe counts, and a response body larger than 1 KiB.

- [ ] **Step 2: Add a separate stalled-200-body timeout test**

Use fake timers and a never-closing stream. Track when its read starts and when
the client cancels it:

```typescript
vi.useFakeTimers();
let resolveReadStarted!: () => void;
const readStarted = new Promise<void>((resolve) => {
  resolveReadStarted = resolve;
});
let resolveBodyProcessingFinished!: () => void;
const bodyProcessingFinished = new Promise<void>((resolve) => {
  resolveBodyProcessingFinished = resolve;
});
let cancelled = false;
const stalled = new ReadableStream<Uint8Array>({
  pull() {
    resolveReadStarted();
    return new Promise<never>(() => {});
  },
  cancel() {
    cancelled = true;
    resolveBodyProcessingFinished();
  },
});
const fetchImpl = vi.fn(async () => new Response(stalled, {
  status: 200,
  headers: { "content-type": "application/json" },
}));

const outcomePromise = tokenizeWithDeno({
  endpoint: "https://tokenizer.example/v1/tokenize",
  authToken: "test-secret",
  timeoutMs: 50,
  inputText: "hello",
  fetchImpl,
});
await readStarted;
await vi.advanceTimersByTimeAsync(50);
await expect(outcomePromise).resolves.toEqual({
  kind: "unavailable",
  failureCategory: "timeout",
});
expect(fetchImpl).toHaveBeenCalledTimes(1);
expect(cancelled).toBe(true);
await expect(bodyProcessingFinished).resolves.toBeUndefined();
```

The timeout result must resolve only after the in-progress body read has been
cancelled and the stream reports body-processing completion, so the test proves
that stalled body processing does not outlive the request.

- [ ] **Step 3: Implement one full-lifecycle timeout**

Create one `AbortController` and one timeout promise before `fetch`. Race the
complete operation, including bounded body read, JSON parse, and schema
validation, against the timeout promise. On expiry, abort the controller and
cancel the active response reader before resolving as `timeout`. Await reader
cancellation so a stalled body read cannot outlive the request. Clear the timer
only after the race settles.

Set `redirect: "error"`. Never loop or call `fetch` recursively. Read at most
1 KiB from the response stream, cancel on overflow, and accept only an object
with exactly one safe, non-negative integer `baseTokenCount` field.

- [ ] **Step 4: Verify the HTTP client**

Run:

```bash
npm test -w apps/gateway-worker -- deno-tokenizer-client.test.ts
npm run typecheck -w apps/gateway-worker
```

Expected: all paths make at most one fetch and the stalled body terminates at
the configured timeout.

- [ ] **Step 5: Optional commit checkpoint**

Only after explicit user authorization:

```bash
git add apps/gateway-worker/src/deno-tokenizer-client.ts \
  apps/gateway-worker/test/deno-tokenizer-client.test.ts
git commit -m "feat(gateway): Deno tokenizer client を追加"
```

### Task 6: Route tokenization without changing quota semantics

**Files:**

- Create: `apps/gateway-worker/src/tokenization.ts`
- Create: `apps/gateway-worker/test/deno-tokenizer-routing.test.ts`
- Modify: `apps/gateway-worker/src/proxy.ts`
- Modify: `apps/gateway-worker/test/tokenizer-integration.test.ts`
- Modify: `apps/gateway-worker/test/tokenizer-74k-regression.test.ts`

**Interfaces:**

```typescript
export type TokenizationProvider = "cloudflare_do" | "deno";

export type RoutedTokenizationOutcome =
  | {
      readonly kind: "resolved";
      readonly provider: TokenizationProvider;
      readonly result: TokenizeResult;
    }
  | {
      readonly kind: "request_too_large";
      readonly provider: "cloudflare_do";
    }
  | {
      readonly kind: "unavailable";
      readonly provider: TokenizationProvider;
      readonly failureCategory?:
        | DenoTokenizationFailure
        | "arithmetic";
    };
```

- [ ] **Step 1: Write routing-boundary tests for both endpoints**

Use `it.each` over chat and responses and UTF-8 inputs whose byte lengths are
one below, equal to, and one above a configured threshold. Assert:

```typescript
expect(denoCalls).toBe(inputTextBytes >= threshold ? 1 : 0);
expect(doCalls).toBe(inputTextBytes < threshold ? 1 : 0);
```

For Deno success with `baseTokenCount: 2`, `messageCount: 1`, and
`opaqueInputBytes: 11`, assert the resulting estimate is `20` and the existing
reservation math consumes opaque bytes only once.

- [ ] **Step 2: Add disabled and invalid configuration integration tests**

With all Deno values absent, assert the real `TokenizerController` path remains
unchanged. With each partial configuration, send authenticated chat and
responses requests and assert generic `500`, unchanged quota state, no Deno
fetch, no DO tokenize RPC, and no upstream fetch. Send the same requests
without authentication and assert the existing `401` still wins.

- [ ] **Step 3: Implement the concrete router**

For disabled config or `inputTextBytes < threshold`, map the existing
`tokenizeInput` result and preserve its `work_limit` behavior. Otherwise call
`tokenizeWithDeno` once. On Deno success, call:

```typescript
const estimatedInputTokens = estimatedInputTokensOf({
  baseTokenCount: outcome.baseTokenCount,
  messageCount: request.messageCount,
  opaqueInputBytes: request.opaqueInputBytes,
});
```

Map `RangeError` to Deno `arithmetic` failure. Return `estimationPath` as
`exact_bpe`. Do not invoke the DO after entering the Deno branch.

- [ ] **Step 4: Replace only the proxy tokenization call site**

After authentication, resolve Deno configuration and fail invalid config before
body read. Keep normalization, model/policy resolution, and
`QuotaController.getState()` in their existing order. Replace the call at the
current tokenization boundary, leaving token-budget and reservation code below
it unchanged.

- [ ] **Step 5: Verify routing and the existing quota lifecycle**

Run:

```bash
npm test -w apps/gateway-worker -- \
  deno-tokenizer-routing.test.ts tokenizer-integration.test.ts \
  tokenizer-74k-regression.test.ts quota-lifecycle.test.ts
npm run typecheck -w apps/gateway-worker
```

Expected: both endpoints route by `inputTextBytes`; existing Cloudflare-only and
quota behavior remains green.

- [ ] **Step 6: Optional commit checkpoint**

Only after explicit user authorization:

```bash
git add apps/gateway-worker/src/tokenization.ts \
  apps/gateway-worker/src/proxy.ts apps/gateway-worker/test
git commit -m "feat(gateway): 大型入力を Deno tokenizer へ経路制御"
```

### Task 7: Complete fail-closed observability

**Files:**

- Modify: `apps/gateway-worker/src/resource-observation.ts`
- Modify: `apps/gateway-worker/src/proxy.ts`
- Modify: `apps/gateway-worker/test/resource-observation.test.ts`
- Create: `apps/gateway-worker/test/deno-tokenizer-failures.test.ts`

**Interfaces:**

```typescript
export type TokenizationFailureCategory =
  | "configuration"
  | "timeout"
  | "network"
  | "upstream_status"
  | "malformed_response"
  | "arithmetic";
```

Add optional `tokenizationProvider` and `tokenizationFailureCategory` fields to
resource finish events and their allowlisted runtime serialization.

- [ ] **Step 1: Write the allowlist test before changing event types**

Extend the existing resource observation test with a Deno timeout event and
untrusted extra fields. Expect only:

```typescript
expect(info).toHaveBeenCalledWith(expect.objectContaining({
  stage: "tokenize",
  phase: "finish",
  outcome: "exception",
  tokenizationProvider: "deno",
  tokenizationFailureCategory: "timeout",
  quotaReserved: false,
  upstreamReached: false,
}));
```

Assert serialized output excludes prompt text, Bearer secret, and exception
message.

- [ ] **Step 2: Write the full Deno failure matrix**

For timeout, stalled 200 body, network rejection, 500, malformed JSON, invalid
count, and arithmetic overflow, assert:

- response is existing generic `500 / api_error / internal_error`;
- Deno fetch count is exactly one;
- DO tokenize count is zero;
- quota state is unchanged;
- no `quota_reserve` or `upstream` resource stage is emitted;
- the finish event has provider `deno`, the exact category, input byte sizes,
  duration, `quotaReserved: false`, and `upstreamReached: false`.

- [ ] **Step 3: Emit provider and failure category at the proxy boundary**

Add both fields to `ResourceStageEventBase`, `ResourceStageFields`, and
`emitResourceStage`. On DO success or failure, emit `cloudflare_do`. On Deno
success or failure, emit `deno`. Use only the fixed category union and never
serialize caught values.

For invalid config before body read, emit a tokenize finish event with provider
`deno`, category `configuration`, and false quota/upstream flags; omit byte
fields because the body was intentionally not read.

- [ ] **Step 4: Verify all fail-closed paths**

Run:

```bash
npm test -w apps/gateway-worker -- \
  deno-tokenizer-failures.test.ts resource-observation.test.ts \
  proxy-failures.test.ts
```

Expected: all failure categories are distinguishable internally while the
public error remains unchanged.

- [ ] **Step 5: Optional commit checkpoint**

Only after explicit user authorization:

```bash
git add apps/gateway-worker/src/resource-observation.ts \
  apps/gateway-worker/src/proxy.ts \
  apps/gateway-worker/test/resource-observation.test.ts \
  apps/gateway-worker/test/deno-tokenizer-failures.test.ts
git commit -m "feat(observability): tokenizer provider と失敗分類を記録"
```

### Task 8: Document deployment, operations, and canary acceptance

**Files:**

- Create: `docs/deno-tokenizer.md`
- Modify: `README.md`
- Modify: `SPEC.md`
- Modify: `docs/DEPLOY_FROM_TEMPLATE.md`

**Interfaces:**

- Consumes: the final configuration names and existing
  `scripts/canary-worker-resource-limits.mjs`.
- Produces: a reproducible Free-plan deployment and canary runbook.

- [ ] **Step 1: Write the Deno deployment runbook**

Document both dashboard and `deno deploy` workflows. The Deno Deploy source is
the OCTG repository with app directory `apps/deno-tokenizer` and dynamic
entrypoint `src/main.ts`. Include these exact settings:

```text
Deno application:
  OCTG_TOKENIZER_AUTH_TOKEN = secret
  MAX_INPUT_BYTES = same raw value as the matching Gateway

Gateway Worker:
  DENO_TOKENIZER_ENDPOINT = https://.../v1/tokenize
  DENO_TOKENIZER_AUTH_TOKEN = matching Worker secret
  DENO_TOKENIZER_THRESHOLD_BYTES = measured positive integer
  DENO_TOKENIZER_TIMEOUT_MS = measured positive integer
```

Explain disabled, partial, invalid, timeout, no-retry, no-fallback, Free-plan
exhaustion, secret rotation, rollback order, and Production/Preview separation.
State that Deno runtime and Gateway resolve `MAX_INPUT_BYTES` through the same
shared helper and show how to compare their configured raw values before deploy.

- [ ] **Step 2: Update architecture and normative specification**

In `README.md`, show the branch from Gateway to DO or Deno and link the runbook.
In `SPEC.md`:

- update section 5.4 with `inputTextBytes` routing and Deno base-only output;
- retain the existing DO conservative fallback only for the DO path;
- replace section 16.2's proposed BPE cutoff as the selected CPU mitigation
  with the opt-in Deno design;
- preserve sections 16.3 and 16.4 as independently conditional future work;
- add `apps/deno-tokenizer` to the repository tree and acceptance mapping.

In `DEPLOY_FROM_TEMPLATE.md`, make Deno explicitly optional and link to the
full runbook rather than adding partial Deno values to default setup.

- [ ] **Step 3: Document threshold, timeout, and target concurrency evidence**

Use the existing canary script. Provide commands requiring the operator to
supply a previously validated 74k payload and measured concurrency values:

```bash
printf 'Canary client key: '
read -r -s OCTG_CANARY_CLIENT_KEY
printf '\n'
OCTG_CANARY_URL="https://<gateway>/v1/chat/completions" \
OCTG_CANARY_ALLOWED_HOSTS="<gateway-host>" \
OCTG_CANARY_CLIENT_KEY="$OCTG_CANARY_CLIENT_KEY" \
CANARY_PAYLOAD_PATH="<74k-payload.json>" \
CANARY_CONCURRENCY="1,2,<observed-maximum>" \
CANARY_REQUEST_TIMEOUT_MS="<measured-wall-time-bound>" \
node scripts/canary-worker-resource-limits.mjs
unset OCTG_CANARY_CLIENT_KEY
```

Require correlation of each request ID and revision with provider `deno`,
tokenization duration, quota reservation, upstream arrival, and absence of
Cloudflare `exceededCpu`. Do not claim a fixed threshold, timeout, or target
concurrency in source.

- [ ] **Step 4: Validate all documentation**

Run:

```bash
npm exec markdownlint-cli2 -- README.md SPEC.md \
  docs/DEPLOY_FROM_TEMPLATE.md docs/deno-tokenizer.md \
  docs/superpowers/specs/2026-08-27-deno-tokenizer-design.md \
  docs/superpowers/plans/2026-08-27-deno-tokenizer.md
```

Expected: zero Markdown issues.

- [ ] **Step 5: Optional commit checkpoint**

Only after explicit user authorization:

```bash
git add README.md SPEC.md docs
git commit -m "docs: Deno tokenizer の導入手順を追加"
```

### Task 9: Run full verification and manual QA

**Files:**

- Verify only; fix failures in the task that owns the affected file.

**Interfaces:**

- Consumes: all prior tasks.
- Produces: local HTTP evidence and a deployment-ready canary checklist.

- [ ] **Step 1: Run all static and automated gates**

Run:

```bash
npm install
npm run typecheck
npm test
npm run test:ci-smoke
npm run test:preview-workflow
```

Expected: all commands exit 0. Confirm that root workspace execution includes
`@octg/deno-tokenizer` tests and typecheck.

- [ ] **Step 2: Manually exercise the Deno HTTP surface**

Start `apps/deno-tokenizer/src/main.ts` in tmux with test-only environment
values. Use `curl` for:

- `GET /v1/tokenize` -> `405`;
- unauthenticated `POST /v1/tokenize` -> `401`;
- malformed authenticated JSON -> `400`;
- authenticated valid text -> `200` with only `baseTokenCount`;
- input exactly at the configured UTF-8 ceiling -> accepted;
- one byte above -> `413`.

Inspect process output and confirm no prompt or credential was logged.

- [ ] **Step 3: Manually exercise Gateway routing**

Start the local Deno service and Gateway Worker in tmux. Configure a small test
threshold and send authenticated chat and responses requests below, equal to,
and above it. Confirm DO/Deno selection in resource events and successful quota
settlement. Stop Deno and repeat an above-threshold request; confirm one generic
500, no reservation, and no upstream access.

- [ ] **Step 4: Verify stalled-body timeout through the running Gateway**

Run a local test server that returns HTTP 200 headers and never closes its body.
Point `DENO_TOKENIZER_ENDPOINT` to it and confirm the Gateway returns generic
500 within `DENO_TOKENIZER_TIMEOUT_MS` plus scheduler tolerance. Confirm the
resource event category is `timeout` and quota/upstream flags are false.

- [ ] **Step 5: Perform the Deno Deploy compatibility gate**

Deploy the Deno application to separate Preview and Production applications on
the Free plan. Repeat authenticated and unauthenticated HTTP checks against each
endpoint. If the pinned lite/WASM package cannot load in Deno Deploy, stop the
rollout and report the compatibility failure; do not silently switch libraries
or introduce an approximate tokenizer.

- [ ] **Step 6: Run the measured 74k canary**

After operators provide threshold, timeout, and observed target concurrency,
run the documented canary. Acceptance requires exact count parity, Deno success
at target concurrency, no Cloudflare `exceededCpu`, unchanged quota lifecycle,
and unchanged OpenAI-compatible responses.

- [ ] **Step 7: Optional final commit checkpoint**

Only after explicit user authorization and after inspecting intended changes:

```bash
git add package-lock.json apps/deno-tokenizer apps/gateway-worker \
  durable-objects/tokenizer-controller packages/shared README.md SPEC.md docs
git commit -m "feat: 大型入力の tokenization を Deno Deploy へ外部化"
```
