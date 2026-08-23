#!/usr/bin/env bash
set -euo pipefail

curl() {
  local headers_file=""
  local response_file=""
  local override_header=""

  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      -D)
        headers_file="$2"
        shift 2
        ;;
      -o)
        response_file="$2"
        shift 2
        ;;
      -H)
        if [[ "$2" == Cloudflare-Workers-Version-Overrides:* ]]; then
          override_header="$2"
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
