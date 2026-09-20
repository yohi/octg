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

function extractWorkflowJobs(workflow) {
  const jobsIndex = workflow.search(/^jobs:\s*$/m);
  if (jobsIndex < 0) return [];

  const jobsWorkflow = workflow.slice(jobsIndex);
  const jobMatches = [...jobsWorkflow.matchAll(/^  ([A-Za-z0-9_-]+):\s*$/gm)];
  return jobMatches.map((match, index) => {
    const jobEnd = jobMatches[index + 1]?.index ?? jobsWorkflow.length;
    const block = jobsWorkflow.slice(match.index, jobEnd);
    return {
      id: match[1],
      needs: extractJobNeeds(block),
      steps: extractWorkflowSteps(block),
    };
  });
}

function extractJobNeeds(jobBlock) {
  const needsMatch = jobBlock.match(/^    needs:\s*(.*)$/m);
  if (!needsMatch) return [];

  const inlineNeeds = needsMatch[1].trim();
  if (inlineNeeds) {
    return inlineNeeds
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((value) => value.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
  }

  const needs = [];
  const afterNeeds = jobBlock.slice(needsMatch.index + needsMatch[0].length);
  for (const line of afterNeeds.split("\n")) {
    if (/^ {4}\S/.test(line)) break;
    const itemMatch = line.match(/^ {6}- ([A-Za-z0-9_-]+)\s*$/);
    if (itemMatch) needs.push(itemMatch[1]);
  }
  return needs;
}

function extractWorkflowSteps(jobBlock) {
  return [...jobBlock.matchAll(/^ {6}- name: (.+)$/gm)].map((match) => {
    const name = match[1].trim();
    return { name, run: extractStepRun(jobBlock.slice(match.index), name) };
  });
}

function assertRemoteMutationsFollowValidation(workflow, validationStepName, changeCommands) {
  const jobs = extractWorkflowJobs(workflow);
  const validationJobs = jobs.filter((job) =>
    job.steps.some((step) => step.name === validationStepName)
  );
  assert.equal(validationJobs.length, 1, "Production configuration validation must exist in one job");

  const validationJob = validationJobs[0];
  const validationStepIndex = validationJob.steps.findIndex((step) => step.name === validationStepName);
  for (const command of changeCommands) {
    const changeJobs = jobs.filter((job) =>
      job.steps.some((step) => typeof step.run === "string" && step.run.includes(command))
    );
    assert.equal(changeJobs.length, 1, `Production workflow must contain one job for ${command}`);

    const changeJob = changeJobs[0];
    const changeStepIndex = changeJob.steps.findIndex((step) =>
      typeof step.run === "string" && step.run.includes(command)
    );
    const followsInSameJob = changeJob.id === validationJob.id && changeStepIndex > validationStepIndex;
    const dependsOnValidationJob = changeJob.needs.includes(validationJob.id);
    assert.ok(
      followsInSameJob || dependsOnValidationJob,
      `Production validation must precede ${command} in the same job or through needs: ${validationJob.id}`,
    );
  }
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

test("deploy-production workflow sources all non-secret settings from GitHub Variables", () => {
  const workflowPath = join(root, ".github/workflows/deploy-production.yml");
  const workflow = readFileSync(workflowPath, "utf8");
  for (const variableName of [
    "MAX_INPUT_BYTES",
    "DENO_TOKENIZER_ENDPOINT",
    "DENO_TOKENIZER_THRESHOLD_BYTES",
    "DENO_TOKENIZER_TIMEOUT_MS",
    "DENO_PREPARE_ENDPOINT",
    "DENO_PREPARE_THRESHOLD_BYTES",
  ]) {
    assert.match(
      workflow,
      new RegExp(`\\$\\{\\{ vars\\.${variableName} \\}\\}`),
      `Production workflow must source ${variableName} from GitHub Variables`,
    );
  }
});

test("deploy-production validates prepare configuration before every remote mutation", () => {
  const workflowPath = join(root, ".github/workflows/deploy-production.yml");
  const workflow = readFileSync(workflowPath, "utf8");
  const validationStepName = "Validate Production Deno tokenizer configuration";
  const changeCommands = [
    "wrangler d1 migrations apply",
    "wrangler versions upload",
    "wrangler versions deploy",
  ];

  assertRemoteMutationsFollowValidation(workflow, validationStepName, changeCommands);
});

test("deploy-production uploads the mandatory prepare pair directly", () => {
  const workflowPath = join(root, ".github/workflows/deploy-production.yml");
  const workflow = readFileSync(workflowPath, "utf8");
  const validationStep = extractStepRun(workflow, "Validate Production Deno tokenizer configuration");
  const deployCommand = extractStepRun(workflow, "Deploy Worker");
  assert.ok(validationStep, "Production configuration validation must have a run command");
  assert.ok(deployCommand, "Deploy Worker must have a run command");
  assert.match(validationStep, /node scripts\/production-deno-config\.mjs/);
  assert.doesNotMatch(validationStep, /PRODUCTION_PREPARE_CONFIGURED|unset DENO_PREPARE_/);
  assert.match(deployCommand, /--var "DENO_PREPARE_ENDPOINT:\$\{DENO_PREPARE_ENDPOINT\}"/);
  assert.match(deployCommand, /--var "DENO_PREPARE_THRESHOLD_BYTES:\$\{DENO_PREPARE_THRESHOLD_BYTES\}"/);
  assert.doesNotMatch(deployCommand, /prepare_args=\(\)|PRODUCTION_PREPARE_CONFIGURED|unset DENO_PREPARE_/);

  const denoWorkflow = readFileSync(join(root, ".github/workflows/deploy-deno-tokenizer.yml"), "utf8");
  assert.match(denoWorkflow, /MAX_INPUT_BYTES: \$\{\{ vars\.MAX_INPUT_BYTES \}\}/);
  assert.match(denoWorkflow, /MAX_INPUT_BYTES=\$\{maxInputBytes\}/);
  assert.match(denoWorkflow, /OCTG_EXPECTED_MAX_INPUT_BYTES=\$\{maxInputBytes\}/);
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

test("deploy-production is triggered only by a successful master Deno workflow run", () => {
  const workflowPath = join(root, ".github/workflows/deploy-production.yml");
  const productionWorkflow = readFileSync(workflowPath, "utf8");

  assert.match(productionWorkflow, /workflow_run:/);
  assert.match(productionWorkflow, /workflows: \[Deploy Deno Tokenizer\]/);
  assert.match(productionWorkflow, /github\.event\.workflow_run\.event == 'push'/);
  assert.match(productionWorkflow, /github\.event\.workflow_run\.head_branch == 'master'/);
  assert.match(productionWorkflow, /conclusion == 'success'/);
  assert.match(productionWorkflow, /ref: master/);
  assert.doesNotMatch(
    productionWorkflow,
    /ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/,
  );
  assert.doesNotMatch(productionWorkflow, /\n  push:/);
  assert.match(
    productionWorkflow,
    /concurrency:\n  group: octg-deployment\n  cancel-in-progress: false/,
  );
});

test("deploy-production gates remote mutations on the current master SHA", () => {
  const workflowPath = join(root, ".github/workflows/deploy-production.yml");
  const productionWorkflow = readFileSync(workflowPath, "utf8");
  const gateName = "Require master alignment with the Deno revision";
  const gateMarker = `- name: ${gateName}`;
  const gateIndex = productionWorkflow.indexOf(gateMarker);
  const migrationIndex = productionWorkflow.indexOf("- name: Apply D1 migrations");

  assert.ok(gateIndex >= 0, "the workflow must resolve the current master SHA");
  assert.ok(migrationIndex > gateIndex, "the SHA gate must precede D1 mutation");
  assert.doesNotMatch(
    productionWorkflow.slice(gateIndex + gateMarker.length, migrationIndex),
    /\n\s{4,6}-\s+name:/,
    "the SHA gate must be immediately before D1 mutation",
  );
  assert.match(
    productionWorkflow,
    /DENO_WORKFLOW_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/,
  );

  const gateRun = extractStepRun(productionWorkflow, gateName);
  assert.ok(gateRun, "the SHA gate must have a run command");
  assert.match(gateRun, /git ls-remote origin refs\/heads\/master/);
  assert.match(gateRun, /!= "\$DENO_WORKFLOW_SHA"/);
  assert.match(gateRun, /skipped/);
  assert.match(
    productionWorkflow,
    /- name: Apply D1 migrations\n\s+if: steps\.master_alignment\.outputs\.aligned == 'true'\n\s+run: .*wrangler d1 migrations apply/,
  );
  assert.match(
    productionWorkflow,
    /- name: Deploy Worker\n\s+if: steps\.master_alignment\.outputs\.aligned == 'true'\n\s+run:/,
  );
});

test("deploy-production probes Deno before D1 mutation", () => {
  const workflowPath = join(root, ".github/workflows/deploy-production.yml");
  const productionWorkflow = readFileSync(workflowPath, "utf8");
  const probeName = "Verify Deno prepare contract";
  const probeIndex = productionWorkflow.indexOf(`- name: ${probeName}`);
  const migrationIndex = productionWorkflow.indexOf("- name: Apply D1 migrations");

  assert.ok(probeIndex >= 0 && probeIndex < migrationIndex);
  assert.match(
    extractStepRun(productionWorkflow, probeName) ?? "",
    /node scripts\/verify-deno-prepare-contract\.mjs/,
  );
});

test("deploy-deno-tokenizer deploys every master commit and probes its contract", () => {
  const denoWorkflow = readFileSync(
    join(root, ".github/workflows/deploy-deno-tokenizer.yml"),
    "utf8",
  );
  const pushStart = denoWorkflow.indexOf("  push:\n");
  const pullRequestStart = denoWorkflow.indexOf("  pull_request:\n");
  assert.ok(pushStart >= 0 && pullRequestStart > pushStart);

  const pushTrigger = denoWorkflow.slice(pushStart, pullRequestStart);
  assert.match(pushTrigger, /branches: \[master\]/);
  assert.doesNotMatch(pushTrigger, /paths:/);

  const runtimeSecretStep = extractStepRun(denoWorkflow, "Configure Deno tokenizer runtime Secret");
  assert.ok(runtimeSecretStep, "the runtime Secret step must have a run command");
  assert.match(runtimeSecretStep, /trim\(\) !== "1048576"/);
  assert.ok(
    runtimeSecretStep.indexOf('!== "1048576"') < runtimeSecretStep.indexOf("env load"),
    "the canonical input-limit check must precede env load",
  );

  const deployIndex = denoWorkflow.indexOf("- name: Deploy\n");
  const probeName = "Verify Deno prepare contract";
  const probeIndex = denoWorkflow.indexOf(`- name: ${probeName}`);
  assert.ok(probeIndex > deployIndex, "the contract probe must run after deployment");
  assert.match(
    extractStepRun(denoWorkflow, probeName) ?? "",
    /node scripts\/verify-deno-prepare-contract\.mjs/,
  );
  assert.match(
    denoWorkflow,
    /DENO_TOKENIZER_AUTH_TOKEN: \$\{\{ secrets\.PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN \}\}/,
  );
});
