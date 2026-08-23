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
OCTG_KEY_PEPPER=test-pepper
GITHUB_REPOSITORY=yohi/octg
EOF

output="$(OCTG_PREVIEW_ENV_FILE="$TEMP_DIR/valid.env" zsh "$SCRIPT_PATH" --dry-run)"
[[ "$output" == *"d1_bindings=DB"* ]] || { print -u2 "dry-run did not generate a single DB binding"; exit 1; }
[[ "$output" == *"binding=DB"* ]] || { print -u2 "dry-run did not normalize the D1 binding"; exit 1; }
[[ "$output" == *"database_id=814c8fdb-dc9d-4a83-9065-001729ccd169"* ]] || { print -u2 "dry-run did not retain the Preview D1 ID"; exit 1; }
[[ "$output" == *"STANDARD=0"* && "$output" == *"MINI=100000"* ]] || { print -u2 "dry-run did not report quota limits"; exit 1; }
[[ "$output" != *"test-token"* && "$output" != *"test-pepper"* && "$output" != *"octg_sk_test"* ]] || { print -u2 "dry-run leaked a secret value"; exit 1; }

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
[[ "$reuse_output" != *"test-token"* && "$reuse_output" != *"test-pepper"* && "$reuse_output" != *"octg_sk_test"* ]] || {
  print -u2 "reuse flow leaked a secret value"
  exit 1
}
wrangler_log="$(< "$TEMP_DIR/wrangler.log")"
[[ "$wrangler_log" == *"d1 migrations apply DB --remote"* ]] || {
  print -u2 "reuse flow did not apply migrations"
  exit 1
}
[[ "$wrangler_log" == *"secret put OCTG_KEY_PEPPER --config"* ]] || {
  print -u2 "reuse flow did not synchronize the Worker pepper"
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

print "setup-preview dry-run contract: ok"
