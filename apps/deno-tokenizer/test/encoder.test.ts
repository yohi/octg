import { assertEquals } from "jsr:@std/assert@1";
import golden from "../../../durable-objects/tokenizer-controller/test/fixtures/tokenization-golden.json" with {
  type: "json",
};
import { exactEncoder } from "../src/encoder.ts";

for (const testCase of golden.cases) {
  Deno.test(`exact parity: ${testCase.name}`, () => {
    const inputText = testCase.repeat === undefined
      ? testCase.inputText
      : testCase.inputText.repeat(testCase.repeat);
    const expectedBase = testCase.expected - testCase.opaqueInputBytes -
      (testCase.messageCount * 4) - 3;
    assertEquals(exactEncoder.count(inputText), expectedBase);
  });
}
