#!/usr/bin/env bash
set -euo pipefail

node --input-type=module - ".github/workflows/preview-smoke.yml" <<'NODE'
import { readFileSync } from "node:fs";

const workflow = readFileSync(process.argv[2], "utf8");

function blockBetween(startMarker, endMarker) {
  const start = workflow.indexOf(startMarker);
  const end = workflow.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`workflow block not found: ${startMarker}`);
  return workflow.slice(start, end);
}

const testJob = blockBetween("  test:\n", "  version-smoke:");
if (!testJob.includes("      - name: Install zsh")) {
  throw new Error("test job must install zsh before running the Preview contract test");
}
if (!testJob.includes("sudo apt-get install --yes zsh")) {
  throw new Error("test job must install zsh through the runner package manager");
}

const upload = blockBetween(
  "      - name: Upload worker version",
  "      - name: Add uploaded version at 0% traffic",
);
if (!upload.includes('--secrets-file "$secrets_file"')) {
  throw new Error("version upload must include the Preview Worker secrets file");
}
if (!upload.includes("OCTG_UPSTREAM_API_TOKEN: ${{ secrets.OCTG_UPSTREAM_API_TOKEN }}")) {
  throw new Error("version upload must receive the Preview upstream token secret");
}
const uploadRun = upload.slice(upload.indexOf("        run: |"));
if (!upload.includes("PULL_REQUEST_NUMBER: ${{ github.event.pull_request.number }}")) {
  throw new Error("version upload must pass the pull request number through step env");
}
if (!upload.includes("PULL_REQUEST_HEAD_SHA: ${{ github.event.pull_request.head.sha }}")) {
  throw new Error("version upload must pass the pull request head SHA through step env");
}
if (uploadRun.includes("${{ github.event.pull_request.number }}") || uploadRun.includes("${{ github.event.pull_request.head.sha }}")) {
  throw new Error("version upload must not interpolate pull request context directly in run");
}
if (!uploadRun.includes('--tag "pr-${PULL_REQUEST_NUMBER}"')) {
  throw new Error("version upload must use the env-backed pull request number for its tag");
}
if (!uploadRun.includes('--message "pr-${PULL_REQUEST_NUMBER} ${PULL_REQUEST_HEAD_SHA}"')) {
  throw new Error("version upload must use env-backed pull request metadata for its message");
}
if (!upload.includes("OCTG_UPSTREAM_API_TOKEN: process.env.OCTG_UPSTREAM_API_TOKEN")) {
  throw new Error("Preview Worker secrets file must include the upstream token");
}

const previewConfig = blockBetween(
  "      - name: Prepare isolated preview config",
  "      - name: Apply preview D1 migrations",
);
for (const name of [
  "DENO_TOKENIZER_ENDPOINT",
  "DENO_TOKENIZER_THRESHOLD_BYTES",
  "DENO_TOKENIZER_TIMEOUT_MS",
]) {
  if (!previewConfig.includes(`delete config.vars.${name};`)) {
    throw new Error(`Preview config must not inherit the Production ${name} variable`);
  }
}

const restore = blockBetween(
  "      - name: Restore current version at 100% traffic",
  "      - name: Fail when smoke test failed",
);
if (!restore.includes("wrangler rollback")) {
  throw new Error("secret-aware cleanup must use Wrangler rollback");
}
if (restore.includes("wrangler versions deploy")) {
  throw new Error("secret-aware cleanup must not use versions deploy");
}

const previewSecretCleanup = blockBetween(
  "      - name: Remove stale Preview Worker Deno Secret",
  "      - name: Upload worker version",
);
if (!previewSecretCleanup.includes("wrangler versions secret list")) {
  throw new Error("Preview smoke must inspect the latest version secrets before upload");
}
if (!previewSecretCleanup.includes("--latest-version")) {
  throw new Error("Preview smoke must inspect secrets on the latest Worker version");
}
if (!previewSecretCleanup.includes("DENO_TOKENIZER_AUTH_TOKEN")) {
  throw new Error("Preview smoke must remove a stale Deno Worker Secret before upload");
}
if (!previewSecretCleanup.includes("wrangler versions secret delete")) {
  throw new Error("Preview smoke must use the versioned secret delete command for recovery");
}

const deploy = blockBetween(
  "      - name: Add uploaded version at 0% traffic",
  "      - name: Run smoke test with Version Override",
);
if (!deploy.includes("PULL_REQUEST_NUMBER: ${{ github.event.pull_request.number }}")) {
  throw new Error("traffic deployment must pass the pull request number through step env");
}
const deployRun = deploy.slice(deploy.indexOf("        run: |"));
if (deployRun.includes("${{ github.event.pull_request.number }}")) {
  throw new Error("traffic deployment must not interpolate pull request context directly in run");
}
if (!deployRun.includes('--message "PR ${PULL_REQUEST_NUMBER} smoke test"')) {
  throw new Error("traffic deployment must use the env-backed pull request number for its message");
}

const forkStart = workflow.indexOf("  version-smoke-fork:");
if (forkStart < 0) throw new Error("workflow block not found: version-smoke-fork");
const forkValidation = workflow.slice(forkStart);
if (!forkValidation.includes("github.event.pull_request.head.repo.fork == true")) {
  throw new Error("fork PRs must use an explicit secret-free validation path");
}
if (!forkValidation.includes("Secret-free fork validation")) {
  throw new Error("fork PR validation must report a successful secret-free result");
}
if (forkValidation.includes("environment: preview")) {
  throw new Error("fork PR validation must not request the preview environment");
}

const versionSmoke = blockBetween("  version-smoke:", "  version-smoke-fork:");
if (!versionSmoke.includes("github.event.pull_request.head.repo.fork != true")) {
  throw new Error("credential-bearing version smoke must skip fork PRs");
}
if (!versionSmoke.includes("assertPreviewQuotaAllocation")) {
  throw new Error("preview config must enforce the quota allocation ceiling");
}

const denoSmoke = blockBetween("  deno-version-smoke:", "  version-smoke-fork:");
if (!denoSmoke.includes("needs: version-smoke")) {
  throw new Error("Deno smoke must run after the existing DO-only Preview smoke");
}
if (!denoSmoke.includes("github.event.pull_request.head.repo.fork != true")) {
  throw new Error("credential-bearing Deno smoke must skip fork PRs");
}
if (!denoSmoke.includes("environment: preview")) {
  throw new Error("Deno smoke must use the Preview Environment");
}
if (!denoSmoke.includes("group: octg-preview-deno")) {
  throw new Error("Deno smoke must serialize access to the dedicated Preview Deno app");
}
for (const name of [
  "DENO_PREVIEW_DEPLOY_ORG",
  "DENO_PREVIEW_DEPLOY_APP",
  "DENO_PREVIEW_TOKENIZER_ENDPOINT",
  "DENO_PREVIEW_TOKENIZER_THRESHOLD_BYTES",
  "DENO_PREVIEW_TOKENIZER_TIMEOUT_MS",
]) {
  if (!denoSmoke.includes(`vars.${name}`)) {
    throw new Error(`Deno smoke must source ${name} from Preview Variables`);
  }
}
for (const name of [
  "DENO_PREVIEW_DEPLOY_TOKEN",
  "DENO_PREVIEW_TOKENIZER_AUTH_TOKEN",
]) {
  if (!denoSmoke.includes(`secrets.${name}`)) {
    throw new Error(`Deno smoke must source ${name} from Preview Secrets`);
  }
}
if (denoSmoke.includes("PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN")) {
  throw new Error("Deno smoke must not reference the Production tokenizer Secret");
}
if (!denoSmoke.includes("env load")) {
  throw new Error("Deno smoke must configure the Preview runtime Secret through env load");
}
if (!denoSmoke.includes("--replace")) {
  throw new Error("Deno smoke must replace an existing Preview runtime Secret");
}
if (!denoSmoke.includes("OCTG_TOKENIZER_AUTH_TOKEN")) {
  throw new Error("Deno smoke must load the runtime Secret under the Deno variable name");
}
if (!denoSmoke.includes("mode: 0o600")) {
  throw new Error("Deno smoke Secret files must be mode 0600");
}
if (!denoSmoke.includes("node scripts/preview-worker-config.mjs")) {
  throw new Error("Deno smoke must generate the isolated Deno Worker config");
}

const invalidUpload = blockBetween(
  "      - name: Upload invalid-auth Worker version",
  "      - name: Route invalid-auth version at 0% traffic",
);
if (!invalidUpload.includes("--secrets-file \"$secrets_file\"")) {
  throw new Error("invalid-auth Worker upload must use a temporary secrets file");
}
if (!invalidUpload.includes("DENO_TOKENIZER_AUTH_TOKEN")) {
  throw new Error("invalid-auth Worker upload must set the Deno Worker Secret binding");
}
if (!invalidUpload.includes("preview-invalid-token-sentinel")) {
  throw new Error("invalid-auth Worker upload must use the fixed non-secret sentinel");
}

const invalidRoute = blockBetween(
  "      - name: Route invalid-auth version at 0% traffic",
  "      - name: Run Deno smoke with invalid auth",
);
if (!invalidRoute.includes("@0%") || !invalidRoute.includes("@100%")) {
  throw new Error("invalid-auth version must remain at 0% beside the current 100% version");
}

const invalidSmoke = blockBetween(
  "      - name: Run Deno smoke with invalid auth",
  "      - name: Upload valid-auth Worker version",
);
if (!invalidSmoke.includes("OCTG_EXPECTED_HTTP_STATUS: 500")) {
  throw new Error("invalid-auth smoke must expect HTTP 500");
}
if (!invalidSmoke.includes("ci-smoke-test.sh")) {
  throw new Error("invalid-auth smoke must use the shared CI smoke helper");
}
if (!invalidSmoke.includes("continue-on-error: true")) {
  throw new Error("invalid-auth smoke must preserve cleanup after assertion failure");
}

const validUpload = blockBetween(
  "      - name: Upload valid-auth Worker version",
  "      - name: Route valid-auth version at 0% traffic",
);
if (!validUpload.includes("DENO_PREVIEW_TOKENIZER_AUTH_TOKEN")) {
  throw new Error("valid-auth Worker upload must receive the Preview tokenizer Secret");
}
if (!validUpload.includes("--secrets-file \"$secrets_file\"")) {
  throw new Error("valid-auth Worker upload must use a temporary secrets file");
}

const validRoute = blockBetween(
  "      - name: Route valid-auth version at 0% traffic",
  "      - name: Run Deno smoke with valid auth",
);
if (!validRoute.includes("@0%") || !validRoute.includes("@100%")) {
  throw new Error("valid-auth version must remain at 0% beside the current 100% version");
}

const validSmoke = blockBetween(
  "      - name: Run Deno smoke with valid auth",
  "      - name: Restore current Preview version at 100% traffic",
);
if (!validSmoke.includes("OCTG_EXPECTED_HTTP_STATUS: 200")) {
  throw new Error("valid-auth smoke must expect HTTP 200");
}
if (!validSmoke.includes("ci-smoke-test.sh")) {
  throw new Error("valid-auth smoke must use the shared CI smoke helper");
}

const denoRestore = blockBetween(
  "      - name: Restore current Preview version at 100% traffic",
  "      - name: Fail when Deno smoke failed",
);
if (!denoRestore.includes("always()")) {
  throw new Error("Deno smoke rollback must run after success or failure");
}
if (!denoRestore.includes("wrangler rollback")) {
  throw new Error("Deno smoke cleanup must use Wrangler rollback");
}
if (denoRestore.includes("wrangler versions deploy")) {
  throw new Error("Deno smoke cleanup must not use versions deploy");
}

const denoSecretCleanup = blockBetween(
  "      - name: Remove temporary Preview Worker Deno Secret",
  "      - name: Fail when Deno smoke failed",
);
if (!denoSecretCleanup.includes("always()")) {
  throw new Error("Deno Worker Secret cleanup must run after success or failure");
}
if (!denoSecretCleanup.includes("wrangler versions secret delete")) {
  throw new Error("Deno Worker Secret cleanup must use the versioned secret command");
}
if (!denoSecretCleanup.includes("DENO_TOKENIZER_AUTH_TOKEN")) {
  throw new Error("Deno Worker Secret cleanup must delete DENO_TOKENIZER_AUTH_TOKEN");
}
if (denoSecretCleanup.includes("wrangler secret bulk")) {
  throw new Error("Deno Worker Secret cleanup must not deploy the latest Worker version");
}
if (!denoSmoke.includes("Fail when Deno smoke failed")) {
  throw new Error("Deno smoke must fail after cleanup when either route assertion fails");
}

console.log("preview workflow contract: ok");
NODE
