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

const invalidConfigCases: ReadonlyArray<{
  readonly name: string;
  readonly values: ReadonlyMap<string, string>;
}> = [
  {
    name: "when OCTG_EXPECTED_MAX_INPUT_BYTES is missing",
    values: new Map([
      ["OCTG_TOKENIZER_AUTH_TOKEN", "test-secret"],
      ["MAX_INPUT_BYTES", "2"],
    ]),
  },
  {
    name: "when OCTG_EXPECTED_MAX_INPUT_BYTES is non-numeric",
    values: new Map([
      ["OCTG_TOKENIZER_AUTH_TOKEN", "test-secret"],
      ["MAX_INPUT_BYTES", "2"],
      ["OCTG_EXPECTED_MAX_INPUT_BYTES", "not-a-number"],
    ]),
  },
  {
    name: "when OCTG_EXPECTED_MAX_INPUT_BYTES does not match MAX_INPUT_BYTES",
    values: new Map([
      ["OCTG_TOKENIZER_AUTH_TOKEN", "test-secret"],
      ["MAX_INPUT_BYTES", "2"],
      ["OCTG_EXPECTED_MAX_INPUT_BYTES", "3"],
    ]),
  },
  {
    name: "when MAX_INPUT_BYTES is missing",
    values: new Map([
      ["OCTG_TOKENIZER_AUTH_TOKEN", "test-secret"],
      ["OCTG_EXPECTED_MAX_INPUT_BYTES", "1048576"],
    ]),
  },
  {
    name: "when MAX_INPUT_BYTES is invalid",
    values: new Map([
      ["OCTG_TOKENIZER_AUTH_TOKEN", "test-secret"],
      ["MAX_INPUT_BYTES", "9007199254740992"],
      ["OCTG_EXPECTED_MAX_INPUT_BYTES", "9007199254740992"],
    ]),
  },
];

for (const testCase of invalidConfigCases) {
  Deno.test(`fails closed ${testCase.name}`, () => {
    assertThrows(
      () => resolveServiceConfig((name: string) => testCase.values.get(name)),
      TypeError,
      "Invalid Deno tokenizer configuration.",
    );
  });
}
