#!/usr/bin/env zsh
set -euo pipefail

ROOT_DIR="${0:A:h:h}"
BASE_CONFIG="$ROOT_DIR/apps/gateway-worker/wrangler.jsonc"
WRANGLER="${OCTG_PREVIEW_WRANGLER:-$ROOT_DIR/node_modules/.bin/wrangler}"
ENV_FILE="${OCTG_PREVIEW_ENV_FILE:-$ROOT_DIR/.env}"
TEMP_DIR=""
PREVIEW_CONFIG=""
DRY_RUN=false
CONFIGURE_GITHUB=false

usage() {
  cat <<'EOF'
使い方:
  zsh scripts/setup-preview.zsh [--dry-run] [--github]

オプション:
  --dry-run  env値と一時Wrangler configだけを検証し、Cloudflare/GitHubへ接続しない
  --github   GitHub Environment `preview` のVariables/Secretsも設定する
  --help     このヘルプを表示する

デフォルトの入力ファイル:
  .env

.envはshellとして実行せず、Preview用の変数だけを安全に読み込みます。
ProductionのOCTG_KEY_PEPPERはPreview用pepperへ流用しません。

別のファイルを使う場合:
  OCTG_PREVIEW_ENV_FILE=/path/to/preview.env zsh scripts/setup-preview.zsh
EOF
}

die() {
  print -u2 -- "error: $*"
  exit 1
}

cleanup() {
  if [[ -n "$TEMP_DIR" && -d "$TEMP_DIR" ]]; then
    rm -rf -- "$TEMP_DIR"
  fi
  unset CLOUDFLARE_PREVIEW_API_TOKEN OCTG_PREVIEW_CLIENT_KEY OCTG_PREVIEW_KEY_PEPPER OCTG_KEY_PEPPER
}

trap cleanup EXIT HUP INT TERM

for argument in "$@"; do
  case "$argument" in
    --dry-run)
      DRY_RUN=true
      ;;
    --github)
      CONFIGURE_GITHUB=true
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "不明な引数です: $argument"
      ;;
  esac
done

[[ -f "$ENV_FILE" ]] || die "$ENV_FILE がありません。envテンプレートへ値を入力してください"
[[ -x "$WRANGLER" ]] || die "$WRANGLER がありません。先に npm install を実行してください"

chmod 600 "$ENV_FILE"

load_preview_value() {
  local name="$1"
  local value
  [[ -v "$name" ]] && return 0
  value="$(node --input-type=module - "$ROOT_DIR" "$ENV_FILE" "$name" <<'NODE'
import { readFileSync } from "node:fs";

const [root, envFile, name] = process.argv.slice(2);
const { parseSetupEnvFile } = await import(`${root}/scripts/setup-env.mjs`);
const values = parseSetupEnvFile(readFileSync(envFile, "utf8"));
  const value = values[name];
  if (typeof value === "string") process.stdout.write(value);
NODE
)"
  if [[ -n "$value" ]]; then
    typeset -g "$name=$value"
  fi
  return 0
}

for name in \
  CLOUDFLARE_PREVIEW_ACCOUNT_ID \
  CLOUDFLARE_PREVIEW_API_TOKEN \
  OCTG_PREVIEW_DATABASE_ID \
  OCTG_PREVIEW_DATABASE_NAME \
  OCTG_PREVIEW_WORKER_NAME \
  OCTG_PREVIEW_UPSTREAM_BASE_URL \
  OCTG_PREVIEW_BASE_URL \
  OCTG_PREVIEW_QUOTA_LIMIT_STANDARD \
  OCTG_PREVIEW_QUOTA_LIMIT_MINI \
  OCTG_PREVIEW_CLIENT_ID \
  OCTG_PREVIEW_CLIENT_NAME \
  OCTG_PREVIEW_CLIENT_KEY \
  OCTG_PREVIEW_KEY_PEPPER \
  GITHUB_REPOSITORY \
  SMOKE_MODEL; do
  load_preview_value "$name"
done

require_value() {
  local name="$1"
  local value="$2"
  [[ -n "$value" && "$value" != *"<"* && "$value" != *">"* ]] || die "$name に実値を入力してください"
}

require_non_negative_integer() {
  local name="$1"
  local value="$2"
  [[ "$value" =~ '^(0|[1-9][0-9]*)$' ]] || die "$name は0以上の整数である必要があります"
}

require_positive_integer() {
  local name="$1"
  local value="$2"
  [[ "$value" =~ '^[1-9][0-9]*$' ]] || die "$name は正の整数である必要があります"
}

require_uuid() {
  local name="$1"
  local value="$2"
  [[ "$value" =~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' ]] || die "$name はUUIDである必要があります"
}

require_https_url() {
  local name="$1"
  local value="$2"
  require_value "$name" "$value"
  [[ "$value" == https://* && "$value" != *[[:space:]]* ]] || die "$name は空白を含まないhttps URLである必要があります"
}

require_value CLOUDFLARE_PREVIEW_ACCOUNT_ID "${CLOUDFLARE_PREVIEW_ACCOUNT_ID:-}"
[[ "${CLOUDFLARE_PREVIEW_ACCOUNT_ID}" =~ '^[0-9a-fA-F]{32}$' ]] || die "CLOUDFLARE_PREVIEW_ACCOUNT_ID は32桁のhex文字列である必要があります"
require_value CLOUDFLARE_PREVIEW_API_TOKEN "${CLOUDFLARE_PREVIEW_API_TOKEN:-}"
require_value OCTG_PREVIEW_DATABASE_NAME "${OCTG_PREVIEW_DATABASE_NAME:-}"
[[ "${OCTG_PREVIEW_DATABASE_NAME}" =~ '^[a-z0-9][a-z0-9-]*$' ]] || die "OCTG_PREVIEW_DATABASE_NAME に使用できない文字があります"
require_value OCTG_PREVIEW_WORKER_NAME "${OCTG_PREVIEW_WORKER_NAME:-}"
require_https_url OCTG_PREVIEW_UPSTREAM_BASE_URL "${OCTG_PREVIEW_UPSTREAM_BASE_URL:-}"
require_https_url OCTG_PREVIEW_BASE_URL "${OCTG_PREVIEW_BASE_URL:-}"
require_non_negative_integer OCTG_PREVIEW_QUOTA_LIMIT_STANDARD "${OCTG_PREVIEW_QUOTA_LIMIT_STANDARD:-}"
require_positive_integer OCTG_PREVIEW_QUOTA_LIMIT_MINI "${OCTG_PREVIEW_QUOTA_LIMIT_MINI:-}"
require_value OCTG_PREVIEW_CLIENT_ID "${OCTG_PREVIEW_CLIENT_ID:-}"
require_value OCTG_PREVIEW_CLIENT_NAME "${OCTG_PREVIEW_CLIENT_NAME:-}"
require_value OCTG_PREVIEW_CLIENT_KEY "${OCTG_PREVIEW_CLIENT_KEY:-}"
[[ "${OCTG_PREVIEW_CLIENT_KEY}" == octg_sk_* ]] || die "OCTG_PREVIEW_CLIENT_KEY はoctg_sk_で始める必要があります"
require_value OCTG_PREVIEW_KEY_PEPPER "${OCTG_PREVIEW_KEY_PEPPER:-}"

if [[ "$CONFIGURE_GITHUB" == true ]]; then
  require_value GITHUB_REPOSITORY "${GITHUB_REPOSITORY:-}"
  [[ "${GITHUB_REPOSITORY}" == */* ]] || die "GITHUB_REPOSITORY はowner/repository形式である必要があります"
  command -v gh >/dev/null 2>&1 || die "--githubにはGitHub CLI (gh) が必要です"
fi

run_wrangler() {
  CLOUDFLARE_API_TOKEN="$CLOUDFLARE_PREVIEW_API_TOKEN" \
  CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_PREVIEW_ACCOUNT_ID" \
    "$WRANGLER" "$@"
}

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/octg-preview.XXXXXX")"
PREVIEW_DATABASE_ID="${OCTG_PREVIEW_DATABASE_ID:-}"
if [[ -z "$PREVIEW_DATABASE_ID" ]]; then
  if [[ "$DRY_RUN" == true ]]; then
    die "OCTG_PREVIEW_DATABASE_IDが空です。--dry-runではD1作成を行わないため入力してください"
  fi
  DATABASE_LIST="$TEMP_DIR/d1-databases.json"
  run_wrangler d1 list --json > "$DATABASE_LIST"
  PREVIEW_DATABASE_ID="$(node --input-type=module - "$ROOT_DIR" "$DATABASE_LIST" "$OCTG_PREVIEW_DATABASE_NAME" <<'NODE'
import { readFileSync } from "node:fs";

const [root, databaseListPath, databaseName] = process.argv.slice(2);
const { resolvePreviewDatabaseId } = await import(`${root}/scripts/preview-d1-resolver.mjs`);
const databaseId = resolvePreviewDatabaseId(readFileSync(databaseListPath, "utf8"), databaseName);
if (databaseId) process.stdout.write(databaseId);
NODE
)"
  if [[ -n "$PREVIEW_DATABASE_ID" ]]; then
    print "既存のPreview D1を再利用します: $OCTG_PREVIEW_DATABASE_NAME"
  else
    print "Preview D1を作成します。Wranglerの出力後、database_idを入力してください。"
    run_wrangler d1 create "$OCTG_PREVIEW_DATABASE_NAME" --binding DB
    print -n "Preview D1 database_id: "
    read -r PREVIEW_DATABASE_ID
  fi
fi
require_uuid OCTG_PREVIEW_DATABASE_ID "$PREVIEW_DATABASE_ID"
PREVIEW_CONFIG="$TEMP_DIR/wrangler.jsonc"

node --input-type=module - "$ROOT_DIR" "$BASE_CONFIG" "$PREVIEW_CONFIG" \
  "$PREVIEW_DATABASE_ID" "$OCTG_PREVIEW_DATABASE_NAME" "$OCTG_PREVIEW_WORKER_NAME" \
  "$OCTG_PREVIEW_UPSTREAM_BASE_URL" "$OCTG_PREVIEW_QUOTA_LIMIT_STANDARD" \
  "$OCTG_PREVIEW_QUOTA_LIMIT_MINI" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as ts from "typescript";

const [root, baseConfigPath, outputPath, databaseId, databaseName, workerName, upstreamBaseUrl, standardLimit, miniLimit] = process.argv.slice(2);
const source = readFileSync(baseConfigPath, "utf8");
const parsed = ts.parseConfigFileTextToJson(baseConfigPath, source);
if (parsed.error) {
  throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n"));
}

const config = parsed.config;
const productionDatabase = Array.isArray(config.d1_databases)
  ? config.d1_databases.find((entry) => entry.binding === "DB")
  : undefined;
if (!productionDatabase) {
  throw new Error("wrangler.jsoncにDB bindingがありません");
}

config.name = workerName;
config.main = resolve(root, "apps/gateway-worker/src/index.ts");
config.assets.directory = resolve(root, "apps/gateway-worker/public");
config.vars = {
  ...config.vars,
  QUOTA_LIMIT_STANDARD: standardLimit,
  QUOTA_LIMIT_MINI: miniLimit,
  OCTG_UPSTREAM_BASE_URL: upstreamBaseUrl,
};
config.d1_databases = [
  {
    ...productionDatabase,
    binding: "DB",
    database_name: databaseName,
    database_id: databaseId,
    migrations_dir: resolve(root, "db/migrations"),
    remote: true,
  },
];

writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`generated config: d1_bindings=${config.d1_databases.map((entry) => entry.binding).join(",")}\n`);
NODE

print "Preview config: binding=DB database_id=$PREVIEW_DATABASE_ID"
print "Preview quota: STANDARD=$OCTG_PREVIEW_QUOTA_LIMIT_STANDARD MINI=$OCTG_PREVIEW_QUOTA_LIMIT_MINI"

if [[ "$DRY_RUN" == true ]]; then
  print "dry-run: Cloudflare D1 migration and client seedは実行しません"
  if [[ "$CONFIGURE_GITHUB" == true ]]; then
    print "dry-run: GitHub Environment previewの設定も実行しません (repo=$GITHUB_REPOSITORY)"
  fi
  exit 0
fi

run_wrangler d1 migrations apply DB --remote --config "$PREVIEW_CONFIG"

SEED_SQL="$TEMP_DIR/seed.sql"
OCTG_KEY_PEPPER="$OCTG_PREVIEW_KEY_PEPPER" \
  node "$ROOT_DIR/scripts/seed-client.mjs" \
    "$OCTG_PREVIEW_CLIENT_ID" "$OCTG_PREVIEW_CLIENT_NAME" "$OCTG_PREVIEW_CLIENT_KEY" REJECT \
    > "$SEED_SQL"
chmod 600 "$SEED_SQL"
run_wrangler d1 execute DB --remote --file "$SEED_SQL" --config "$PREVIEW_CONFIG"

if [[ "$CONFIGURE_GITHUB" == true ]]; then
  set_github_variable() {
    gh variable set "$1" --env preview --repo "$GITHUB_REPOSITORY" --body "$2"
  }

  set_github_secret() {
    print -rn -- "$2" | gh secret set "$1" --env preview --repo "$GITHUB_REPOSITORY"
  }

  set_github_variable CLOUDFLARE_PREVIEW_ACCOUNT_ID "$CLOUDFLARE_PREVIEW_ACCOUNT_ID"
  set_github_variable OCTG_PREVIEW_DATABASE_ID "$PREVIEW_DATABASE_ID"
  set_github_variable OCTG_PREVIEW_UPSTREAM_BASE_URL "$OCTG_PREVIEW_UPSTREAM_BASE_URL"
  set_github_variable OCTG_PREVIEW_BASE_URL "$OCTG_PREVIEW_BASE_URL"
  set_github_variable OCTG_PREVIEW_WORKER_NAME "$OCTG_PREVIEW_WORKER_NAME"
  set_github_variable OCTG_PREVIEW_QUOTA_LIMIT_STANDARD "$OCTG_PREVIEW_QUOTA_LIMIT_STANDARD"
  set_github_variable OCTG_PREVIEW_QUOTA_LIMIT_MINI "$OCTG_PREVIEW_QUOTA_LIMIT_MINI"
  set_github_variable SMOKE_MODEL "${SMOKE_MODEL:-gpt-5-mini}"
  set_github_secret CLOUDFLARE_PREVIEW_API_TOKEN "$CLOUDFLARE_PREVIEW_API_TOKEN"
  set_github_secret OCTG_PREVIEW_SMOKE_API_KEY "$OCTG_PREVIEW_CLIENT_KEY"
  set_github_secret OCTG_KEY_PEPPER "$OCTG_PREVIEW_KEY_PEPPER"
fi

print "Preview D1 migrationとCI client seedが完了しました: client_id=$OCTG_PREVIEW_CLIENT_ID"
if [[ "$CONFIGURE_GITHUB" == true ]]; then
  print "GitHub Environment previewのVariables/Secrets設定が完了しました: repo=$GITHUB_REPOSITORY"
else
  print "GitHub設定は未実行です。必要なら --github を付けて再実行してください。"
fi
