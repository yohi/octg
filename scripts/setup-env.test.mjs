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

test("resolves deploy inputs from existing config and reports only missing names", () => {
  assert.deepEqual(
    resolveDeployInputs(
      {
        OCTG_DATABASE_ID: "",
        OCTG_UPSTREAM_BASE_URL: "https://gateway.example/openai",
        ACCESS_TEAM_DOMAIN: "",
        ACCESS_AUD: "aud-123",
      },
      {
        databaseId: "existing-db",
        upstream: "https://existing.example/openai",
        teamDomain: "https://team.example",
        audience: "existing-aud",
      },
    ),
    {
      values: {
        databaseId: "existing-db",
        upstream: "https://gateway.example/openai",
        teamDomain: "https://team.example",
        audience: "aud-123",
      },
      missing: [],
    },
  );
});

test("does not include secret values in missing-input messages", () => {
  const result = resolveDeployInputs(
    { OCTG_DATABASE_ID: "", OCTG_UPSTREAM_BASE_URL: "", ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" },
    { databaseId: "", upstream: "", teamDomain: "", audience: "" },
  );

  assert.deepEqual(result.missing, ["OCTG_DATABASE_ID", "OCTG_UPSTREAM_BASE_URL", "ACCESS_TEAM_DOMAIN", "ACCESS_AUD"]);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("treats documentation placeholders as missing deploy inputs", () => {
  const result = resolveDeployInputs(
    {
      OCTG_DATABASE_ID: "<database-id>",
      OCTG_UPSTREAM_BASE_URL: "https://gateway.example/openai",
      ACCESS_TEAM_DOMAIN: "<team-domain>",
      ACCESS_AUD: "<audience-tag>",
    },
    { databaseId: "", upstream: "", teamDomain: "", audience: "" },
  );

  assert.deepEqual(result.missing, ["OCTG_DATABASE_ID", "ACCESS_TEAM_DOMAIN", "ACCESS_AUD"]);
  assert.deepEqual(result.values, { upstream: "https://gateway.example/openai" });
});
