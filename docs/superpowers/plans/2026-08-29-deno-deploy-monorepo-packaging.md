# Deno Deploy Monorepo Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Deno tokenizer production deployment upload both the tokenizer app and its `packages/shared/src` dependency so Deno Deploy can build the revision.

**Architecture:** Keep PR validation rooted at `apps/deno-tokenizer`, but run the production `deno deploy` command from the repository root. A root `deno.json` will define the Deno Deploy manifest and dynamic entrypoint, preserving the existing relative import map and avoiding duplicated shared logic.

**Tech Stack:** GitHub Actions, Deno 2.9.5, Deno Deploy CLI, JSON, YAML, Bash, Ruby standard YAML/JSON libraries.

## Global Constraints

- `packages/shared` remains the single source of shared quota/tokenization arithmetic.
- `apps/deno-tokenizer` validation remains unchanged and runs before deployment.
- The deployment manifest must include `./deno.json`, `./apps/deno-tokenizer/**`, and `./packages/shared/src/**`.
- The runtime entrypoint must be `./apps/deno-tokenizer/src/main.ts` with dynamic runtime mode.
- Runtime secrets remain in Deno Deploy and are never added to GitHub Actions.
- The checked-in root `deno.json` must not hard-code deployment identity; the deploy job injects only non-secret org/app values in its ephemeral checkout.
- `DENO_DEPLOY_TOKEN` is scoped to the Deploy step and is never exposed to setup, validation, or configuration preparation steps.
- Cloudflare Worker workflows and tokenizer runtime behavior remain unchanged.
- Local verification must not perform a production deployment.
- Do not stage or modify the pre-existing untracked `deno.lock`.

---

### Task 1: Lock the repository-root deployment contract

**Files:**
- Modify: `scripts/deno-deploy-workflow.test.sh:16-219`
- Test: `scripts/deno-deploy-workflow.test.sh`

**Interfaces:**
- Consumes: `.github/workflows/deploy-deno-tokenizer.yml` and root `deno.json`.
- Produces: A failing-then-passing contract that rejects an app-only deploy root and incomplete source configuration.

- [x] **Step 1: Write the failing test**

Add JSON parsing to the Ruby heredoc invocation and replace the current app-root assertion:

```bash
ruby -ryaml -rjson - "$workflow" <<'RUBY'
```

Replace lines 169-171 with:

```ruby
unless deploy_step["working-directory"] == "."
  fail_contract('the "Deploy" step must run from repository root "."')
end
```

Immediately after the existing `deploy_run` fragment checks, add:

```ruby
begin
  deploy_config = JSON.parse(File.read("deno.json"))
rescue StandardError => error
  fail_contract("invalid root deno.json: #{error.message}")
end

deploy_config = require_mapping(deploy_config["deploy"], "deno.json.deploy")
include_paths = deploy_config["include"]
fail_contract("deno.json.deploy.include must be a list") unless include_paths.is_a?(Array)

required_deploy_paths = [
  "./deno.json",
  "./apps/deno-tokenizer/**",
  "./packages/shared/src/**",
]
missing_deploy_paths = required_deploy_paths - include_paths
unless missing_deploy_paths.empty?
  fail_contract("deno.json.deploy.include is missing: #{missing_deploy_paths.join(", ")}")
end

runtime = require_mapping(deploy_config["runtime"], "deno.json.deploy.runtime")
unless runtime["type"] == "dynamic"
  fail_contract('deno.json.deploy.runtime.type must be "dynamic"')
end
unless runtime["entrypoint"] == "./apps/deno-tokenizer/src/main.ts"
  fail_contract('deno.json.deploy.runtime.entrypoint must be ./apps/deno-tokenizer/src/main.ts')
end

identity_step = deploy_steps.find do |step|
  step.is_a?(Hash) && step["name"] == "Prepare Deno Deploy configuration"
end
fail_contract('jobs.deploy must prepare the Deno Deploy configuration') unless identity_step
identity_run = identity_step["run"].to_s
unless identity_step["working-directory"] == "."
  fail_contract('the configuration step must run from repository root "."')
end
[
  "DENO_DEPLOY_ORG",
  "DENO_DEPLOY_APP",
  "deploy.org",
  "deploy.app",
].each do |fragment|
  unless identity_run.include?(fragment)
    fail_contract("the configuration step is missing: #{fragment}")
  end
end
if identity_run.include?("DENO_DEPLOY_TOKEN")
  fail_contract("the configuration step must not write DENO_DEPLOY_TOKEN")
end
```

- [x] **Step 2: Run the contract test to verify it fails for the right reason**

Run:

```bash
npm run test:deno-deploy-workflow
```

Expected: FAIL with `the "Deploy" step must run from repository root "."`, because the current workflow still uses `apps/deno-tokenizer` and root `deno.json` does not exist.

### Task 2: Make the deployment manifest include the shared source

**Files:**
- Create: `deno.json`
- Modify: `.github/workflows/deploy-deno-tokenizer.yml:88-94`
- Test: `scripts/deno-deploy-workflow.test.sh`

**Interfaces:**
- Consumes: The existing app import map in `apps/deno-tokenizer/deno.json`.
- Produces: A root Deno Deploy source config and a root-based deploy command.

- [x] **Step 1: Add the minimal root Deno Deploy config**

Create `deno.json` with exactly this deployment configuration:

```json
{
  "deploy": {
    "include": [
      "./deno.json",
      "./apps/deno-tokenizer/**",
      "./packages/shared/src/**"
    ],
    "runtime": {
      "type": "dynamic",
      "entrypoint": "./apps/deno-tokenizer/src/main.ts"
    }
  }
}
```

- [x] **Step 2: Move only the deploy step to the repository root**

Change the deploy step from:

```yaml
      - name: Deploy
        working-directory: apps/deno-tokenizer
        run: |
```

to:

```yaml
      - name: Deploy
        working-directory: .
        run: |
```

Keep the command and environment unchanged:

```yaml
          deno deploy \
            --prod \
            --json \
            --non-interactive
```

- [x] **Step 3: Materialize the non-secret deployment identity**

Add this step immediately before `Deploy`, after configuration validation:

```yaml
      - name: Prepare Deno Deploy configuration
        working-directory: .
        run: |
          node <<'NODE'
          const fs = require("node:fs");
          const path = "deno.json";
          const config = JSON.parse(fs.readFileSync(path, "utf8"));
          config.deploy.org = process.env.DENO_DEPLOY_ORG;
          config.deploy.app = process.env.DENO_DEPLOY_APP;
          fs.writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
          NODE
```

`DENO_DEPLOY_TOKEN` is scoped to the `Deploy` step and must not be referenced
or written by this step.

- [x] **Step 4: Run the contract test to verify the minimal implementation passes**

Run:

```bash
npm run test:deno-deploy-workflow
```

Expected: PASS with `Deno Deploy workflow contract: ok`.

### Task 3: Document the corrected deployment root

**Files:**
- Modify: `docs/deno-tokenizer.md:34-77`
- Modify: `README.md` CI/CD section
- Test: `scripts/deno-deploy-workflow.test.sh`

**Interfaces:**
- Consumes: Root `deno.json` and the root-based workflow.
- Produces: Operator instructions that cannot recreate the app-only packaging failure.

- [x] **Step 1: Update the deployment instructions**

Change the GitHub Actions and manual deployment instructions to state that the repository root is the local deploy root, that root `deno.json` includes `apps/deno-tokenizer/**` and `packages/shared/src/**`, and that the runtime entrypoint is `apps/deno-tokenizer/src/main.ts`. The manual command must be run from the repository root after injecting the non-secret deployment identity into the local config:

```bash
# Run these commands from the repository root.
export DENO_DEPLOY_TOKEN
export DENO_DEPLOY_ORG="your-org"
export DENO_DEPLOY_APP="your-app"
node <<'NODE'
const fs = require("node:fs");
const path = "deno.json";
const config = JSON.parse(fs.readFileSync(path, "utf8"));
config.deploy.org = process.env.DENO_DEPLOY_ORG;
config.deploy.app = process.env.DENO_DEPLOY_APP;
fs.writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
NODE
deno deploy --prod --json --non-interactive
unset DENO_DEPLOY_TOKEN
unset DENO_DEPLOY_ORG DENO_DEPLOY_APP
```

The local preparation adds only non-secret identity fields. Use a clean
checkout or remove those fields before committing unrelated changes.

Keep `OCTG_TOKENIZER_AUTH_TOKEN` documented as a Deno Deploy runtime Secret, not a GitHub Environment Secret.

- [x] **Step 2: Update the repository CI/CD description**

State that validation still runs from `apps/deno-tokenizer`, while the gated production deploy runs from the repository root using the root `deno.json` manifest.

- [x] **Step 3: Verify documentation references**

Run:

```bash
rg -n 'deno deploy|deno.json|packages/shared|DENO_DEPLOY_TOKEN|OCTG_TOKENIZER_AUTH_TOKEN' README.md docs/deno-tokenizer.md .github/workflows/deploy-deno-tokenizer.yml
```

Expected: The docs and workflow consistently distinguish validation directory, deployment root, build entrypoint, and runtime Secret ownership.

### Task 4: Verify the collected manifest without production credentials

**Files:**
- Test: `scripts/deno-deploy-workflow.test.sh`
- Inspect: `deno.json`, `.github/workflows/deploy-deno-tokenizer.yml`

**Interfaces:**
- Consumes: Root deployment configuration and the Deno 2.9.5 CLI.
- Produces: Evidence that `packages/shared/src` is present in the local upload manifest.

- [x] **Step 1: Add dummy deployment identity for the local-only check**

Before the manifest check, temporarily add `deploy.org: "debug-org"` and
`deploy.app: "debug-app"` to the local `deno.json`. Restore the portable
checked-in form immediately after the check; do not commit the dummy values.

- [x] **Step 2: Run Deno's local manifest collection with a dummy token**

Run from the repository root:

```bash
set -o pipefail
DENO_DEPLOY_ORG=debug-org DENO_DEPLOY_APP=debug-app DENO_DEPLOY_TOKEN=invalid \
  deno deploy --prod --json --non-interactive --debug 2>&1 \
  | rg -n -e 'deploy config|collect_files|packages/shared/src|apps/deno-tokenizer/src/main.ts|AUTH_INVALID_TOKEN|invalid or expired'
```

Expected: Debug output shows the root deploy config and collected `packages/shared/src` paths, then terminates with the expected dummy-token authentication error. No real credential or production revision is used.

- [x] **Step 3: Confirm the old app-only manifest condition is gone**

Run:

```bash
DENO_DEPLOY_ORG=debug-org DENO_DEPLOY_APP=debug-app DENO_DEPLOY_TOKEN=invalid \
  deno deploy --prod --json --non-interactive --debug 2>&1 \
  | rg -n 'collect_files|packages/shared/src|root="'
```

Expected: The collector root is the repository root and the manifest includes shared source paths; absence of a successful authentication is expected.

### Task 5: Run the repository quality gates

**Files:**
- Inspect: all modified files from Tasks 1-3

**Interfaces:**
- Consumes: The completed workflow, root Deno config, tests, and documentation.
- Produces: Verified changes ready for PR review; no production deployment is triggered locally.

- [x] **Step 1: Run the tokenizer checks**

Run:

```bash
deno install --node-modules-dir=auto
deno task check
deno task test
```

from `apps/deno-tokenizer`.

Expected: Typecheck and tokenizer tests pass.

- [x] **Step 2: Run repository checks**

Run:

```bash
npm test
npm run typecheck
npm run test:deno-deploy-workflow
shellcheck scripts/deno-deploy-workflow.test.sh
GIT_MASTER=1 git diff --check
```

Expected: All commands pass. Do not include the pre-existing untracked `deno.lock` in any diff or staging operation.

- [x] **Step 3: Inspect the final diff and worktree**

Run:

```bash
GIT_MASTER=1 git diff -- deno.json .github/workflows/deploy-deno-tokenizer.yml scripts/deno-deploy-workflow.test.sh README.md docs/deno-tokenizer.md docs/superpowers/specs/2026-08-29-deno-deploy-monorepo-packaging-design.md docs/superpowers/plans/2026-08-29-deno-deploy-monorepo-packaging.md
GIT_MASTER=1 git status --short --branch
```

Expected: Only intended files are modified; `deno.lock` remains untracked and untouched. Do not commit, push, or trigger a production deployment without an explicit user request.
