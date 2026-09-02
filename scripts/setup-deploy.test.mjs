import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  buildCloudflareEnv,
  resolveDeployConfig,
  validateProvidedDeploySecrets,
} from "./setup-deploy.mjs";

test("resolves prompted deploy configuration values", async () => {
  const prompted = [];
  const values = await resolveDeployConfig(
    {
      CLOUDFLARE_ACCOUNT_ID: "account-123",
      OCTG_DATABASE_ID: "",
      OCTG_UPSTREAM_BASE_URL: "https://gateway.example/openai",
      ACCESS_TEAM_DOMAIN: "",
      ACCESS_AUD: "aud-123",
    },
    { accountId: "", databaseId: "", upstream: "", teamDomain: "", audience: "" },
    async (name) => {
      prompted.push(name);
      return {
        OCTG_DATABASE_ID: "database-123",
        ACCESS_TEAM_DOMAIN: "https://team.example",
      }[name] ?? "";
    },
  );

  assert.deepEqual(values, {
    accountId: "account-123",
    databaseId: "database-123",
    upstream: "https://gateway.example/openai",
    teamDomain: "https://team.example",
    audience: "aud-123",
  });
  assert.deepEqual(prompted, ["OCTG_DATABASE_ID", "ACCESS_TEAM_DOMAIN"]);
});

test("builds Wrangler environment without exposing absent credentials", () => {
  assert.deepEqual(
    buildCloudflareEnv({ CLOUDFLARE_API_TOKEN: "api-token" }, "account-123"),
    {
      CLOUDFLARE_ACCOUNT_ID: "account-123",
      CLOUDFLARE_API_TOKEN: "api-token",
    },
  );
  assert.deepEqual(buildCloudflareEnv({}, ""), {});
});

test("validates the Cloudflare API token before deployment", () => {
  assert.throws(
    () => validateProvidedDeploySecrets({ CLOUDFLARE_API_TOKEN: "<api-token>" }),
    /CLOUDFLARE_API_TOKEN/,
  );
});
