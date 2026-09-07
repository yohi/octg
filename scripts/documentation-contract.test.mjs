import { strict as assert } from "node:assert";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import * as ts from "typescript";
import { PROVIDER_QUOTA_CEILINGS } from "./preview-quota-validator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

function read(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function markdownFiles(directory, relativeDirectory = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if ([".git", ".codegraph", "node_modules"].includes(entry.name)) return [];
    const relativePath = join(relativeDirectory, entry.name);
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(absolutePath, relativePath);
    return entry.isFile() && entry.name.endsWith(".md") ? [relativePath] : [];
  });
}

test("configuration documentation lists the complete Deno tokenizer setting group", () => {
  const configuration = read("docs/configuration.md");

  for (const setting of [
    "DENO_TOKENIZER_ENDPOINT",
    "DENO_TOKENIZER_AUTH_TOKEN",
    "DENO_TOKENIZER_THRESHOLD_BYTES",
    "DENO_TOKENIZER_TIMEOUT_MS",
  ]) {
    assert.match(configuration, new RegExp("`" + setting + "`"));
  }
});

test("Deno documentation separates deployment authentication from runtime authentication", () => {
  const configuration = read("docs/configuration.md");
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
    assert.match(row, /\| variable \|/);
  }

  assert.match(configuration, /`DENO_TOKENIZER_AUTH_TOKEN` \| Worker secret \|/);
  assert.match(configuration, /`DENO_DEPLOY_TOKEN` \| Deno Deploy management secret \|/);
  assert.match(denoDocumentation, /`DENO_DEPLOY_TOKEN`: management credential/);
  assert.match(denoDocumentation, /`DENO_TOKENIZER_AUTH_TOKEN`: Worker-side secret/);
  assert.match(denoDocumentation, /`OCTG_TOKENIZER_AUTH_TOKEN`: Deno runtime secret/);
  assert.match(environmentTemplate, /three non-secret Production Worker values.*GitHub Actions\s+Repository\s+Variables/s);
  assert.match(environmentTemplate, /PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN/);
});

test("canonical documentation retains tokenizer rollout and future-work boundaries", () => {
  const specification = read("SPEC.md");
  const denoDocumentation = read("docs/deno-tokenizer.md");
  const operations = read("docs/operations.md");
  const roadmap = read("docs/roadmap.md");
  const readme = read("README.md");

  assert.match(specification, /docs\/roadmap\.md/);
  assert.match(readme, /docs\/roadmap\.md/);
  assert.match(denoDocumentation, /approximately 74k-token class/);
  assert.match(denoDocumentation, /invalid-auth/);
  assert.match(denoDocumentation, /wrangler rollback/);
  assert.match(operations, /tokenizer_init/);
  assert.match(operations, /tokenizer_encode/);
  assert.match(operations, /concurrency 1/);
  assert.match(operations, /concurrency 2/);
  assert.match(roadmap, /PAID_SHARED/);
  assert.match(roadmap, /TokenizerController sharding/);
});

test("Preview configuration keeps its Deno control plane separate from Production", () => {
  const configuration = read("docs/configuration.md");
  const environmentTemplate = read(".env.example");

  for (const setting of [
    "DENO_PREVIEW_DEPLOY_ORG",
    "DENO_PREVIEW_DEPLOY_APP",
    "DENO_PREVIEW_DEPLOY_TOKEN",
    "DENO_PREVIEW_TOKENIZER_ENDPOINT",
    "DENO_PREVIEW_TOKENIZER_AUTH_TOKEN",
    "DENO_PREVIEW_TOKENIZER_THRESHOLD_BYTES",
    "DENO_PREVIEW_TOKENIZER_TIMEOUT_MS",
  ]) {
    assert.match(configuration, new RegExp(setting));
    assert.match(environmentTemplate, new RegExp(`^${setting}=`, "m"));
  }

  assert.match(configuration, /Do not reuse Production client keys, peppers, D1 state, or Deno shared-auth values in Preview\./);
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

test("all Markdown documentation keeps relative links resolvable", () => {
  const documentationFiles = markdownFiles(root);
  const unresolved = [];

  for (const relativePath of documentationFiles) {
    const content = read(relativePath);
    for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1].split(/[?#]/, 1)[0];
      if (!target || target.startsWith("http://") || target.startsWith("https://") || target.startsWith("mailto:")) {
        continue;
      }

      const targetPath = dirname(join(root, relativePath));
      const resolvedPath = join(targetPath, target);
      if (!existsSync(resolvedPath)) {
        unresolved.push(`${relativePath} -> ${target}`);
      }
    }
  }

  assert.deepEqual(unresolved, []);
});
