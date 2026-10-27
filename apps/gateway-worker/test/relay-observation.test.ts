import { afterEach, describe, expect, it, vi } from "vitest";
import { emitRelayInvocation } from "../src/relay-observation";

describe("emitRelayInvocation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("emits only safe marker fields for a finished invocation", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    emitRelayInvocation({ invocationClass: "decision", revisionId: "rev-1", phase: "finish", outcome: "success" });
    expect(info).toHaveBeenCalledWith({
      event: "octg.relay_invocation",
      invocationClass: "decision",
      revisionId: "rev-1",
      phase: "finish",
      outcome: "success",
    });
  });
});
