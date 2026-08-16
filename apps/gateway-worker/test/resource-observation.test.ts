import { describe, expect, it, vi } from "vitest";
import {
  emitResourceStage,
  type ResourceStageEvent,
} from "../src/resource-observation";

const baseEvent = {
  event: "octg.resource_stage" as const,
  requestId: "req_test",
  revisionId: "version_test",
  stage: "tokenize" as const,
  route: "free_shared" as const,
};

describe("resource stage event contract", () => {
  it("emits only the typed primitive event object", () => {
    const event: ResourceStageEvent = {
      ...baseEvent,
      phase: "finish",
      durationMs: 12,
      outcome: "success",
      inputBytes: 120,
      inputTextBytes: 100,
      opaqueInputBytes: 20,
      estimationPath: "exact_bpe",
      quotaReserved: true,
      upstreamReached: false,
    };
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    emitResourceStage(event);

    expect(info).toHaveBeenCalledWith(event);
    expect(JSON.stringify(info.mock.calls[0]?.[0])).not.toContain("payload");
  });

  it("allows a start event without finish-only fields", () => {
    const event: ResourceStageEvent = {
      ...baseEvent,
      phase: "start",
      rawBodyBytes: 64,
      rawBodyBytesSource: "measured",
      rawBodyTruncated: false,
    };

    expect(() => emitResourceStage(event)).not.toThrow();
  });
});
