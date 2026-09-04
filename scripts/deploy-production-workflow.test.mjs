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
    const isWranglerDeploy = tokens.some(
      (token, index) =>
        (token === "wrangler" || token.endsWith("/wrangler")) &&
        tokens[index + 1] === "deploy",
    );
    return isWranglerDeploy && tokens.includes("--keep-vars");
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
