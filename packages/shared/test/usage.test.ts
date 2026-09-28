import { describe, expect, it } from "vitest";
import { extractUsageFromEvent } from "../src/usage";

describe("extractUsageFromEvent", () => {
  it("extracts usage totals while ignoring usage-like text inside strings", () => {
    const event = 'data: {"type":"response.completed","note":"\\\"usage\\\": {}", "response":{"usage":{"input_tokens":10,"output_tokens":20,"total_tokens":30}}}';

    expect(extractUsageFromEvent(event)).toEqual({
      input_tokens: 10,
      output_tokens: 20,
      total_tokens: 30,
    });
  });

  it("returns undefined when usage is not a valid object", () => {
    expect(extractUsageFromEvent('data: {"response":{"usage":null}}')).toBeUndefined();
  });
});
