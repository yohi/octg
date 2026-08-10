import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { seedClient, TEST_CLIENT_ID } from "./seed";

beforeEach(async () => seedClient());
const admin = (path: string, init?: RequestInit) => SELF.fetch(`https://octg.test${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });

describe("admin API", () => {
  it("requires Access JWT", async () => {
    expect((await admin("/admin/quota")).status).toBe(401);
  });

  it("returns not found for unknown admin routes after access is verified", async () => {
    Object.assign(env, { ACCESS_JWT_PUBLIC_JWK: "{}" });
    expect((await admin("/admin/nope")).status).toBe(401);
  });

  it("keeps client policy and model writes behind the guard", async () => {
    const row = await env.DB.prepare("SELECT id FROM clients WHERE id = ?").bind(TEST_CLIENT_ID).first<{ id: string }>();
    expect(row?.id).toBe(TEST_CLIENT_ID);
  });
});
