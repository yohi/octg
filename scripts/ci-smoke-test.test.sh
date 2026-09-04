#!/usr/bin/env bash
set -euo pipefail

curl() {
  local headers_file=""
  local response_file=""
  local override_header=""
  local option=""
  local value=""

  while [[ "$#" -gt 0 ]]; do
    option="$1"
    value="${2:-}"
    case "$option" in
      -D)
        headers_file="$value"
        shift 2
        ;;
      -o)
        response_file="$value"
        shift 2
        ;;
      -H)
        if [[ "$value" == Cloudflare-Workers-Version-Overrides:* ]]; then
          override_header="$value"
        fi
        shift 2
        ;;
      *)
        shift
        ;;
    esac
  done

  if [[ "$override_header" != 'Cloudflare-Workers-Version-Overrides: preview-worker="version-id"' ]]; then
    printf 'unexpected Version Override header: %s\n' "$override_header" >&2
    return 97
  fi

  if [[ "${SMOKE_TEST_MODE:-success}" == "error" ]]; then
    printf 'X-OCTG-Request-Id: req_01ARZ3NDEKTSV4RRFFQ69G5FAV\r\nX-OCTG-Route: error:internal_error\r\nX-OCTG-Worker-Version: 123e4567-e89b-12d3-a456-426614174000\r\n' > "$headers_file"
    printf '{"error":{"code":"internal_error","message":"Authorization: Bearer response-secret"}}\n' > "$response_file"
    printf '500'
    return 0
  fi

  if [[ "${SMOKE_TEST_MODE:-success}" == "expected-error" ]]; then
    printf 'X-OCTG-Request-Id: req_01ARZ3NDEKTSV4RRFFQ69G5FAV\r\n' > "$headers_file"
    printf 'X-OCTG-Worker-Version: version-id\r\n' >> "$headers_file"
    printf '{"error":{"code":"internal_error"}}\n' > "$response_file"
    printf '500'
    return 0
  fi

  printf 'X-OCTG-Worker-Version: version-id\r\n' > "$headers_file"
  printf '{"choices":[{"message":{"content":"OK"}}]}\n' > "$response_file"
  printf '200'
}

sleep() {
  :
}

export -f curl sleep

OCTG_SMOKE_API_KEY=octg_sk_test \
OCTG_VERSION_OVERRIDE=version-id \
OCTG_VERSION_OVERRIDE_WORKER_NAME=preview-worker \
bash "$(dirname "$0")/ci-smoke-test.sh" "https://preview.example" "gpt-5-mini"

if output=$(SMOKE_TEST_MODE=error \
  OCTG_SMOKE_API_KEY=octg_sk_test \
  OCTG_VERSION_OVERRIDE=version-id \
  OCTG_VERSION_OVERRIDE_WORKER_NAME=preview-worker \
  bash "$(dirname "$0")/ci-smoke-test.sh" "https://preview.example" "gpt-5-mini" 2>&1); then
  printf 'expected smoke failure for error response\n' >&2
  exit 1
else
  status=$?
fi

[[ "$status" -eq 1 ]] || { printf 'unexpected smoke exit status: %s\n' "$status" >&2; exit 1; }
[[ "$output" == *"message=internal_error"* ]] || { printf 'safe error code was not surfaced\n' >&2; exit 1; }
[[ "$output" == *"route=error:internal_error"* ]] || { printf 'safe error route was not surfaced\n' >&2; exit 1; }
[[ "$output" == *"worker_version=123e4567-e89b-12d3-a456-426614174000"* ]] || { printf 'safe worker version was not surfaced\n' >&2; exit 1; }
[[ "$output" != *"response-secret"* ]] || { printf 'response-derived error leaked to logs\n' >&2; exit 1; }

SMOKE_TEST_MODE=expected-error \
  OCTG_EXPECTED_HTTP_STATUS=500 \
  OCTG_SMOKE_API_KEY=octg_sk_test \
  OCTG_VERSION_OVERRIDE=version-id \
  OCTG_VERSION_OVERRIDE_WORKER_NAME=preview-worker \
  bash "$(dirname "$0")/ci-smoke-test.sh" "https://preview.example" "gpt-5-mini"
