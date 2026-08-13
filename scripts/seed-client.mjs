#!/usr/bin/env node
import { createHmac } from "node:crypto";

const [id, name, rawKey] = process.argv.slice(2);
if (!process.env.OCTG_KEY_PEPPER || !id || !name || !rawKey) {
  console.error("usage: OCTG_KEY_PEPPER=... npm run seed:client -- <id> <name> <octg_sk_...>");
  process.exit(1);
}
if (!rawKey.startsWith("octg_sk_")) {
  console.error("raw key must start with octg_sk_");
  process.exit(1);
}

const hash = createHmac("sha256", process.env.OCTG_KEY_PEPPER).update(rawKey).digest("hex");
const esc = (s) => s.replaceAll("'", "''");

console.log(
  `INSERT INTO clients (id, name, key_hash, enabled, created_at) VALUES ('${esc(id)}', '${esc(name)}', '${hash}', 1, datetime('now')) ` +
    "ON CONFLICT(id) DO UPDATE SET name=excluded.name, key_hash=excluded.key_hash, enabled=1;"
);
console.log(
  `INSERT INTO client_policies (client_id, overflow_mode, output_limit_mode, max_paid_usd_day, cache_enabled, tools_mode) VALUES ('${esc(id)}', 'REJECT', 'REJECT', 0, 0, 'REJECT') ` +
    "ON CONFLICT(client_id) DO NOTHING;"
);
