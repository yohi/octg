import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

const URL = "https://worker.example/internal/relay/v1/cpu-gate";
const CONTROL_TOKEN = "c".repeat(43);

beforeAll(() => {
  Object.assign(env, {
    OCTG_RELAY_ENABLED: "true",
    OCTG_RELAY_ENVIRONMENT: "preview",
    OCTG_RELAY_INGRESS_ENDPOINT: "https://relay.example/",
    OCTG_RELAY_INGRESS_AUTH_TOKEN: "i".repeat(32),
    OCTG_RELAY_SERVICE_AUTH_TOKEN: "s".repeat(32),
    OCTG_RELAY_CONTEXT_HMAC_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  });
});

describe("relay CPU-gate routes", () => {
  it("disables missing or service-equal control credentials before reading the body", async () => {
    const request = new Request(`${URL}/setup`, { method: "POST", body: "not-json" });
    const previous = env.OCTG_RELAY_CPU_GATE_AUTH_TOKEN;
    Reflect.deleteProperty(env, "OCTG_RELAY_CPU_GATE_AUTH_TOKEN");
    try {
      const response = await SELF.fetch(request);
      expect(response.status).toBe(404);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(env, "OCTG_RELAY_CPU_GATE_AUTH_TOKEN");
      else Object.assign(env, { OCTG_RELAY_CPU_GATE_AUTH_TOKEN: previous });
    }
  });

  it("requires the dedicated bearer before a route can parse a request", async () => {
    Object.assign(env, { OCTG_RELAY_CPU_GATE_AUTH_TOKEN: CONTROL_TOKEN });
    const response = await SELF.fetch(new Request(`${URL}/setup`, {
      method: "POST",
      headers: { Authorization: `Bearer ${"s".repeat(32)}` },
      body: "not-json",
    }));
    expect(response.status).toBe(401);
  });

  it("routes the CPU-gate prefix independently from lifecycle callback actions", async () => {
    Object.assign(env, { OCTG_RELAY_CPU_GATE_AUTH_TOKEN: CONTROL_TOKEN });
    const response = await SELF.fetch(new Request(`${URL}/unknown`, {
      method: "POST",
      headers: { Authorization: `Bearer ${CONTROL_TOKEN}` },
      body: "{}",
    }));
    expect(response.status).toBe(404);
  });
});
