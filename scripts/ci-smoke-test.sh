#!/usr/bin/env bash
# CI 用疎通テストスクリプト。
# Usage: scripts/ci-smoke-test.sh <base-url> <model>
#   base-url : 対象 Worker のベース URL (例: https://xxxxx-octg-gateway.example.workers.dev)
#   model    : 疎通テストに使うモデル名 (例: gpt-5-mini)
# Env:
#   OCTG_SMOKE_API_KEY : クライアントキー (octg_sk_*)。必須。ログへ出力しないこと。
#   OCTG_VERSION_OVERRIDE : Version Override 対象の Worker Version ID。指定時だけ header を付ける。
#   OCTG_VERSION_OVERRIDE_WORKER_NAME : Version Override 対象の Worker 名。省略時は octg-gateway。
#   OCTG_EXPECTED_HTTP_STATUS : 期待するHTTP status。省略時は200。500の場合はinternal_errorを検証する。
# Exit codes: 0=成功 / 1=リトライ後失敗 / 2=使い方誤り
set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  echo "usage: $0 <base-url> <model>" >&2
  exit 2
fi

base_url="${1%/}"
model="$2"

if [[ -z "${OCTG_SMOKE_API_KEY:-}" ]]; then
  echo "error: OCTG_SMOKE_API_KEY is not set" >&2
  exit 2
fi

version_override_worker_name="${OCTG_VERSION_OVERRIDE_WORKER_NAME:-octg-gateway}"
expected_http_status="${OCTG_EXPECTED_HTTP_STATUS:-200}"
if [[ "$expected_http_status" != "200" && "$expected_http_status" != "500" ]]; then
  echo "error: OCTG_EXPECTED_HTTP_STATUS must be 200 or 500" >&2
  exit 2
fi

payload=$(printf '{"model":"%s","messages":[{"role":"user","content":"Reply with OK."}]}' "${model}")
response_file=$(mktemp)
headers_file=$(mktemp)
trap 'rm -f "$response_file" "$headers_file"' EXIT

header_value() {
  local header_name="$1"
  local header_file="$2"
  awk -v wanted="$header_name" '
    {
      line = $0
      sub(/\r$/, "", line)
      split(line, fields, ":")
      if (tolower(fields[1]) == tolower(wanted)) {
        sub(/^[^:]*:[[:space:]]*/, "", line)
        print line
        exit
      }
    }
  ' "$header_file"
}

redacted_error_message() {
  printf '%s' "redacted_response"
}

safe_error_code() {
  local code=""
  code=$(jq -r '
    if (.error | type) == "object" and (.error.code | type) == "string" then
      .error.code
    else
      empty
    end
  ' "$response_file" 2>/dev/null || true)

  case "$code" in
    client_disabled|insufficient_quota|internal_error|invalid_api_key|invalid_request|model_not_allowed|model_requires_paid|origin_not_allowed|request_too_large|worker_concurrency_exceeded)
      printf '%s' "$code"
      ;;
    *)
      redacted_error_message
      ;;
  esac
}

safe_error_route() {
  local route
  route=$(header_value "X-OCTG-Route" "$headers_file")
  case "$route" in
    error:arithmetic_error|error:internal_error|error:pre_upstream|error:tokenizer_unavailable|error:upstream_uncertain|free_shared|paid_shared|reject:complimentary_quota|reject:duplicate_idempotency_key|reject:model_not_allowed|reject:request_too_large|reject:worker_concurrency)
      printf '%s' "$route"
      ;;
    *)
      printf '%s' "unknown_route"
      ;;
  esac
}

curl_args=(
  -sS
  --max-time 60
  -D "$headers_file"
  -o "$response_file"
  -w '%{http_code}'
  "${base_url}/v1/chat/completions"
  -H "Authorization: Bearer ${OCTG_SMOKE_API_KEY}"
  -H "Content-Type: application/json"
)
if [[ -n "${OCTG_VERSION_OVERRIDE:-}" ]]; then
  curl_args+=(
    -H "Cloudflare-Workers-Version-Overrides: ${version_override_worker_name}=\"${OCTG_VERSION_OVERRIDE}\""
  )
fi

for attempt in 1 2 3; do
  : > "$response_file"
  : > "$headers_file"
  status="000"
  status=$(curl "${curl_args[@]}" --data "$payload") || status="000"

  request_id=$(header_value "X-OCTG-Request-Id" "$headers_file")
  if [[ ! "$request_id" =~ ^req_[0-9A-HJKMNP-TV-Z]{26}$ ]]; then
    request_id="unknown"
  fi

  passed=false
  failure_message=$(safe_error_code)
  failure_route=$(safe_error_route)
  if [[ "$status" == "$expected_http_status" ]]; then
    if [[ "$expected_http_status" == "200" ]]; then
      if jq -e '.choices[0].message.content != null' "$response_file" > /dev/null 2>&1; then
        passed=true
      else
        failure_message="unexpected_response_body"
      fi
    elif jq -e '.error.code == "internal_error"' "$response_file" > /dev/null 2>&1; then
      passed=true
    else
      failure_message="unexpected_response_body"
    fi

    if [[ "$passed" == true && -n "${OCTG_VERSION_OVERRIDE:-}" && "$(header_value "X-OCTG-Worker-Version" "$headers_file")" != "$OCTG_VERSION_OVERRIDE" ]]; then
      passed=false
      failure_message="worker_version_mismatch"
    fi
  elif [[ "$expected_http_status" == "500" && "$status" == "200" ]]; then
    failure_message="unexpected_http_status"
  fi

  if [[ "$passed" == true ]]; then
    echo "smoke test passed (attempt ${attempt})"
    exit 0
  fi

  echo "attempt ${attempt}: http_status=${status} request_id=${request_id} message=${failure_message} route=${failure_route}" >&2
  if [[ "$attempt" -lt 3 ]]; then
    sleep 10
  fi
done

echo "smoke test failed after 3 attempts" >&2
exit 1
