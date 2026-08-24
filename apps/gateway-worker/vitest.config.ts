import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("../../db/migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          assets: {
            directory: "./public",
            binding: "TEST_STATIC_ASSETS"
          },
          bindings: {
            OCTG_KEY_PEPPER: "test-pepper",
            OCTG_UPSTREAM_API_TOKEN: "test-upstream-token",
            OCTG_UPSTREAM_BASE_URL: "https://aigw.invalid/openai",
            TEST_MIGRATIONS: migrations
          },
          serviceBindings: {
            ASSETS: (request: Request) => {
              const isEntrypoint = new URL(request.url).pathname === "/admin/ui/";
              return new Response(isEntrypoint ? "<title>OCTG Admin</title>" : "asset", {
                headers: {
                  "content-type": isEntrypoint
                    ? "text/html; charset=utf-8"
                    : "text/plain; charset=utf-8",
                },
              });
            },
          }
        }
      })
    ],
    test: {
      include: [
        "./test/**/*.test.ts",
        "../../durable-objects/quota-controller/test/**/*.test.ts",
        "../../durable-objects/tokenizer-controller/test/**/*.test.ts",
      ],
      setupFiles: ["./test/setup.ts"]
    }
  };
});
