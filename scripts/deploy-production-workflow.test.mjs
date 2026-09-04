import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));

function extractStepRun(workflow, stepName) {
  const marker = `- name: ${stepName}`;
  const start = workflow.indexOf(marker);
  if (start < 0) return null;

  const afterMarker = workflow.slice(start + marker.length);
  const nextStepMatch = afterMarker.search(/\n\s{4,6}-\s+name:|\n\s{0,4}[a-z_0-9-]+:/i);
  const stepContent = nextStepMatch >= 0 ? afterMarker.slice(0, nextStepMatch) : afterMarker;

  const inlineMatch = stepContent.match(/\n\s+run:\s*([^\n|>\s].*)/);
  if (inlineMatch) {
    return inlineMatch[1].trim();
  }

  const multilineMatch = stepContent.match(/\n(\s+)run:\s*(?:\|[+-]?|>[-+]?)?\s*\n/);
  if (!multilineMatch) return null;

  const runIndent = multilineMatch[1].length;
  const afterRun = stepContent.slice(multilineMatch.index + multilineMatch[0].length);

  const lines = [];
  for (const line of afterRun.split("\n")) {
    if (line.trim().length === 0) {
      lines.push("");
      continue;
    }
    const indentMatch = line.match(/^(\s*)/);
    if (indentMatch && indentMatch[1].length <= runIndent) {
      break;
    }
    lines.push(line.trim());
  }
  return lines.join("\n");
}

function hasWranglerDeployKeepVars(runCommand) {
  if (!runCommand) return false;

  const cleanLines = runCommand
    .split("\n")
    .map((l) => l.replace(/#.*$/, "").trim())
    .filter(Boolean);

  const commands = [];
  let currentCmd = "";
  for (const line of cleanLines) {
    if (line.endsWith("\\")) {
      currentCmd += (currentCmd ? " " : "") + line.slice(0, -1).trim();
    } else {
      currentCmd += (currentCmd ? " " : "") + line;
      commands.push(currentCmd);
      currentCmd = "";
    }
  }
  if (currentCmd) commands.push(currentCmd);

  return commands.some((cmd) => {
    const tokens = cmd.split(/\s+/);
    const wranglerIndex = tokens.findIndex(
      (token) => token === "wrangler" || token.endsWith("/wrangler"),
    );
    if (wranglerIndex < 0) return false;
    const isWorkerDeployment = tokens[wranglerIndex + 1] === "deploy" ||
      (tokens[wranglerIndex + 1] === "versions" && tokens[wranglerIndex + 2] === "upload");
    return isWorkerDeployment && tokens.includes("--keep-vars");
  });
}

test("deploy-production workflow preserves remote environment variables using --keep-vars", () => {
  const workflowPath = join(root, ".github/workflows/deploy-production.yml");
  const workflow = readFileSync(workflowPath, "utf8");

  const runCommand = extractStepRun(workflow, "Deploy Worker");
  assert.ok(runCommand, "deploy-production workflow must contain a 'Deploy Worker' step with a 'run' command");

  assert.ok(
    hasWranglerDeployKeepVars(runCommand),
    "'Deploy Worker' step must invoke 'wrangler deploy' with '--keep-vars' to prevent erasing remote variables like Deno settings",
  );
});

test("deploy-production workflow validates and injects non-secret Deno settings", () => {
  const workflowPath = join(root, ".github/workflows/deploy-production.yml");
  const workflow = readFileSync(workflowPath, "utf8");

  for (const variableName of [
    "DENO_TOKENIZER_ENDPOINT",
    "DENO_TOKENIZER_THRESHOLD_BYTES",
    "DENO_TOKENIZER_TIMEOUT_MS",
  ]) {
    assert.match(
      workflow,
      new RegExp(`\\$\\{\\{ vars\\.${variableName} \\}\\}`),
      `Production workflow must source ${variableName} from GitHub Variables`,
    );
  }

  const validationStep = extractStepRun(
    workflow,
    "Validate Production Deno tokenizer configuration",
  );
  assert.equal(validationStep, "node scripts/production-deno-config.mjs");

  const validationIndex = workflow.indexOf(
    "- name: Validate Production Deno tokenizer configuration",
  );
  const migrationIndex = workflow.indexOf("- name: Apply D1 migrations");
  assert.ok(validationIndex >= 0, "Production Deno validation step must exist");
  assert.ok(
    migrationIndex > validationIndex,
    "Production Deno validation must run before D1 migrations",
  );

  const deployCommand = extractStepRun(workflow, "Deploy Worker");
  assert.ok(deployCommand, "Deploy Worker step must contain a run command");
  assert.match(deployCommand, /--keep-vars/);
  for (const variableName of [
    "DENO_TOKENIZER_ENDPOINT",
    "DENO_TOKENIZER_THRESHOLD_BYTES",
    "DENO_TOKENIZER_TIMEOUT_MS",
  ]) {
    assert.match(
      deployCommand,
      new RegExp(`--var "${variableName}:\\$\\{${variableName}\\}"`),
      `Deploy Worker must pass ${variableName} explicitly to Wrangler`,
    );
  }

});

test("deploy-production workflow synchronizes the Worker auth Secret safely", () => {
  const workflowPath = join(root, ".github/workflows/deploy-production.yml");
  const workflow = readFileSync(workflowPath, "utf8");
  const deployCommand = extractStepRun(workflow, "Deploy Worker");

  assert.match(workflow, /environment: deno-production/);
  assert.match(
    workflow,
    /PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN: \$\{\{ secrets\.PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN \}\}/,
  );
  assert.ok(deployCommand, "Deploy Worker step must contain a run command");
  assert.match(deployCommand, /wrangler versions upload/);
  assert.match(deployCommand, /--secrets-file "\$secrets_file"/);
  assert.match(deployCommand, /wrangler versions deploy/);
  assert.match(deployCommand, /WRANGLER_OUTPUT_FILE_PATH/);
  assert.match(deployCommand, /version_id=\$\(jq/);
  assert.match(deployCommand, /"\$\{version_id\}@100%"/);
  assert.match(deployCommand, /DENO_TOKENIZER_AUTH_TOKEN/);
  assert.match(deployCommand, /mode: 0o600/);
  assert.doesNotMatch(deployCommand, /\$\{\{\s*secrets\./);

  const secretIndex = workflow.indexOf("PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN");
  const migrationIndex = workflow.indexOf("- name: Apply D1 migrations");
  assert.ok(secretIndex >= 0 && secretIndex < migrationIndex);
});
