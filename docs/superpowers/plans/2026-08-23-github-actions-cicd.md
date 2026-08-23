# GitHub Actions CI/CD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** master マージ時の本番自動デプロイと、PR 更新時の Worker Preview URL へのデプロイ + gpt-5-mini による疎通テストを GitHub Actions で実現する。

**Architecture:** ワークフロー 2 本（`deploy-production.yml` / `preview-smoke.yml`）。Preview 検証は `wrangler versions upload`（本番トラフィック非影響、D1/DO は共有）。疎通テストは再利用可能な bash スクリプト `scripts/ci-smoke-test.sh` に分離し、workflow から呼び出す。

**Tech Stack:** GitHub Actions, Cloudflare Wrangler v4 (workspace devDependency), Node.js 20, npm workspaces, jq/curl (runner 同梱)

**Spec:** `docs/superpowers/specs/2026-08-23-github-actions-cicd-design.md`

## Global Constraints

- 環境は production のみ。staging 等の名前付き wrangler 環境は作らない
- PR Preview 方式は `wrangler versions upload`。`versions deploy` や本番影響のある操作を PR 時に実行しない
- 疎通テストは `POST /v1/chat/completions` 1 リクエスト。既定モデル `gpt-5-mini`（MINI プール・registry 登録済み）
- リトライ最大 3 回・10 秒間隔、curl `--max-time 60`
- 全 workflow の `permissions` は `contents: read` のみ
- Secret 値（`octg_sk_*`、API token）を echo・コミット・ログ出力しない。curl へは env 経由で渡す
- `apps/gateway-worker/wrangler.jsonc` の DO migrations v1/v2 を削除・改名・変更しない
- **master ブランチへ直接 commit / push しない**。全作業は Task 1 で作成する feature ブランチ上で行う
- コミットメッセージは日本語 Conventional Commits（例: `feat(ci): ...`）
- PR のマージは人間が行う（エージェントはマージしない）

## ファイル構造

```text
.github/workflows/
├── deploy-production.yml   # on: push(master) → test → d1 migrate → deploy
└── preview-smoke.yml       # on: pull_request(master) → test → versions upload → smoke
scripts/
└── ci-smoke-test.sh        # 疎通テスト本体（引数: base-url, model / env: OCTG_SMOKE_API_KEY）
docs/superpowers/specs/
└── 2026-08-23-github-actions-cicd-design.md   # 既存（Task 1 でコミット）
README.md                   # CI 運用手順セクション追記（Task 5）
```

## 前提作業（手動・オペレーター実施、Task 6 の前に必須）

1. Cloudflare API token 発行（最小権限: Account Settings Read / Workers Scripts Edit / D1 Edit）
2. GitHub リポジトリ Secrets へ登録:
   - `CLOUDFLARE_API_TOKEN`: 上記 token
   - `CLOUDFLARE_ACCOUNT_ID`: Cloudflare アカウント ID
   - `OCTG_SMOKE_API_KEY`: 手順 3 で発行したクライアントキー
3. CI 専用クライアントキーを本番 D1 へ登録:
   ```bash
   OCTG_KEY_PEPPER=<本番pepper> \
   OCTG_CLIENT_ID=client_ci_smoke \
   OCTG_CLIENT_NAME="CI Smoke" \
   npm run seed:client:remote -- --tools-mode=REJECT
   ```
   （`--key` 未指定なら `octg_sk_remote_<hex>` が自動生成され標準出力に表示される。表示された値を `OCTG_SMOKE_API_KEY` に登録する。tools-mode 既定 REJECT = 最小権限。必要なら Admin UI で利用モデルを gpt-5-mini 系のみに絞る）

---

### Task 1: feature ブランチ作成と spec コミット

**Files:**
- Create: （ブランチ操作のみ。spec ファイルは `docs/superpowers/specs/2026-08-23-github-actions-cicd-design.md` に既存・未追跡）

**Interfaces:**
- Consumes: なし
- Produces: ブランチ `feature/github-actions-cicd`（以降の全 Task の作業場所）

- [ ] **Step 1: 現在の git 状態確認**

Run: `git status --short && git branch --show-current`
Expected: `docs/superpowers/specs/2026-08-23-github-actions-cicd-design.md` が untracked (`??`) で表示される。現在ブランチは `master`

- [ ] **Step 2: feature ブランチ作成**

```bash
git checkout -b feature/github-actions-cicd
```

- [ ] **Step 3: spec ファイルをコミット**

```bash
git add docs/superpowers/specs/2026-08-23-github-actions-cicd-design.md
git commit -m "docs(specs): GitHub Actions CI/CD 設計を追加"
```

- [ ] **Step 4: コミット確認**

Run: `git log --oneline -1 && git status --short docs/`
Expected: `docs(specs): ...` のコミットが HEAD にあり、spec ファイルは clean

---

### Task 2: 疎通テストスクリプト作成

**Files:**
- Create: `scripts/ci-smoke-test.sh`

**Interfaces:**
- Consumes: なし
- Produces: `scripts/ci-smoke-test.sh <base-url> <model>` — 成功時 exit 0 / 引数不足・env 不足 exit 2 / 3 回リトライ後失敗 exit 1。環境変数 `OCTG_SMOKE_API_KEY` 必須。Task 4 の preview-smoke.yml から呼び出す

- [ ] **Step 1: スクリプトを作成**

`scripts/ci-smoke-test.sh` を以下の内容で作成する:

```bash
#!/usr/bin/env bash
# CI 用疎通テストスクリプト。
# Usage: scripts/ci-smoke-test.sh <base-url> <model>
#   base-url : 対象 Worker のベース URL (例: https://xxxxx-octg-gateway.example.workers.dev)
#   model    : 疎通テストに使うモデル名 (例: gpt-5-mini)
# Env:
#   OCTG_SMOKE_API_KEY : クライアントキー (octg_sk_*)。必須。ログへ出力しないこと。
# Exit codes: 0=成功 / 1=リトライ後失敗 / 2=使い方誤り
set -euo pipefail

if [ $# -ne 2 ]; then
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

for attempt in 1 2 3; do
  status="000"
  status=$(curl -sS --max-time 60 -o "$response_file" -w '%{http_code}' \
    "${base_url}/v1/chat/completions" \
    -H "Authorization: Bearer ${OCTG_SMOKE_API_KEY}" \
    -H "Content-Type: application/json" \
    --data "$payload") || status="000"

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
```

- [ ] **Step 2: 実行権限付与**

```bash
chmod +x scripts/ci-smoke-test.sh
```

- [ ] **Step 3: 構文検証**

Run: `bash -n scripts/ci-smoke-test.sh && shellcheck scripts/ci-smoke-test.sh || true`
Expected: `bash -n` は無出力で成功。shellcheck は未インストールでも `|| true` で継続。指摘が出た場合は修正してから次へ

- [ ] **Step 4: 異常系テスト（引数不足 → exit 2）**

Run: `bash scripts/ci-smoke-test.sh; echo "exit=$?"`
Expected: usage メッセージ表示、`exit=2`

- [ ] **Step 5: 異常系テスト（env 不足 → exit 2）**

Run: `unset OCTG_SMOKE_API_KEY; bash scripts/ci-smoke-test.sh https://example.invalid gpt-5-mini; echo "exit=$?"`
Expected: `error: OCTG_SMOKE_API_KEY is not set` 表示、`exit=2`

- [ ] **Step 6: 正常系モックテスト（ローカル HTTP サーバ）**

ローカルに JSON モックサーバを起動し、成功経路 (HTTP 200 + choices[0].message.content 存在) を検証する:

```bash
node -e 'require("http").createServer((q,s)=>{s.setHeader("content-type","application/json");s.end(JSON.stringify({choices:[{message:{content:"OK"}}]}))}).listen(18999)' &
mock_pid=$!
sleep 1
OCTG_SMOKE_API_KEY=octg_sk_dummy bash scripts/ci-smoke-test.sh http://127.0.0.1:18999 gpt-5-mini; rc=$?
kill $mock_pid
echo "exit=$rc"
test "$rc" -eq 0
```

Expected: `smoke test passed (attempt 1)`、`exit=0`

- [ ] **Step 7: Commit**

```bash
git add scripts/ci-smoke-test.sh
git commit -m "feat(ci): Preview URL 向け疎通テストスクリプトを追加"
```

---

### Task 3: deploy-production.yml 作成

**Files:**
- Create: `.github/workflows/deploy-production.yml`

**Interfaces:**
- Consumes: Global Constraints の Secret 名（`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`）
- Produces: なし（独立ワークフロー）

- [ ] **Step 1: ワークフローを作成**

`.github/workflows/deploy-production.yml` を以下の内容で作成する:

```yaml
name: Deploy Production

on:
  push:
    branches: [master]

permissions:
  contents: read

concurrency:
  group: production-deploy
  cancel-in-progress: false

jobs:
  test-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Typecheck
        run: npm run typecheck

      - name: Unit tests
        run: npm test

      - name: Apply D1 migrations
        run: npx wrangler d1 migrations apply octg --remote --config apps/gateway-worker/wrangler.jsonc
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}

      - name: Deploy Worker
        run: npx wrangler deploy --config apps/gateway-worker/wrangler.jsonc
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

補足: GitHub Actions では `CI=true` が自動設定され、`wrangler d1 migrations apply` は対話確認なしで適用される（冪等・適用済み tag はスキップ）。

- [ ] **Step 2: YAML 構文検証**

Run: `actionlint .github/workflows/deploy-production.yml 2>/dev/null || python3 -c "import yaml,sys; yaml.safe_load(open(sys.argv[1])); print('YAML OK')" .github/workflows/deploy-production.yml`
Expected: actionlint 警告ゼロ、または `YAML OK` 表示

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy-production.yml
git commit -m "feat(ci): master マージ時の本番自動デプロイワークフローを追加"
```

---

### Task 4: preview-smoke.yml 作成

**Files:**
- Create: `.github/workflows/preview-smoke.yml`

**Interfaces:**
- Consumes: `scripts/ci-smoke-test.sh`（Task 2、引数 `<base-url> <model>` / env `OCTG_SMOKE_API_KEY`）、Secrets（`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `OCTG_SMOKE_API_KEY`）、任意 repo variable `SMOKE_MODEL`（未設定時 `gpt-5-mini`）
- Produces: job `upload-preview` の output `preview_url`（job `smoke-test` が消費）

- [ ] **Step 1: ワークフローを作成**

`.github/workflows/preview-smoke.yml` を以下の内容で作成する:

```yaml
name: Preview Smoke Test

on:
  pull_request:
    branches: [master]
    types: [opened, synchronize, reopened]

permissions:
  contents: read

concurrency:
  group: preview-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Typecheck
        run: npm run typecheck

      - name: Unit tests
        run: npm test

  upload-preview:
    needs: test
    runs-on: ubuntu-latest
    outputs:
      preview_url: ${{ steps.upload.outputs.preview_url }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Upload worker version (preview, no live traffic impact)
        id: upload
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: |
          output=$(npx wrangler versions upload --config apps/gateway-worker/wrangler.jsonc \
            --tag "pr-${{ github.event.pull_request.number }}" \
            --message "pr-${{ github.event.pull_request.number }} ${{ github.event.pull_request.head.sha }}" 2>&1) || {
            echo "$output"
            echo "::error::wrangler versions upload failed"
            exit 1
          }
          echo "$output"
          url=$(printf '%s' "$output" | grep -Eo 'https://[a-z0-9-]+-octg-gateway\.[a-z0-9.-]+\.workers\.dev' | tail -1)
          if [ -z "$url" ]; then
            echo "::error::Preview URL not found in wrangler output"
            exit 1
          fi
          echo "preview_url=${url}" >> "$GITHUB_OUTPUT"

  smoke-test:
    needs: upload-preview
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Run smoke test against preview URL
        env:
          OCTG_SMOKE_API_KEY: ${{ secrets.OCTG_SMOKE_API_KEY }}
          SMOKE_BASE_URL: ${{ needs.upload-preview.outputs.preview_url }}
          SMOKE_MODEL: ${{ vars.SMOKE_MODEL || 'gpt-5-mini' }}
        run: bash scripts/ci-smoke-test.sh "$SMOKE_BASE_URL" "$SMOKE_MODEL"
```

補足:
- `versions upload` はバージョンのアップロードのみでライブトラフィックには影響しない。アップロード済みバージョンは本番の Secret を引き継ぐ
- Preview URL 抽出は worker 名 `octg-gateway` を含む workers.dev ホスト名の正規表現。抽出不能時は `::error::` で明示失敗
- 疎通テスト消費は MINI プールの 1 リクエスト数十トークン程度

- [ ] **Step 2: YAML 構文検証**

Run: `actionlint .github/workflows/preview-smoke.yml 2>/dev/null || python3 -c "import yaml,sys; yaml.safe_load(open(sys.argv[1])); print('YAML OK')" .github/workflows/preview-smoke.yml`
Expected: actionlint 警告ゼロ、または `YAML OK` 表示

- [ ] **Step 3: Preview URL 抽出正規表現の単体検証**

Run:

```bash
sample='✨ Success! Uploaded version abc123
🚀 Preview URL: https://abc123-octg-gateway.yohi.workers.dev'
url=$(printf '%s' "$sample" | grep -Eo 'https://[a-z0-9-]+-octg-gateway\.[a-z0-9.-]+\.workers\.dev' | tail -1)
test "$url" = "https://abc123-octg-gateway.yohi.workers.dev" && echo "regex OK"
```

Expected: `regex OK`

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/preview-smoke.yml
git commit -m "feat(ci): PR 時の Preview デプロイと疎通テストワークフローを追加"
```

---

### Task 5: README への運用手順追記

**Files:**
- Modify: `README.md`（「開発」セクション直後に新セクション「CI/CD（GitHub Actions）」を挿入）

**Interfaces:**
- Consumes: 前提作業の手順（Secret 名・seed コマンド）
- Produces: なし

- [ ] **Step 1: README にセクションを追記**

`README.md` の `## 開発` セクションの見出し直前（または直後の自然な位置）に以下を挿入する:

```markdown
## CI/CD（GitHub Actions）

| ワークフロー | トリガー | 内容 |
| --- | --- | --- |
| `deploy-production.yml` | `push` to `master` | typecheck / test → D1 migration（remote、冪等）→ `wrangler deploy` |
| `preview-smoke.yml` | `pull_request` → `master` | typecheck / test → `wrangler versions upload`（Preview URL、本番トラフィック非影響）→ Preview URL に対し `POST /v1/chat/completions` 1 発の疎通テスト（既定モデル `gpt-5-mini`） |

### 事前に必要な設定（一度だけ）

1. Cloudflare API token を発行し、権限を最小化する（Account Settings Read / Workers Scripts Edit / D1 Edit）。
2. CI 専用クライアントキーを本番 D1 に登録する:

   ```bash
   OCTG_KEY_PEPPER=<本番pepper> \
   OCTG_CLIENT_ID=client_ci_smoke \
   OCTG_CLIENT_NAME="CI Smoke" \
   npm run seed:client:remote -- --tools-mode=REJECT
   ```

3. GitHub リポジトリの Settings > Secrets and variables > Actions に以下を登録する:
   - `CLOUDFLARE_API_TOKEN` — 手順 1 の token
   - `CLOUDFLARE_ACCOUNT_ID` — Cloudflare アカウント ID
   - `OCTG_SMOKE_API_KEY` — 手順 2 のクライアントキー
4. （任意）Variables に `SMOKE_MODEL` を設定すると疎通テスト用モデルを差し替えられる（未設定時は `gpt-5-mini`）。

### 運用メモ

- Preview 検証は D1 / Durable Object を本番と共有するため、疎通テストは本番 MINI プールを微小消費する。
- 本番デプロイ失敗時の rollback は Cloudflare deployment version rollback を手動実施する（[Tokenizer の監視・運用](#tokenizer-の監視運用) 参照）。
- Secret 値は workflow ログへ出力されない。`octg_sk_*` をドキュメントやコードへ記載しないこと。
```

- [ ] **Step 2: Markdown lint**

Run: `npx markdownlint-cli2 "README.md" 2>/dev/null || echo "(markdownlint 未導入のためスキップ)"`
Expected: エラーゼロ、またはスキップ表示。エラーが出た場合は指摘箇所を修正

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): CI/CD ワークフローの運用手順を追加"
```

---

### Task 6: push・PR 作成・実環境検証（前提作業完了後に実施）

**Files:**
- Create: なし（PR 操作と実環境検証）

**Interfaces:**
- Consumes: 前提作業で登録済みの 3 つの GitHub Secrets
- Produces: PR（マージは人間が実施）

- [ ] **Step 1: ブランチを push**

```bash
git push -u origin feature/github-actions-cicd
```

- [ ] **Step 2: PR 作成**

```bash
gh pr create \
  --base master \
  --title "ci: GitHub Actions による本番デプロイと PR Preview 疎通テスト" \
  --body "$(cat <<'EOF'
## Summary
- master マージ時に production へ自動デプロイ（typecheck/test → D1 migration → deploy）
- PR 更新時に Worker Preview URL へ versions upload し、gpt-5-mini で疎通テスト
- 疎通テストスクリプト scripts/ci-smoke-test.sh を追加
- README に運用手順を追記

## Spec
- docs/superpowers/specs/2026-08-23-github-actions-cicd-design.md

## Test plan
- [ ] preview-smoke ワークフローが緑になる（初回実環境検証）
- [ ] 疎通テストの Preview URL で curl 手動確認（任意）
EOF
)"
```

- [ ] **Step 3: preview-smoke ワークフローの実行確認**

Run: `gh pr checks --watch`（または Actions ページを確認）
Expected: `test` / `upload-preview` / `smoke-test` の全ジョブが success。失敗した場合はログを確認して原因を修正し、push し直す（synchronize イベントで再実行される）

- [ ] **Step 4: レビュー依頼**

PR URL をユーザーへ報告する。**マージはユーザーが行う**（マージ後、`deploy-production.yml` が発火し本番デプロイが完了する）

---

## Self-Review 結果

1. **Spec coverage:** 環境構成 production のみ ✓ / versions upload ✓ / chat completions 1 発 ✓ / gpt-5-mini 変数化（`vars.SMOKE_MODEL` フォールバック） ✓ / GitHub Secrets ✓ / 両ワークフローで typecheck+test ✓ / concurrency 設定 ✓ / permissions contents:read ✓ / エラー処理（URL 抽出失敗・リトライ） ✓ / README 運用手順 ✓ / rollback は手動（対象外） ✓
2. **Placeholder scan:** TBD/TODO なし。全コードステップに実コード記載 ✓
3. **Type consistency:** スクリプト呼び出し署名 `scripts/ci-smoke-test.sh <base-url> <model>` を Task 2（定義）と Task 4（使用）で一致 ✓ / output 名 `preview_url` を定義・参照で一致 ✓
