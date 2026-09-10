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
  const values = configValues();

  assertEquals(resolveServiceConfig((name: string) => values.get(name)), {
    authToken: "test-secret",
    maxInputBytes: 2,
    maxRawBodyBytes: 28,
  });
});

function configValues(
  overrides: Readonly<Record<string, string | undefined>> = {},
): ReadonlyMap<string, string> {
  const values = new Map<string, string>([
    ["OCTG_TOKENIZER_AUTH_TOKEN", "test-secret"],
    ["MAX_INPUT_BYTES", "2"],
    ["OCTG_EXPECTED_MAX_INPUT_BYTES", "2"],
  ]);

  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) values.delete(name);
    else values.set(name, value);
  }
  return values;
}

const invalidConfigCases: ReadonlyArray<{
  readonly name: string;
  readonly overrides: Readonly<Record<string, string | undefined>>;
}> = [
  {
    name: "when OCTG_EXPECTED_MAX_INPUT_BYTES is missing",
    overrides: { OCTG_EXPECTED_MAX_INPUT_BYTES: undefined },
  },
  {
    name: "when OCTG_EXPECTED_MAX_INPUT_BYTES is non-numeric",
    overrides: { OCTG_EXPECTED_MAX_INPUT_BYTES: "not-a-number" },
  },
  {
    name: "when OCTG_EXPECTED_MAX_INPUT_BYTES does not match MAX_INPUT_BYTES",
    overrides: { OCTG_EXPECTED_MAX_INPUT_BYTES: "3" },
  },
  {
    name: "when MAX_INPUT_BYTES is missing",
    overrides: { MAX_INPUT_BYTES: undefined },
  },
  {
    name: "when MAX_INPUT_BYTES is invalid",
    overrides: { MAX_INPUT_BYTES: "9007199254740992" },
  },
];

for (const testCase of invalidConfigCases) {
  Deno.test(`fails closed ${testCase.name}`, () => {
    assertThrows(
      () => resolveServiceConfig((name: string) => configValues(testCase.overrides).get(name)),
      TypeError,
      "Invalid Deno tokenizer configuration.",
    );
  });
}
