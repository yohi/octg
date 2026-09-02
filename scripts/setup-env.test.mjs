#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  mergeSetupEnvironment,
  parseSetupEnvFile,
  resolveLocalValue,
  resolveDeployInputs,
} from "./setup-env.mjs";

test("parses safe assignments without executing shell syntax", () => {
  const values = parseSetupEnvFile([
    "# comments are ignored",
    'export OCTG_UPSTREAM_BASE_URL="https://gateway.example/openai"',
    "OCTG_PREVIEW_UPSTREAM_API_TOKEN=preview-upstream-token",
    "OCTG_DATABASE_ID='db-123'",
    "UNRELATED=$(touch /tmp/should-not-exist)",
  ].join("\n"));

  assert.deepEqual(values, {
    OCTG_UPSTREAM_BASE_URL: "https://gateway.example/openai",
    OCTG_PREVIEW_UPSTREAM_API_TOKEN: "preview-upstream-token",
    OCTG_DATABASE_ID: "db-123",
  });
});

test("rejects non-whitespace characters after a quoted value", () => {
  assert.throws(
    () => parseSetupEnvFile('OCTG_DATABASE_ID="db-123"suffix"'),
    /invalid env file line: 1/,
  );
});

test("process values override env-file values and defaults", () => {
  const result = mergeSetupEnvironment(
    { OCTG_DATABASE_ID: "from-file", OCTG_UPSTREAM_BASE_URL: "from-file" },
    { OCTG_DATABASE_ID: "from-process" },
    { OCTG_DATABASE_ID: "from-default", ACCESS_AUD: "default-aud" },
  );

  assert.deepEqual(result, {
    OCTG_DATABASE_ID: "from-process",
    OCTG_UPSTREAM_BASE_URL: "from-file",
    ACCESS_AUD: "default-aud",
  });
});

test("uses the legacy local setting from the env file when the canonical setting is absent", () => {
  assert.equal(
    resolveLocalValue(
      { OCTG_UPSTREAM_BASE_URL: "from-file" },
      "OCTG_LOCAL_UPSTREAM_BASE_URL",
      "OCTG_UPSTREAM_BASE_URL",
      "default",
    ),
    "from-file",
  );
  assert.equal(
    resolveLocalValue(
      {
        OCTG_LOCAL_UPSTREAM_BASE_URL: "from-local",
        OCTG_UPSTREAM_BASE_URL: "from-legacy",
      },
      "OCTG_LOCAL_UPSTREAM_BASE_URL",
      "OCTG_UPSTREAM_BASE_URL",
      "default",
    ),
    "from-local",
  );
});

test("treats local angle-bracket placeholders as unset", () => {
  assert.equal(
    resolveLocalValue(
      { OCTG_LOCAL_UPSTREAM_BASE_URL: "https://gateway.example/<account_id>" },
      "OCTG_LOCAL_UPSTREAM_BASE_URL",
      "OCTG_UPSTREAM_BASE_URL",
      "https://default.example/openai",
    ),
    "https://default.example/openai",
  );
  assert.equal(
    resolveLocalValue(
      {},
      "OCTG_LOCAL_UPSTREAM_BASE_URL",
      "OCTG_UPSTREAM_BASE_URL",
      "https://gateway.example/<gateway_id>",
    ),
    "",
  );
});

test("resolves deploy inputs from existing config and reports only missing names", () => {
  assert.deepEqual(
    resolveDeployInputs(
      {
        CLOUDFLARE_ACCOUNT_ID: "",
        OCTG_DATABASE_ID: "",
        OCTG_UPSTREAM_BASE_URL: "https://gateway.example/openai",
        ACCESS_TEAM_DOMAIN: "",
        ACCESS_AUD: "aud-123",
      },
      {
        accountId: "existing-account",
        databaseId: "existing-db",
        upstream: "https://existing.example/openai",
        teamDomain: "https://team.example",
        audience: "existing-aud",
      },
    ),
    {
      values: {
        accountId: "existing-account",
        databaseId: "existing-db",
        upstream: "https://gateway.example/openai",
        teamDomain: "https://team.example",
        audience: "aud-123",
      },
      missing: [],
    },
  );
});

test("falls back to existing config when env file contains a documentation placeholder", () => {
  assert.deepEqual(
    resolveDeployInputs(
      {
        CLOUDFLARE_ACCOUNT_ID: "account-123",
        OCTG_DATABASE_ID: "<production-d1-database-id>",
        OCTG_UPSTREAM_BASE_URL: "https://gateway.example/openai",
        ACCESS_TEAM_DOMAIN: "https://team.example",
        ACCESS_AUD: "aud-123",
      },
      {
        accountId: "account-123",
        databaseId: "existing-db",
        upstream: "https://existing.example/openai",
        teamDomain: "https://existing.team.example",
        audience: "existing-aud",
      },
    ),
    {
      values: {
        accountId: "account-123",
        databaseId: "existing-db",
        upstream: "https://gateway.example/openai",
        teamDomain: "https://team.example",
        audience: "aud-123",
      },
      missing: [],
    },
  );
});

test("requires a Cloudflare account ID for deploy inputs", () => {
  const result = resolveDeployInputs(
    {
      CLOUDFLARE_ACCOUNT_ID: "",
      OCTG_DATABASE_ID: "db-123",
      OCTG_UPSTREAM_BASE_URL: "https://gateway.example/openai",
      ACCESS_TEAM_DOMAIN: "https://team.example",
      ACCESS_AUD: "aud-123",
    },
    { accountId: "", databaseId: "", upstream: "", teamDomain: "", audience: "" },
  );

  assert.deepEqual(result.missing, ["CLOUDFLARE_ACCOUNT_ID"]);
});

test("trims deploy input values before checking placeholders", () => {
  const result = resolveDeployInputs(
    {
      CLOUDFLARE_ACCOUNT_ID: " account-123 ",
      OCTG_DATABASE_ID: "   ",
      OCTG_UPSTREAM_BASE_URL: " https://gateway.example/openai ",
      ACCESS_TEAM_DOMAIN: " <team-domain> ",
      ACCESS_AUD: " aud-123 ",
    },
    { accountId: "", databaseId: "", upstream: "", teamDomain: "", audience: "" },
  );

  assert.deepEqual(result.values, {
    accountId: "account-123",
    upstream: "https://gateway.example/openai",
    audience: "aud-123",
  });
  assert.deepEqual(result.missing, ["OCTG_DATABASE_ID", "ACCESS_TEAM_DOMAIN"]);
});

test("does not include secret values in missing-input messages", () => {
  const result = resolveDeployInputs(
    { CLOUDFLARE_ACCOUNT_ID: "", OCTG_DATABASE_ID: "", OCTG_UPSTREAM_BASE_URL: "", ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" },
    { accountId: "", databaseId: "", upstream: "", teamDomain: "", audience: "" },
  );

  assert.deepEqual(result.missing, ["CLOUDFLARE_ACCOUNT_ID", "OCTG_DATABASE_ID", "OCTG_UPSTREAM_BASE_URL", "ACCESS_TEAM_DOMAIN", "ACCESS_AUD"]);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("treats documentation placeholders as missing deploy inputs", () => {
  const result = resolveDeployInputs(
    {
      CLOUDFLARE_ACCOUNT_ID: "<account-id>",
      OCTG_DATABASE_ID: "<database-id>",
      OCTG_UPSTREAM_BASE_URL: "https://gateway.example/openai",
      ACCESS_TEAM_DOMAIN: "<team-domain>",
      ACCESS_AUD: "<audience-tag>",
    },
    { accountId: "", databaseId: "", upstream: "", teamDomain: "", audience: "" },
  );

  assert.deepEqual(result.missing, ["CLOUDFLARE_ACCOUNT_ID", "OCTG_DATABASE_ID", "ACCESS_TEAM_DOMAIN", "ACCESS_AUD"]);
  assert.deepEqual(result.values, { upstream: "https://gateway.example/openai" });
});
