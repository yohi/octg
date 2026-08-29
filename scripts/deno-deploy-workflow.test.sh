#!/usr/bin/env bash
set -euo pipefail

workflow=".github/workflows/deploy-deno-tokenizer.yml"

if [[ ! -f "$workflow" ]]; then
  printf 'missing workflow: %s\n' "$workflow" >&2
  exit 1
fi

required_patterns=(
  'pull_request:'
  'push:'
  'apps/deno-tokenizer/**'
  'packages/shared/**'
  'denoland/setup-deno@'
  'deno task check'
  'deno task test'
  'id-token: write'
  'denoland/deployctl@v1'
  'apps/deno-tokenizer/src/main.ts'
  'DENO_DEPLOY_PROJECT'
  'environment: deno-production'
)

for pattern in "${required_patterns[@]}"; do
  if ! grep -Fq "$pattern" "$workflow"; then
    printf 'workflow contract missing: %s\n' "$pattern" >&2
    exit 1
  fi
done

printf 'Deno Deploy workflow contract: ok\n'
