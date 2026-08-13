import { env } from "cloudflare:test";
import { hashClientKey } from "../src/crypto";

export const TEST_CLIENT_KEY = "octg_sk_testclient01";
export const TEST_CLIENT_ID = "client_test";

export async function seedClient(options?: { enabled?: boolean }): Promise<void> {
  const keyHash = await hashClientKey(TEST_CLIENT_KEY, env.OCTG_KEY_PEPPER);
  await env.DB.prepare(
    "INSERT INTO clients (id, name, key_hash, enabled, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET key_hash=excluded.key_hash, enabled=excluded.enabled",
  )
    .bind(TEST_CLIENT_ID, "Test Client", keyHash, options?.enabled === false ? 0 : 1, new Date().toISOString())
    .run();
}

export async function seedPolicy(
  clientId: string,
  policy: {
    overflowMode?: string;
    outputLimitMode?: string;
    maxPaidUsdDay?: number;
    cacheEnabled?: boolean;
    toolsMode?: string;
  },
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO client_policies (client_id, overflow_mode, output_limit_mode, max_paid_usd_day, cache_enabled, tools_mode) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(client_id) DO UPDATE SET overflow_mode=excluded.overflow_mode, output_limit_mode=excluded.output_limit_mode, max_paid_usd_day=excluded.max_paid_usd_day, cache_enabled=excluded.cache_enabled, tools_mode=excluded.tools_mode",
  )
    .bind(
      clientId,
      policy.overflowMode ?? "REJECT",
      policy.outputLimitMode ?? "REJECT",
      policy.maxPaidUsdDay ?? 0,
      policy.cacheEnabled ? 1 : 0,
      policy.toolsMode ?? "REJECT",
    )
    .run();
}
