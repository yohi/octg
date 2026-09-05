import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import * as ts from "typescript";
import { PROVIDER_QUOTA_CEILINGS } from "./preview-quota-validator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

function read(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

test("configuration catalog exposes the documented six-column shape and operating sections", () => {
  const configuration = read("docs/CONFIGURATION.md");

  assert.match(
    configuration,
    /\| Name \| Kind \| Consumer \| Set in \| Obtain or decide \| Apply \|/,
  );
  for (const heading of [
    "## Production/Preview boundary",
    "## Rotation and recovery",
    "## Troubleshooting",
    "## Related procedures",
  ]) {
    assert.match(configuration, new RegExp(`^${heading}$`, "m"));
  }
});

test("Deno local testing command grants the environment permission used by the service", () => {
  const denoDocumentation = read("docs/deno-tokenizer.md");

  assert.doesNotMatch(denoDocumentation, /deno task dev/);
  assert.match(denoDocumentation, /deno run --allow-env --allow-net src\/main\.ts/);
});

test("Production Deno settings use GitHub Variables without moving authentication Secrets", () => {
  const configuration = read("docs/CONFIGURATION.md");
  const denoDocumentation = read("docs/deno-tokenizer.md");
  const environmentTemplate = read(".env.example");

  for (const variableName of [
    "DENO_TOKENIZER_ENDPOINT",
    "DENO_TOKENIZER_THRESHOLD_BYTES",
    "DENO_TOKENIZER_TIMEOUT_MS",
  ]) {
    const row = configuration
      .split("\n")
      .find((line) => line.startsWith(`| \`${variableName}\` |`));
    assert.ok(row, `configuration catalog must contain ${variableName}`);
    assert.match(row, /\| Variable \|/);
    assert.match(row, /\| GitHub Repository Variable \|/);
    assert.match(row, /\| `\.github\/workflows\/deploy-production\.yml` \|/);
  }

  assert.match(configuration, /`DENO_TOKENIZER_AUTH_TOKEN` \| Secret \| Gateway Worker → Deno \| Worker Secret \|/);
  assert.match(configuration, /`OCTG_TOKENIZER_AUTH_TOKEN` \| Secret \| Deno tokenizer runtime \| Deno Deploy runtime environment \|/);
  assert.match(configuration, /`PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN` \| Secret \| Production Worker and Deno Deploy workflows \| GitHub Environment `deno-production` \|/);
  assert.match(configuration, /`DENO_DEPLOY_TOKEN` \| Secret \| Deno Deploy workflow \| GitHub Environment `deno-production` \|/);
  assert.match(configuration, /GitHub Environment `deno-production`.*PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN/s);
  assert.match(denoDocumentation, /GitHub Repository\s+Variables/);
  assert.match(denoDocumentation, /\.github\/workflows\/deploy-production\.yml/);
  assert.match(denoDocumentation, /PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN/);
  assert.match(denoDocumentation, /DENO_PREVIEW_TOKENIZER_AUTH_TOKEN/);
  assert.match(denoDocumentation, /invalid-auth/);
  assert.match(environmentTemplate, /three non-secret Production Worker values.*GitHub Actions\s+Repository\s+Variables/s);
  assert.match(environmentTemplate, /PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN/);
  assert.match(environmentTemplate, /DENO_PREVIEW_DEPLOY_ORG/);
  assert.match(environmentTemplate, /DENO_PREVIEW_TOKENIZER_AUTH_TOKEN/);
});

test("Preview documentation distinguishes the DO-only smoke from the Deno two-phase smoke", () => {
  const configuration = read("docs/CONFIGURATION.md");
  const denoDocumentation = read("docs/deno-tokenizer.md");

  for (const content of [configuration, denoDocumentation]) {
    assert.match(content, /DO-only/);
    assert.match(content, /invalid-auth/);
    assert.match(content, /HTTP `500`/);
    assert.match(content, /HTTP `200`/);
    assert.match(content, /rollback/);
  }
});

test("Preview quota examples stay within the provider ceilings", () => {
  const environmentTemplate = read(".env.example");
  const productionConfig = ts.parseConfigFileTextToJson(
    "wrangler.jsonc",
    read("apps/gateway-worker/wrangler.jsonc"),
  ).config;

  for (const pool of ["STANDARD", "MINI"]) {
    const previewMatch = environmentTemplate.match(
      new RegExp(`^OCTG_PREVIEW_QUOTA_LIMIT_${pool}=(\\d+)$`, "m"),
    );
    assert.ok(previewMatch, `example must define Preview ${pool} quota`);
    const previewLimit = Number(previewMatch[1]);
    const productionLimit = Number(productionConfig.vars[`QUOTA_LIMIT_${pool}`]);
    assert.ok(
      productionLimit + previewLimit <= PROVIDER_QUOTA_CEILINGS[pool],
      `${pool} example allocation must stay within the provider ceiling`,
    );
  }
});

test("reader-facing documentation keeps relative links resolvable", () => {
  const documentationFiles = [
    "README.md",
    "docs/CONFIGURATION.md",
    "docs/DEPLOY_FROM_TEMPLATE.md",
    "docs/deno-tokenizer.md",
  ];
  const unresolved = [];

  for (const relativePath of documentationFiles) {
    const content = read(relativePath);
    for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1].split(/[?#]/, 1)[0];
      if (!target || target.startsWith("http://") || target.startsWith("https://") || target.startsWith("mailto:")) {
        continue;
      }

      const targetPath = join(root, relativePath, "..");
      const resolvedPath = join(targetPath, target);
      if (!existsSync(resolvedPath)) {
        unresolved.push(`${relativePath} -> ${target}`);
      }
    }
  }

  assert.deepEqual(unresolved, []);
});
