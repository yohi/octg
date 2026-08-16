import { afterEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits only allowlisted primitive event fields", () => {
    const event = Object.assign(
      {
        ...baseEvent,
        phase: "finish" as const,
        durationMs: 12,
        outcome: "success" as const,
        inputBytes: 120,
        inputTextBytes: 100,
        opaqueInputBytes: 20,
        estimationPath: "exact_bpe" as const,
        quotaReserved: true,
        upstreamReached: false,
      } satisfies ResourceStageEvent,
      {
        payload: "secret payload",
        headers: { authorization: "Bearer secret" },
        authenticationMaterial: "secret key",
        exception: "secret exception",
        extra: "must not be logged",
      },
    );
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    emitResourceStage(event);

    expect(info).toHaveBeenCalledWith({
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
    });
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
