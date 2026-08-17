import { env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { seedClient, TEST_CLIENT_ID } from "./seed";

let privateKey: CryptoKey;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey as CryptoKey;
  Object.assign(env, { ACCESS_JWT_PUBLIC_JWK: JSON.stringify({ keys: [await exportJWK(pair.publicKey)] }), ACCESS_AUD: "test-aud", ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com" });
});
beforeEach(async () => seedClient());
const token = () => new SignJWT({ sub: "admin@example.com" }).setProtectedHeader({ alg: "RS256" }).setIssuer("https://team.cloudflareaccess.com").setAudience("test-aud").setExpirationTime("10m").sign(privateKey);
const admin = async (path: string, init: RequestInit) => {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  headers.set("cf-access-jwt-assertion", await token());
  return SELF.fetch(`https://octg.test${path}`, { ...init, headers });
};

describe("admin reconciliation concurrency", () => {
  it("keeps D1 aligned with the canonical disposition under opposite concurrent requests", async () => {
    // Given: one uncertain reserve-unknown request with a pending D1 projection.
    const day = "2026-11-08";
    const requestId = "admin-reserve-unknown-concurrent-dispositions";
    const controller = env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${day}`));
    await controller.reserve(requestId, 200, 200);
    await controller.markReserveOutcomeUnknown(requestId);
    await env.DB.prepare(
      "INSERT INTO requests (request_id, utc_day, client_id, pool, reserved_tokens, total_tokens, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(requestId, day, TEST_CLIENT_ID, "STANDARD", 200, 0, "uncertain", new Date().toISOString()).run();

    // When: consumed and unused dispositions race through the Admin API.
    const [consumed, unused] = await Promise.all([
      admin(`/admin/reconcile/STANDARD/${day}/${requestId}`, {
        method: "POST",
        body: JSON.stringify({ disposition: "consumed" }),
      }),
      admin(`/admin/reconcile/STANDARD/${day}/${requestId}`, {
        method: "POST",
        body: JSON.stringify({ disposition: "unused", evidence: "operator-confirmed" }),
      }),
    ]);
    const expected = consumed.status === 200
      ? { state: "reconciled", requestedDisposition: "consumed", projection: { status: "completed", total_tokens: 200, billing_class: "free" } }
      : { state: "released", requestedDisposition: "unused", projection: { status: "failed", total_tokens: 0, billing_class: "none" } };

    // Then: only one disposition succeeds and D1 agrees with the authoritative DO view.
    expect([consumed.status, unused.status].sort()).toEqual([200, 409]);
    expect(await controller.getReconcileRequest(requestId)).toMatchObject({
      state: expected.state,
      requestedDisposition: expected.requestedDisposition,
    });
    expect(
      await env.DB.prepare("SELECT status, total_tokens, billing_class FROM requests WHERE request_id = ?")
        .bind(requestId)
        .first<{ status: string; total_tokens: number; billing_class: string }>(),
    ).toEqual(expected.projection);
  });

  it("rejects a reconciled upstream-uncertain request from the manual route", async () => {
    // Given: an upstream-uncertain request already reconciled as consumed by the DO.
    const day = "2026-11-09";
    const requestId = "admin-upstream-uncertain-replay";
    const controller = env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${day}`));
    await controller.reserve(requestId, 200, 200);
    await controller.markUncertain(requestId);
    await controller.reconcileRequest(requestId, "consumed");
    await env.DB.prepare(
      "INSERT INTO requests (request_id, utc_day, client_id, pool, reserved_tokens, total_tokens, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(requestId, day, TEST_CLIENT_ID, "STANDARD", 200, 0, "uncertain", new Date().toISOString()).run();

    // When: an operator submits the matching disposition through the reserve-unknown route.
    const response = await admin(`/admin/reconcile/STANDARD/${day}/${requestId}`, {
      method: "POST",
      body: JSON.stringify({ disposition: "consumed" }),
    });

    // Then: the route rejects it and leaves the D1 projection untouched.
    expect(response.status).toBe(409);
    expect(
      await env.DB.prepare("SELECT status, total_tokens FROM requests WHERE request_id = ?")
        .bind(requestId)
        .first<{ status: string; total_tokens: number }>(),
    ).toEqual({ status: "uncertain", total_tokens: 0 });
  });
});
