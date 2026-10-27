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

test("canary runbook protects the Deno auth value and tail lifecycle", () => {
  const operations = read("docs/operations.md");

  assert.match(
    operations,
    /printf '%s\\0%s\\0%s\\0' "\$CANARY_BODY_MARKER" "\$OCTG_CANARY_CLIENT_KEY" "\$deno_auth_token"/,
  );
  assert.match(operations, /const \[marker, clientKey, denoAuthToken\]/);
  assert.match(operations, /const secrets = \[marker, clientKey, denoAuthToken\]/);
  assert.match(operations, /secrets\.some\(\(secret\) => capture\.includes\(secret\)\)/);
  assert.match(operations, /assert_no_canary_secret_leak "\$preview_canary_output" "\$preview_telemetry_output" \\\n\s*"\$DENO_PREVIEW_TOKENIZER_AUTH_TOKEN"/);
  assert.match(operations, /assert_no_canary_secret_leak "\$production_canary_output" "\$production_telemetry_output" \\\n\s*"\$PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN"/);

  assert.match(operations, /wait_for_tail_ready\(\)/);
  assert.match(operations, /grep -Fq -- "\$ready_marker" "\$telemetry_output"/);
  assert.match(operations, /--max-time 2/);
  assert.match(operations, /trap 'if \[ -n "\$\{tail_pid:-\}" \]; then[\s\S]*?wait "\$tail_pid"[\s\S]*?tail_pid=""; fi; rm -f/);
  assert.match(operations, /wait "\$tail_pid" \|\| true\ntail_pid=""/);
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

test("Worker admission allows the observed three-request burst", () => {
  const productionConfig = ts.parseConfigFileTextToJson(
    "wrangler.jsonc",
    read("apps/gateway-worker/wrangler.jsonc"),
  ).config;

  assert.equal(productionConfig.vars.MAX_IN_FLIGHT_REQUESTS, "3");
});


test("relay rollout documentation keeps ownership, sharding, admission and rollback contracts", () => {
  const configuration = read("docs/configuration.md");
  const denoDocumentation = read("docs/deno-tokenizer.md");
  const operations = read("docs/operations.md");
  const specification = read("SPEC.md");

  // SPEC.md stays the canonical normative relay contract.
  assert.match(specification, /relay-decision:v1:/);

  // Configuration: binding, migration, namespace separation, opt-in flag.
  for (const fragment of [
    "`RELAY_DECISION_CONTROLLER` → `RelayDecisionController`",
    "Migration tag `v3`",
    "namespace_id",
    "`OCTG_RELAY_ENABLED`",
    "`relay-decision:v1:{environment}:{00..63}`",
  ]) {
    assert.match(configuration, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  // Deno documentation: relay route ownership and callback retention.
  assert.match(denoDocumentation, /`POST \/relay\/v1\/responses`/);
  assert.match(denoDocumentation, /never holds the relay HMAC key/);
  assert.match(denoDocumentation, /while any\s+relay grant is/);

  // Operations: same-SHA Deno-first order, CPU classes, rollback retention.
  assert.match(operations, /Deploy Deno first for each immutable revision/);
  assert.match(operations, /`v3` SQLite migration/);
  assert.match(operations, /10 ms Free limit/);
  assert.match(operations, /30,000 ms/);
  assert.match(operations, /`QuotaController\.admitRelay`/);
  assert.match(operations, /While any\s+relay grant is unresolved/);
  assert.match(operations, /Reconcile or otherwise resolve outstanding grants first/);
  assert.match(operations, /never depend on D1 writes/);
});

test("SPEC distinguishes closed relay v1 callbacks from CPU-gate control routes", () => {
  const EXPECTED_CPU_GATE_ROUTES = Object.freeze([
    Object.freeze({ route: "quota", method: "GET" }),
    Object.freeze({ route: "slot", method: "GET" }),
    Object.freeze({ route: "setup", method: "POST" }),
    Object.freeze({ route: "setup-fence", method: "POST" }),
    Object.freeze({ route: "decision-context", method: "POST" }),
    Object.freeze({ route: "operation-inspection", method: "POST" }),
    Object.freeze({ route: "reconcile-unused", method: "POST" }),
    Object.freeze({ route: "close-operation", method: "POST" }),
  ]);
  const specification = read("SPEC.md");
  const source = read("apps/gateway-worker/src/relay-cpu-gate.ts");
  const section19 = specification.match(/^## 19\. Responses Relay \(v1\)([\s\S]*)/m)?.[1];
  const section197 = section19?.match(/^### 19\.7 Internal CPU-gate control-plane extension\s*\n([\s\S]*)/m)?.[1];

  assert.ok(section19, "SPEC §19 must exist");
  assert.ok(section197, "SPEC §19.7 CPU-gate route section must exist");

  const routesMatch = source.match(/const ROUTES\s*=\s*\[([\s\S]*?)\]\s*as const\s*;/);
  assert.ok(routesMatch, "CPU-gate source ROUTES tuple must be unambiguous");
  const sourceNames = [...routesMatch[1].matchAll(/"([a-z-]+)"/g)].map((match) => match[1]);
  assert.equal(sourceNames.length, routesMatch[1].match(/,/g)?.length + 1, "source ROUTES tuple must contain only route literals");
  assert.equal(new Set(sourceNames).size, sourceNames.length, "source ROUTES must not contain duplicates");
  const methodByRoute = new Map(EXPECTED_CPU_GATE_ROUTES.map(({ route, method }) => [route, method]));
  const sourceInventory = sourceNames.map((route) => ({ route, method: methodByRoute.get(route) ?? "UNKNOWN" }));

  const routeTable = section197.match(/\| Method \| Exact route \|\n\| --- \| --- \|\n((?:\|[^\n]*\n)+)/);
  assert.ok(routeTable, "§19.7 must contain its bounded method/route table");
  const routeLines = routeTable[1].trimEnd().split("\n");
  const specInventory = routeLines.map((line) => {
    const match = line.match(/^\|\s*`(GET|POST)`\s*\|\s*`([^`]+)`\s*\|$/);
    assert.ok(match, `§19.7 route-table row must parse as exactly one GET/POST route: ${line}`);
    const prefix = "/internal/relay/v1/cpu-gate/";
    assert.ok(match[2].startsWith(prefix), `§19.7 route must use ${prefix}`);
    const route = match[2].slice(prefix.length);
    const expectedRoute = EXPECTED_CPU_GATE_ROUTES.find(({ route: expected }) => expected === route);
    assert.ok(expectedRoute, `§19.7 route must be in the frozen inventory: ${route}`);
    assert.equal(match[1], expectedRoute.method, `§19.7 method must match frozen inventory for ${route}`);
    return { route, method: match[1] };
  });
  assert.equal(specInventory.length, EXPECTED_CPU_GATE_ROUTES.length, "§19.7 route count must equal frozen inventory");
  assert.equal(specInventory.length, sourceNames.length, "§19.7 route count must equal source ROUTES");
  assert.equal(new Set(specInventory.map(({ route }) => route)).size, specInventory.length, "SPEC routes must not contain duplicates");
  assert.deepEqual(sourceInventory, EXPECTED_CPU_GATE_ROUTES, "frozen expected inventory must equal source ROUTES");
  assert.deepEqual(specInventory, EXPECTED_CPU_GATE_ROUTES, "frozen expected inventory must equal §19.7 routes and methods");

  assert.match(section19, /no unannounced HTTP headers, envelope fields, or routes may be added to the closed Relay v1 wire contract/i);
  assert.match(section19, /All relay ingress and callback routes accept \*\*POST only\*\*/);
  assert.match(section197, /`OCTG_RELAY_CPU_GATE_AUTH_TOKEN`/);
  assert.ok(section197.indexOf("404") >= 0 && section197.indexOf("404") < section197.indexOf("401"), "hidden-route 404 behavior must precede enabled-control 401 behavior");
  assert.match(section197, /returns `401`, before request-body reading or any Durable Object lookup/);
  assert.match(section197, /8,192-byte request body limit/);
  assert.match(section197, /no direct Durable Object storage mutation|does not directly mutate Durable Object storage/i);
  assert.match(section197, /stateless-only/i);
  assert.match(section197, /Stage 1\/2[^\n]*readiness|does not establish Stage 1\/2 readiness/i);
  assert.match(section197, /X-OCTG-Worker-Version[\s\S]*?local[\s\S]*?4xx[\s\S]*?500[\s\S]*?503/);
  assert.match(section197, /outer `index\.ts` catch[\s\S]*?without that wrapper[\s\S]*?not.*DO code version.*CPU PASS/i);
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
