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

function invalidConfigValues(expectedMaxInputBytes: string | undefined): ReadonlyMap<string, string> {
  const values = new Map<string, string>([
    ["OCTG_TOKENIZER_AUTH_TOKEN", "test-secret"],
    ["MAX_INPUT_BYTES", "2"],
  ]);
  if (expectedMaxInputBytes !== undefined) {
    values.set("OCTG_EXPECTED_MAX_INPUT_BYTES", expectedMaxInputBytes);
  }
  return values;
}

const invalidExpectedMaxInputBytesCases = [
  { name: "when the expected value is missing", expected: undefined },
  { name: "when the expected value is non-numeric", expected: "not-a-number" },
  { name: "when the expected value does not match", expected: "3" },
] as const;

for (const testCase of invalidExpectedMaxInputBytesCases) {
  Deno.test(`fails closed ${testCase.name}`, () => {
    const values = invalidConfigValues(testCase.expected);

    assertThrows(
      () => resolveServiceConfig((name: string) => values.get(name)),
      TypeError,
      "Invalid Deno tokenizer configuration.",
    );
  });
}

Deno.test("succeeds when OCTG_EXPECTED_MAX_INPUT_BYTES matches the resolved default", () => {
  const values = new Map([
    ["OCTG_TOKENIZER_AUTH_TOKEN", "test-secret"],
    ["MAX_INPUT_BYTES", undefined],
    ["OCTG_EXPECTED_MAX_INPUT_BYTES", "1048576"],
  ]);

  const config = resolveServiceConfig((name: string) => values.get(name));
  assertEquals(config.maxInputBytes, 1048576);
});
