import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authenticate } from "../src/auth";
import { seedClient, TEST_CLIENT_ID, TEST_CLIENT_KEY } from "./seed";

const request = (authorization?: string) =>
  new Request("https://octg.test/v1/chat/completions", {
    method: "POST",
    headers: authorization ? { authorization } : {},
  });

describe("authenticate", () => {
  it("rejects missing authorization", async () => {
    await expect(authenticate(request(), env)).resolves.toMatchObject({ status: 401 });
  });

  it("rejects non-OCTG keys and unknown keys", async () => {
    await expect(authenticate(request("Bearer sk-proj-abc"), env)).resolves.toMatchObject({ status: 401 });
    await seedClient();
    await expect(authenticate(request("Bearer octg_sk_wrong"), env)).resolves.toMatchObject({ status: 401 });
  });

  it("rejects disabled clients", async () => {
    await seedClient({ enabled: false });
    await expect(authenticate(request(`Bearer ${TEST_CLIENT_KEY}`), env)).resolves.toMatchObject({
      status: 403,
      body: { error: { code: "client_disabled" } },
    });
  });

  it("returns the context for a valid client", async () => {
    await seedClient();
    await expect(authenticate(request(`Bearer ${TEST_CLIENT_KEY}`), env)).resolves.toEqual({
      id: TEST_CLIENT_ID,
      name: "Test Client",
    });
  });
});
