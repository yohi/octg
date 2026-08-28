import { assertEquals } from "jsr:@std/assert@1";
import type { DenoTokenizerServiceConfig } from "../src/config.ts";
import type { ExactEncoder } from "../src/encoder.ts";
import { createTokenizerHandler } from "../src/http.ts";

const credential = "unique-credential-that-must-not-be-logged";
const prompt = "unique-prompt-that-must-not-be-logged";
const tokenizeUrl = "https://deno.test/v1/tokenize";

const config: DenoTokenizerServiceConfig = {
  authToken: credential,
  maxInputBytes: 128,
  maxRawBodyBytes: (6 * 128) + 16,
};

function request(args: {
  readonly body: string;
  readonly token: string;
}): Request {
  return new Request(tokenizeUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${args.token}`,
      "content-type": "application/json",
    },
    body: args.body,
  });
}

function includesSensitiveValue(
  args: readonly unknown[],
  value: string,
): boolean {
  return args.some((argument) => String(argument).includes(value));
}

Deno.test("does not log prompts or credentials from request handling", async () => {
  const captured: unknown[][] = [];
  const originalLog = console.log;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const originalError = console.error;
  const capture = (...args: unknown[]): void => {
    captured.push(args);
  };
  let shouldFail = false;
  const encoder: ExactEncoder = {
    count: () => {
      if (shouldFail) {
        throw new Error(`encoder failure: ${credential} ${prompt}`);
      }
      return 7;
    },
  };
  const handler = createTokenizerHandler({ config, encoder });

  console.log = capture;
  console.info = capture;
  console.warn = capture;
  console.error = capture;
  try {
    const success = await handler(request({
      body: JSON.stringify({ inputText: prompt }),
      token: credential,
    }));
    const authFailure = await handler(request({
      body: JSON.stringify({ inputText: prompt }),
      token: `wrong-${credential}`,
    }));
    const invalidInput = await handler(request({
      body: `{"inputText":${JSON.stringify(prompt)}`,
      token: credential,
    }));
    shouldFail = true;
    const encoderFailure = await handler(request({
      body: JSON.stringify({ inputText: prompt }),
      token: credential,
    }));

    assertEquals(success.status, 200);
    assertEquals(authFailure.status, 401);
    assertEquals(invalidInput.status, 400);
    assertEquals(encoderFailure.status, 500);
  } finally {
    console.log = originalLog;
    console.info = originalInfo;
    console.warn = originalWarn;
    console.error = originalError;
  }

  assertEquals(
    captured.some((args) => includesSensitiveValue(args, credential)),
    false,
  );
  assertEquals(
    captured.some((args) => includesSensitiveValue(args, prompt)),
    false,
  );
});
