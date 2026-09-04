import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));

test("deploy-production workflow preserves remote environment variables using --keep-vars", () => {
  const workflowPath = join(root, ".github/workflows/deploy-production.yml");
  const workflow = readFileSync(workflowPath, "utf8");

  // Ensure wrangler deploy preserves remote environment variables
  assert.match(
    workflow,
    /wrangler deploy.*--keep-vars/,
    "deploy-production workflow must include --keep-vars to prevent erasing remote variables like Deno settings",
  );
});
