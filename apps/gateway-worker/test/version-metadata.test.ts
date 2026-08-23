import { describe, expect, it } from "vitest";
import { workerVersionHeaders } from "../src/version-metadata";

describe("worker version response headers", () => {
  it("exposes the deployed version ID", () => {
    const versionId = "11111111-2222-3333-4444-555555555555";

    expect(workerVersionHeaders({ id: versionId })).toEqual({
      "X-OCTG-Worker-Version": versionId,
    });
  });

  it("uses a local marker when version metadata is unavailable", () => {
    expect(workerVersionHeaders(undefined)).toEqual({
      "X-OCTG-Worker-Version": "local",
    });
  });
});
