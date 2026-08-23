#!/usr/bin/env bash
# CI 用疎通テストスクリプト。
# Usage: scripts/ci-smoke-test.sh <base-url> <model>
#   base-url : 対象 Worker のベース URL (例: https://xxxxx-octg-gateway.example.workers.dev)
#   model    : 疎通テストに使うモデル名 (例: gpt-5-mini)
# Env:
#   OCTG_SMOKE_API_KEY : クライアントキー (octg_sk_*)。必須。ログへ出力しないこと。
#   OCTG_VERSION_OVERRIDE : Version Override 対象の Worker Version ID。指定時だけ header を付ける。
# Exit codes: 0=成功 / 1=リトライ後失敗 / 2=使い方誤り
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <base-url> <model>" >&2
  exit 2
fi

base_url="${1%/}"
model="$2"

if [ -z "${OCTG_SMOKE_API_KEY:-}" ]; then
  echo "error: OCTG_SMOKE_API_KEY is not set" >&2
  exit 2
fi

payload=$(printf '{"model":"%s","messages":[{"role":"user","content":"Reply with OK."}]}' "${model}")
response_file=$(mktemp)
trap 'rm -f "$response_file"' EXIT

curl_args=(
  -sS
  --max-time 60
  -o "$response_file"
  -w '%{http_code}'
  "${base_url}/v1/chat/completions"
  -H "Authorization: Bearer ${OCTG_SMOKE_API_KEY}"
  -H "Content-Type: application/json"
)
if [ -n "${OCTG_VERSION_OVERRIDE:-}" ]; then
  curl_args+=(
    -H "Cloudflare-Workers-Version-Overrides: octg-gateway=\"${OCTG_VERSION_OVERRIDE}\""
  )
fi

for attempt in 1 2 3; do
  : > "$response_file"
  status="000"
  status=$(curl "${curl_args[@]}" --data "$payload") || status="000"

  if [ "$status" = "200" ] && jq -e '.choices[0].message.content != null' "$response_file" > /dev/null 2>&1; then
    echo "smoke test passed (attempt ${attempt})"
    exit 0
  fi

  echo "attempt ${attempt}: http_status=${status}" >&2
  if [ -s "$response_file" ]; then
    cat "$response_file" >&2
    echo "" >&2
  fi
  if [ "$attempt" -lt 3 ]; then
    sleep 10
  fi
done

echo "smoke test failed after 3 attempts (model=${model})" >&2
exit 1
