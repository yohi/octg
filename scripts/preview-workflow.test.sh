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

const upload = blockBetween(
  "      - name: Upload worker version",
  "      - name: Add uploaded version at 0% traffic",
);
if (!upload.includes('--secrets-file "$secrets_file"')) {
  throw new Error("version upload must include the Preview Worker secrets file");
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

console.log("preview workflow contract: ok");
NODE
