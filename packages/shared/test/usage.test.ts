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

  it("extracts usage from indented multiline JSON", () => {
    const event = `{
      "type": "response.completed",
      "response": {
        "usage": {
          "input_tokens": 12,
          "output_tokens": 8,
          "total_tokens": 20
        }
      }
    }`;

    expect(extractUsageFromEvent(event)).toEqual({ input_tokens: 12, output_tokens: 8, total_tokens: 20 });
  });

  it("extracts usage from multiline SSE data fields", () => {
    const event = [
      "data: {",
      'data:  "type": "response.completed",',
      'data:  "response": { "usage": { "total_tokens": 20 } }',
      "data: }",
    ].join("\n");

    expect(extractUsageFromEvent(event)).toEqual({ total_tokens: 20 });
  });

  it("extracts a balanced usage object from surrounding non-JSON text", () => {
    const event = 'event: response.completed\ndata: prefix {"usage":{"total_tokens":20,"note":"} inside text"}} suffix';

    expect(extractUsageFromEvent(event)).toEqual({ total_tokens: 20, note: "} inside text" });
  });
});
