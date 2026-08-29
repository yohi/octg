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
  'deno install'
  'deno task check'
  'deno task test'
  'deno deploy .'
  '--org "$DENO_DEPLOY_ORG"'
  '--app "$DENO_DEPLOY_APP"'
  '--prod'
  'DENO_DEPLOY_ORG'
  'DENO_DEPLOY_APP'
  'DENO_DEPLOY_TOKEN'
  'environment: deno-production'
)

for pattern in "${required_patterns[@]}"; do
  if ! grep -Fq -- "$pattern" "$workflow"; then
    printf 'workflow contract missing: %s\n' "$pattern" >&2
    exit 1
  fi
done

if grep -Fq 'denoland/deployctl@' "$workflow"; then
  printf 'workflow contract uses retired deployctl action\n' >&2
  exit 1
fi

if grep -Fq 'id-token: write' "$workflow"; then
  printf 'workflow contract uses obsolete Deno Deploy OIDC permission\n' >&2
  exit 1
fi

printf 'Deno Deploy workflow contract: ok\n'
