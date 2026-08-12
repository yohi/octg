import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("../../db/migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            OCTG_KEY_PEPPER: "test-pepper",
            OCTG_UPSTREAM_API_TOKEN: "test-upstream-token",
            OCTG_UPSTREAM_BASE_URL: "https://aigw.invalid",
            TEST_MIGRATIONS: migrations
          }
        }
      })
    ],
    test: {
      include: [
        "./test/**/*.test.ts",
        "../../durable-objects/quota-controller/test/**/*.test.ts",
      ],
      setupFiles: ["./test/setup.ts"]
    }
  };
});
