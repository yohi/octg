import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { resolveServiceConfig } from "../src/config.ts";

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
    ["OCTG_EXPECTED_MAX_INPUT_BYTES", "2"],
  ]);

  assertEquals(resolveServiceConfig((name: string) => values.get(name)), {
    authToken: "test-secret",
    maxInputBytes: 2,
    maxRawBodyBytes: 28,
  });
});

Deno.test("fails closed when OCTG_EXPECTED_MAX_INPUT_BYTES is missing", () => {
  const values = new Map([
    ["OCTG_TOKENIZER_AUTH_TOKEN", "test-secret"],
    ["MAX_INPUT_BYTES", "2"],
  ]);

  assertThrows(
    () => resolveServiceConfig((name: string) => values.get(name)),
    TypeError,
    "Invalid Deno tokenizer configuration.",
  );
});

Deno.test("fails closed when OCTG_EXPECTED_MAX_INPUT_BYTES is non-numeric", () => {
  const values = new Map([
    ["OCTG_TOKENIZER_AUTH_TOKEN", "test-secret"],
    ["MAX_INPUT_BYTES", "2"],
    ["OCTG_EXPECTED_MAX_INPUT_BYTES", "not-a-number"],
  ]);

  assertThrows(
    () => resolveServiceConfig((name: string) => values.get(name)),
    TypeError,
    "Invalid Deno tokenizer configuration.",
  );
});

Deno.test("fails closed when OCTG_EXPECTED_MAX_INPUT_BYTES does not match MAX_INPUT_BYTES", () => {
  const values = new Map([
    ["OCTG_TOKENIZER_AUTH_TOKEN", "test-secret"],
    ["MAX_INPUT_BYTES", "2"],
    ["OCTG_EXPECTED_MAX_INPUT_BYTES", "3"],
  ]);

  assertThrows(
    () => resolveServiceConfig((name: string) => values.get(name)),
    TypeError,
    "Invalid Deno tokenizer configuration.",
  );
});

Deno.test("succeeds when OCTG_EXPECTED_MAX_INPUT_BYTES matches the resolved default", () => {
  const values = new Map([
    ["OCTG_TOKENIZER_AUTH_TOKEN", "test-secret"],
    ["MAX_INPUT_BYTES", undefined],
    ["OCTG_EXPECTED_MAX_INPUT_BYTES", "1048576"],
  ]);

  const config = resolveServiceConfig((name: string) => values.get(name));
  assertEquals(config.maxInputBytes, 1048576);
});