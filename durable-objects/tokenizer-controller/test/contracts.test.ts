import { describe, expect, it } from "vitest";
import {
  MAX_INPUT_TEXT_BYTES,
  MAX_REQUEST_ID_BYTES,
  parseTokenizeRequest,
  type TokenizeRequest,
} from "../src/contracts";

const valid = {
  requestId: "req_contract",
  inputText: "hello",
  messageCount: 1,
  opaqueInputBytes: 0,
} satisfies TokenizeRequest;

describe("parseTokenizeRequest", () => {
  it("accepts a valid request without changing its values", () => {
    expect(parseTokenizeRequest(valid)).toEqual(valid);
  });

  it.each([
    null,
    [],
    { ...valid, requestId: "" },
    { ...valid, inputText: 1 },
    { ...valid, messageCount: -1 },
    { ...valid, messageCount: 1.5 },
    { ...valid, messageCount: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, opaqueInputBytes: -1 },
    { ...valid, opaqueInputBytes: 1.5 },
    { ...valid, opaqueInputBytes: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects invalid request %#", (value) => {
    expect(() => parseTokenizeRequest(value)).toThrow(TypeError);
  });

  it("accepts inputText at exactly MAX_INPUT_TEXT_BYTES", () => {
    expect(() => parseTokenizeRequest({
      ...valid,
      inputText: "x".repeat(MAX_INPUT_TEXT_BYTES),
    })).not.toThrow();
  });

  it("rejects inputText one byte over MAX_INPUT_TEXT_BYTES", () => {
    expect(() => parseTokenizeRequest({
      ...valid,
      inputText: "x".repeat(MAX_INPUT_TEXT_BYTES + 1),
    })).toThrow(TypeError);
  });

  it("accepts requestId at exactly MAX_REQUEST_ID_BYTES", () => {
    expect(() => parseTokenizeRequest({
      ...valid,
      requestId: "r".repeat(MAX_REQUEST_ID_BYTES),
    })).not.toThrow();
  });

  it("rejects requestId one byte over MAX_REQUEST_ID_BYTES", () => {
    expect(() => parseTokenizeRequest({
      ...valid,
      requestId: "r".repeat(MAX_REQUEST_ID_BYTES + 1),
    })).toThrow(TypeError);
  });
});
