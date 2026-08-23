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

console.log("preview workflow contract: ok");
NODE
