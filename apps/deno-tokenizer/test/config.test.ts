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
  ]);

  assertEquals(resolveServiceConfig((name: string) => values.get(name)), {
    authToken: "test-secret",
    maxInputBytes: 2,
    maxRawBodyBytes: 28,
  });
});
