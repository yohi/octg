#!/usr/bin/env zsh
set -euo pipefail

ROOT_DIR="${0:A:h:h}"
SCRIPT_PATH="$ROOT_DIR/scripts/setup-preview.zsh"
TEMP_DIR="$(mktemp -d)"

cleanup() {
  node -e 'require("node:fs").rmSync(process.argv[1], { recursive: true, force: true })' "$TEMP_DIR"
}
trap cleanup EXIT

cat > "$TEMP_DIR/valid.env" <<'EOF'
CLOUDFLARE_PREVIEW_ACCOUNT_ID=4bc6b4d26ae21d2b0d5bbb7ce91f1cda
CLOUDFLARE_PREVIEW_API_TOKEN=test-token
OCTG_PREVIEW_UPSTREAM_API_TOKEN=preview-upstream-token
OCTG_PREVIEW_DATABASE_ID=814c8fdb-dc9d-4a83-9065-001729ccd169
OCTG_PREVIEW_DATABASE_NAME=octg-gateway-preview-db
OCTG_PREVIEW_WORKER_NAME=octg-gateway-preview
OCTG_PREVIEW_UPSTREAM_BASE_URL=https://gateway.example.test/v1/account/gateway/openai
OCTG_PREVIEW_BASE_URL=https://octg-gateway-preview.example.workers.dev
OCTG_PREVIEW_QUOTA_LIMIT_STANDARD=0
OCTG_PREVIEW_QUOTA_LIMIT_MINI=100000
OCTG_PREVIEW_CLIENT_ID=client_ci_smoke
OCTG_PREVIEW_CLIENT_NAME="CI Smoke"
OCTG_PREVIEW_CLIENT_KEY=octg_sk_test
OCTG_PREVIEW_KEY_PEPPER=test-pepper
GITHUB_REPOSITORY=yohi/octg
EOF

output="$(OCTG_PREVIEW_ENV_FILE="$TEMP_DIR/valid.env" zsh "$SCRIPT_PATH" --dry-run)"
[[ "$output" == *"d1_bindings=DB"* ]] || { print -u2 "dry-run did not generate a single DB binding"; exit 1; }
[[ "$output" == *"binding=DB"* ]] || { print -u2 "dry-run did not normalize the D1 binding"; exit 1; }
[[ "$output" == *"database_id=814c8fdb-dc9d-4a83-9065-001729ccd169"* ]] || { print -u2 "dry-run did not retain the Preview D1 ID"; exit 1; }
[[ "$output" == *"STANDARD=0"* && "$output" == *"MINI=100000"* ]] || { print -u2 "dry-run did not report quota limits"; exit 1; }
[[ "$output" != *"test-token"* && "$output" != *"preview-upstream-token"* && "$output" != *"test-pepper"* && "$output" != *"octg_sk_test"* ]] || { print -u2 "dry-run leaked a secret value"; exit 1; }

MARKER="$TEMP_DIR/command-substitution-ran"
cat > "$TEMP_DIR/consolidated.env" <<EOF
# Production values remain in the same file but must not be executed by zsh.
CLOUDFLARE_ACCOUNT_ID=<production-account-id>
OCTG_LOCAL_UPSTREAM_BASE_URL=https://gateway.example.test/v1/<account_id>/<gateway_id>/openai
OCTG_PREVIEW_DATABASE_ID=814c8fdb-dc9d-4a83-9065-001729ccd169
CLOUDFLARE_PREVIEW_ACCOUNT_ID=4bc6b4d26ae21d2b0d5bbb7ce91f1cda
CLOUDFLARE_PREVIEW_API_TOKEN=preview-token
OCTG_PREVIEW_UPSTREAM_API_TOKEN=preview-upstream-token
OCTG_PREVIEW_DATABASE_NAME=octg-gateway-preview-db
OCTG_PREVIEW_WORKER_NAME=octg-gateway-preview
OCTG_PREVIEW_UPSTREAM_BASE_URL=https://gateway.example.test/v1/account/gateway/openai
OCTG_PREVIEW_BASE_URL=https://octg-gateway-preview.example.workers.dev
OCTG_PREVIEW_QUOTA_LIMIT_STANDARD=0
OCTG_PREVIEW_QUOTA_LIMIT_MINI=100000
OCTG_PREVIEW_CLIENT_ID=client_ci_smoke
OCTG_PREVIEW_CLIENT_NAME=CI Smoke
OCTG_PREVIEW_CLIENT_KEY=octg_sk_preview
OCTG_PREVIEW_KEY_PEPPER=preview-pepper
UNRELATED_COMMAND=\$(touch "$MARKER")
EOF
if ! consolidated_output="$(OCTG_PREVIEW_ENV_FILE="$TEMP_DIR/consolidated.env" zsh "$SCRIPT_PATH" --dry-run)"; then
  print -u2 "consolidated .env dry-run failed"
  exit 1
fi
[[ ! -e "$MARKER" ]] || { print -u2 "consolidated .env executed an unrelated command"; exit 1; }
[[ "$consolidated_output" != *"preview-token"* && "$consolidated_output" != *"preview-upstream-token"* && "$consolidated_output" != *"preview-pepper"* && "$consolidated_output" != *"octg_sk_preview"* ]] || {
  print -u2 "consolidated .env dry-run leaked a secret value"
  exit 1
}

sed '/^OCTG_PREVIEW_KEY_PEPPER=/d' "$TEMP_DIR/valid.env" > "$TEMP_DIR/missing-preview-pepper.env"
if OCTG_KEY_PEPPER=production-pepper \
  OCTG_PREVIEW_ENV_FILE="$TEMP_DIR/missing-preview-pepper.env" \
  zsh "$SCRIPT_PATH" --dry-run > /dev/null 2>&1; then
  print -u2 "Preview setup reused a Production pepper"
  exit 1
fi

sed '/^OCTG_PREVIEW_UPSTREAM_API_TOKEN=/d' "$TEMP_DIR/valid.env" > "$TEMP_DIR/missing-preview-upstream-token.env"
if OCTG_PREVIEW_ENV_FILE="$TEMP_DIR/missing-preview-upstream-token.env" zsh "$SCRIPT_PATH" --dry-run > /dev/null 2>&1; then
  print -u2 "Preview setup accepted a missing upstream API token"
  exit 1
fi

sed 's/OCTG_PREVIEW_QUOTA_LIMIT_MINI=100000/OCTG_PREVIEW_QUOTA_LIMIT_MINI=0/' \
  "$TEMP_DIR/valid.env" > "$TEMP_DIR/invalid.env"
if OCTG_PREVIEW_ENV_FILE="$TEMP_DIR/invalid.env" zsh "$SCRIPT_PATH" --dry-run > /dev/null 2>&1; then
  print -u2 "invalid quota limit was accepted"
  exit 1
fi

cat > "$TEMP_DIR/wrangler" <<'EOF'
#!/usr/bin/env zsh
if [[ "$1" == d1 && "$2" == list && "$3" == --json ]]; then
  if [[ "${OCTG_TEST_D1_LIST_MODE:-existing}" == empty ]]; then
    print '[]'
  else
    print '[{"name":"octg-gateway-preview-db","uuid":"814c8fdb-dc9d-4a83-9065-001729ccd169"}]'
  fi
  exit 0
fi
print -r -- "$*" >> "$OCTG_TEST_WRANGLER_LOG"
if [[ "$1" == d1 && "$2" == create && "${OCTG_TEST_D1_LIST_MODE:-existing}" != empty ]]; then
  print -u2 "unexpected d1 create"
  exit 1
fi
exit 0
EOF
chmod 700 "$TEMP_DIR/wrangler"
cat > "$TEMP_DIR/gh" <<'EOF'
#!/usr/bin/env zsh
print -r -- "$*" >> "$OCTG_TEST_GH_LOG"
if [[ "$1" == secret && "$2" == set ]]; then
  while IFS= read -r line; do
    :
  done
fi
exit 0
EOF
chmod 700 "$TEMP_DIR/gh"
sed 's/^OCTG_PREVIEW_DATABASE_ID=.*/OCTG_PREVIEW_DATABASE_ID=/' \
  "$TEMP_DIR/valid.env" > "$TEMP_DIR/reuse.env"
reuse_output="$(
  OCTG_PREVIEW_ENV_FILE="$TEMP_DIR/reuse.env" \
  OCTG_PREVIEW_WRANGLER="$TEMP_DIR/wrangler" \
  OCTG_TEST_WRANGLER_LOG="$TEMP_DIR/wrangler.log" \
  zsh "$SCRIPT_PATH"
)"
[[ "$reuse_output" == *"既存のPreview D1を再利用します: octg-gateway-preview-db"* ]] || {
  print -u2 "existing Preview D1 was not reused"
  exit 1
}
[[ "$reuse_output" != *"test-token"* && "$reuse_output" != *"preview-upstream-token"* && "$reuse_output" != *"test-pepper"* && "$reuse_output" != *"octg_sk_test"* ]] || {
  print -u2 "reuse flow leaked a secret value"
  exit 1
}
wrangler_log="$(< "$TEMP_DIR/wrangler.log")"
[[ "$wrangler_log" == *"d1 migrations apply DB --remote"* ]] || {
  print -u2 "reuse flow did not apply migrations"
  exit 1
}
[[ "$wrangler_log" != *"secret put OCTG_KEY_PEPPER"* ]] || {
  print -u2 "reuse flow attempted an unsafe regular Worker secret update"
  exit 1
}
[[ "$wrangler_log" == *"d1 execute DB --remote"* ]] || {
  print -u2 "reuse flow did not seed the client"
  exit 1
}
[[ "$wrangler_log" != *"d1 create"* ]] || {
  print -u2 "reuse flow attempted to create an existing D1"
  exit 1
}

no_match_output="$(
  OCTG_PREVIEW_ENV_FILE="$TEMP_DIR/reuse.env" \
  OCTG_PREVIEW_WRANGLER="$TEMP_DIR/wrangler" \
  OCTG_TEST_D1_LIST_MODE=empty \
  OCTG_TEST_WRANGLER_LOG="$TEMP_DIR/no-match-wrangler.log" \
  zsh "$SCRIPT_PATH" <<< "814c8fdb-dc9d-4a83-9065-001729ccd169"
)"
[[ "$no_match_output" == *"Preview D1を作成します。"* ]] || {
  print -u2 "missing Preview D1 did not enter the create flow"
  exit 1
}
no_match_log="$(< "$TEMP_DIR/no-match-wrangler.log")"
[[ "$no_match_log" == *"d1 create octg-gateway-preview-db --binding DB"* ]] || {
  print -u2 "missing Preview D1 did not invoke create"
  exit 1
}

github_output="$(
  PATH="$TEMP_DIR:$PATH" \
  OCTG_PREVIEW_ENV_FILE="$TEMP_DIR/valid.env" \
  OCTG_PREVIEW_WRANGLER="$TEMP_DIR/wrangler" \
  OCTG_TEST_GH_LOG="$TEMP_DIR/gh.log" \
  OCTG_TEST_WRANGLER_LOG="$TEMP_DIR/github-wrangler.log" \
  zsh "$SCRIPT_PATH" --github
)"
gh_log="$(< "$TEMP_DIR/gh.log")"
[[ "$github_output" != *"test-pepper"* && "$github_output" != *"octg_sk_test"* ]] || {
  print -u2 "GitHub setup output leaked a secret value"
  exit 1
}
[[ "$gh_log" == *"secret set OCTG_KEY_PEPPER --env preview --repo yohi/octg"* ]] || {
  print -u2 "GitHub setup did not synchronize the Worker pepper secret"
  exit 1
}
[[ "$gh_log" == *"secret set OCTG_UPSTREAM_API_TOKEN --env preview --repo yohi/octg"* ]] || {
  print -u2 "GitHub setup did not synchronize the Preview upstream token secret"
  exit 1
}
[[ "$gh_log" != *"test-pepper"* && "$gh_log" != *"preview-upstream-token"* && "$gh_log" != *"octg_sk_test"* ]] || {
  print -u2 "GitHub setup leaked a secret value"
  exit 1
}

print "setup-preview dry-run contract: ok"
