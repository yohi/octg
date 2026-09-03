import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";

const DENO_SETTING_NAMES = [
  "DENO_TOKENIZER_ENDPOINT",
  "DENO_TOKENIZER_AUTH_TOKEN",
  "DENO_TOKENIZER_THRESHOLD_BYTES",
  "DENO_TOKENIZER_TIMEOUT_MS",
] as const;

for (const name of DENO_SETTING_NAMES) Reflect.deleteProperty(env, name);

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
