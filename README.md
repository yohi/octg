# OCTG — OpenAI Complimentary Token Gateway

OpenAI Data Sharing Program (Tier 3) の無料枠を複数クライアントで共有するための OpenAI 互換 API Gateway。Cloudflare Workers + Durable Objects + D1 で構成される。

詳細設計は [SPEC.md](./SPEC.md) を参照。

[![Use this template](https://img.shields.io/badge/Use%20this%20template-yohi/octg-blue)](https://github.com/yohi/octg/generate)

## アーキテクチャ概要

```text
Client (OpenCode / AI Agent / MCP / Apps)
        │  Authorization: Bearer octg_sk_*
        ▼
Cloudflare Worker (OpenAI 互換 API)
        │  認証 → ポリシー解決 → モデル分類 → Tool-use 判定
        │  → QuotaController state 読み出し
        ▼
Durable Object: TokenizerController (exact o200k_base BPE)
        │  固定 ID tokenizer:primary への 1 回の RPC
        ▼
Cloudflare Worker
        │  token budget 算術 → reservation 要求
        ▼
Durable Object: QuotaController (pool × UTC 日)
        │  reserve / settle / markUncertain（単一スレッドで直列化）
        ▼ (permit 後のみ)
Cloudflare AI Gateway (REST)
        │  BYOK + Secrets Store / metadata / cache (opt-in) / Spend Limit (二次防御)
        ▼
OpenAI API (Project A: shared-free, Data Sharing ON)

Worker ──非同期──► D1（監査・履歴・レジストリ・ポリシー・reconciliation）
Cron Trigger ──► Reconciliation（OpenAI Usage API との突合）
```

### 設計原則

1. AI Gateway Spend Limit を無料枠カウンターとして信用しない
2. Durable Object で request 前 reservation を行う
3. actual usage で reservation を精算する
4. 不確実な request は消費済みとして扱う（fail-closed）
5. Paid fallback は明示的 opt-in がない限り発生させない
6. exact BPE は TokenizerController に隔離し、Gateway と shared package に encoder を依存させない
7. TokenizerController は RPC 専用で、入力本文や tokenizer state を Durable Object storage に保存しない
8. `Idempotency-Key` は client × pool × UTC 日単位で重複排除し、空文字を absent、指定値を UTF-8 255 bytes 以下として扱う。Worker の upstream 自動 retry は無効化する

## はじめに：あなたの立場に応じた手順

このリポジトリに関わる人は次の 3 つの立場があります。自分に該当する手順だけを読んでください。

| 立場 | やること | 参照先 |
|------|---------|--------|
| **利用するだけ** | デプロイ済みの Gateway を OpenAI 互換クライアントから呼ぶ | [クイックスタート（利用するだけ）](#クイックスタート利用するだけ) |
| **開発する** | ローカルで Worker を起動し、コードを変更・テストする | [セットアップ（開発する場合）](#セットアップ開発する場合) |
| **デプロイする** | 自分専用のインスタンスを Cloudflare に建てる | [テンプレートから新規作成（デプロイする場合）](#テンプレートから新規作成デプロイする場合) |

---

## クイックスタート（利用するだけ）

開発・デプロイは行わず、既に動いている Gateway を利用するだけの場合の手順です。

### 必要なもの

管理者から以下を受け取ってください。

- **Gateway の URL**（例: `https://octg-gateway.<subdomain>.workers.dev`）
- **クライアント API キー**（`octg_sk_*` で始まる文字列）

### 使い方

OCTG は OpenAI 互換 API を提供するため、**接続先 URL（base URL）と API キーを差し替えるだけで利用できます**（SPEC.md AC-01）。利用可能な無料枠モデルは `gpt-5`、`gpt-5-mini`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna` です。

#### curl での動作確認

```bash
curl https://octg-gateway.<subdomain>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer octg_sk_xxx" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-5.6-luna", "messages": [{"role": "user", "content": "Hello"}]}'
```

#### 利用可能なモデル

| モデル | 無料枠プール | 用途の目安 |
|---|---|---|
| `gpt-5.6-sol` | STANDARD | 高度な推論・複雑な処理 |
| `gpt-5.6-terra` | MINI | 性能とコストのバランス |
| `gpt-5.6-luna` | MINI | 高ボリューム・低コスト |
| `gpt-5` | STANDARD | 既存の推論・コーディング |
| `gpt-5-mini` | MINI | 軽量な処理 |

モデルの利用可否は Gateway の `/v1/models` でも確認できます。

OpenAI 互換の base URL を指定できるクライアント（OpenCode、OpenAI SDK 互換ツールなど）では、以下のように設定します。

```text
base URL: https://octg-gateway.<subdomain>.workers.dev/v1
API Key:  octg_sk_xxx
```

> 注意: 共有無料枠の範囲内で処理されるため、利用状況（/quota）は管理者に問い合わせてください。超過時は 429 または REJECT ポリシーに応じた応答が返ります。

### Cloudflare AI Gateway 経由で利用する

管理者が OCTG を Cloudflare AI Gateway の **Custom Provider** として登録している場合、クライアントは Gateway A のエンドポイントを向けます。

```text
base URL: https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_a_id}/custom-octg/v1
API Key:  <発行された octg_sk_xxx>
追加ヘッダー:
  cf-aig-authorization: Bearer <Gateway A Run token>
  cf-aig-collect-log-payload: false
  cf-aig-skip-cache: true
```

詳細なセットアップ手順とトラブルシューティングは [docs/cloudflare-ai-gateway-custom-provider.md](./docs/cloudflare-ai-gateway-custom-provider.md) を参照してください。

#### OpenCode の `opencode.json` / `opencode.jsonc` への追記

OpenCode からこの Custom Provider を使う場合は、Gateway A の Run token を
`OCTG_CF_API_TOKEN` として環境変数へ設定し、既存の `provider` オブジェクトへ次を追加します。
`opencode.jsonc` ではそのまま使用でき、`opencode.json` ではコメントを除去してください。
以下の model metadata は上流モデルの token limit と reasoning / tool calling 対応を反映しています。
OCTG 経由では非テキスト入力を拒否し、tool calling はクライアントポリシーの `tools_mode=ALLOW` が必要です。

```jsonc
"cloudflare-ai-gateway-octg": {
  "npm": "@ai-sdk/openai",
  "options": {
    "apiKey": "cloudflare-custom-provider",
    "baseURL": "https://gateway.ai.cloudflare.com/v1/{env:OCTG_CF_ACCOUNT_ID}/{env:OCTG_CF_GATEWAY_ID}/custom-octg/v1",
    "headers": {
      "Authorization": "",
      "cf-aig-authorization": "Bearer {env:OCTG_CF_API_TOKEN}",
      "cf-aig-collect-log-payload": "false",
      "cf-aig-max-attempts": "1",
      "cf-aig-skip-cache": "true"
    }
  },
  "models": {
    "gpt-5.6-luna": {
      "name": "GPT-5.6 Luna (OCTG)",
      "reasoning": true,
      "tool_call": true,
      "modalities": { "input": ["text"], "output": ["text"] },
      "limit": { "context": 1050000, "input": 922000, "output": 128000 }
    },
    "gpt-5.6-terra": {
      "name": "GPT-5.6 Terra (OCTG)",
      "reasoning": true,
      "tool_call": true,
      "modalities": { "input": ["text"], "output": ["text"] },
      "limit": { "context": 1050000, "input": 922000, "output": 128000 }
    },
    "gpt-5.6-sol": {
      "name": "GPT-5.6 Sol (OCTG)",
      "reasoning": true,
      "tool_call": true,
      "modalities": { "input": ["text"], "output": ["text"] },
      "limit": { "context": 1050000, "input": 922000, "output": 128000 }
    }
  }
}
```

環境変数の例:

```bash
export OCTG_CF_ACCOUNT_ID="<Cloudflare account ID>"
export OCTG_CF_GATEWAY_ID="<Gateway A ID>"
export OCTG_CF_API_TOKEN="<Gateway A Run token>"
```

Provider Key は Gateway A の Custom Provider 側に登録済みの `octg_sk_*` を使用します。
そのため、OpenCode の設定ファイルへ `octg_sk_*` や Run token の実値を記載しないでください。
モデルを選択するときは、例えば `cloudflare-ai-gateway-octg/gpt-5.6-luna` を指定します。

---

## セットアップ（開発する場合）

コードを変更・テストするためにローカル環境を構築する手順です。

### 最短手順

Node.js 20 以上を用意した後、次の 2 コマンドでローカル環境を準備できます。`.dev.vars` が既にある場合は、既存の Secret を保護するためスクリプトが停止します。

```bash
npm install
npm run setup:local
```

セットアップ完了後、Worker を起動します。

```bash
npm run dev -w apps/gateway-worker
```

クライアントキーを自分で指定する場合は、環境変数を付けて実行します。

```bash
OCTG_CLIENT_ID=client_demo \
OCTG_CLIENT_NAME=Demo \
OCTG_CLIENT_KEY=octg_sk_local_demo \
OCTG_CLIENT_TOOLS_MODE=ALLOW \
npm run setup:local
```

`setup:local` は `.dev.vars` の作成、ローカル D1 migration、開発用クライアントの登録を行います。既存の `.dev.vars` を意図的に作り直す場合だけ `npm run setup:local -- --force` を使用してください。

本リポジトリは npm workspaces で構成されています。Cloudflare Workers 向けのため、`wrangler` が各 workspace の devDependency として同梱されています（別途グローバルインストール不要）。

### 前提条件

- **Node.js** `>= 20`（`engines` 参照）
- **npm** `>= 10`（Node.js 20 同梱版で動作確認）
- **Cloudflare アカウント**（デプロイ・D1・Durable Objects・AI Gateway を利用する場合）
- ローカル開発のみであれば Cloudflare アカウントは不要（`wrangler dev` のローカルモードで動作）

### 1. リポジトリの取得

```bash
git clone <repo-url> octg
cd octg
```

### 2. 依存関係のインストール

ルートで一度実行すると、全 workspace（`apps/*`, `durable-objects/*`, `packages/*`）の依存関係が揃います。`wrangler`・`vitest`・`typescript` などもここでインストールされます。

```bash
npm install
```

> **Tip:** `engines` で Node.js 20+ を要求しています。`.nvmrc` 等の管理を推奨します。`node -v` でバージョンを確認してください。

### 3. ローカル環境変数の準備（任意・ローカル開発時）

`apps/gateway-worker/.dev.vars` に Secrets のローカル値を置きます。本番の `wrangler secret` とは別物で、`wrangler dev` 時のみ参照されます。

```bash
cd apps/gateway-worker
cat > .dev.vars <<'EOF'
OCTG_KEY_PEPPER=dev-pepper
OCTG_UPSTREAM_BASE_URL=https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>
OCTG_UPSTREAM_API_TOKEN=dev-token
OPENAI_USAGE_API_KEY=dev-usage-key
EOF
```

`.dev.vars` は `.gitignore` 対象です（ Secrets の値を commit しないこと）。

### 4. ローカル D1 のマイグレーション

`wrangler dev` は初回起動時にローカル D1 を自動作成しますが、スキーマを明示的に当てる場合は以下を実行します。

```bash
npx wrangler d1 migrations apply octg --local --config apps/gateway-worker/wrangler.jsonc
```

### 5. ローカル用クライアント鍵の発行

クライアントキーは keyed hash で D1 に保存します。`scripts/seed-client.mjs` が `INSERT` 文を生成するので、ローカル D1 に流してください。

```bash
OCTG_KEY_PEPPER=dev-pepper node scripts/seed-client.mjs client_demo Demo octg_sk_xxx > /tmp/octg-seed.sql
npx wrangler d1 execute octg --local --file /tmp/octg-seed.sql --config apps/gateway-worker/wrangler.jsonc
```

### 6. 動作確認

```bash
npm run typecheck   # 全 workspace の型検査
npm test            # 全 workspace のユニットテスト (Vitest + @cloudflare/vitest-pool-workers)
npm run dev -w apps/gateway-worker   # ローカルで Worker 起動 (http://localhost:8787)
```

TokenizerController は Gateway Worker の `TOKENIZER_CONTROLLER` binding から
`tokenizer:primary` という固定 ID で呼び出されます。入力文字列は TokenizerController 内で
`o200k_base` により exact BPE token 数へ変換され、成功するまで QuotaController の
reservation は実行されません。Tokenizer の outcome は次の契約です。

- `work_limit`（BPE work limit 超過）は HTTP 413、`request_too_large`、
  `X-OCTG-Route: reject:request_too_large` で拒否します。
- RPC failure、malformed result、Worker の RPC preflight ceiling 超過、または
  Tokenizer RPC 境界で `MAX_INPUT_TEXT_BYTES` を超過した場合は unavailable として、
  HTTP 500、`api_error` / `internal_error`、`X-OCTG-Route: error:internal_error` にします。
- Worker の HTTP 正規化で入力上限を超過した場合は RPC より前に HTTP 413、
  `request_too_large`、`reject:request_too_large` で拒否します。
- token budget の算術異常は HTTP 500、`api_error` / `internal_error`、公開 HTTP route は
  `error:internal_error` とし、resource stage event の route は `error:arithmetic_error` とします。

いずれも `QuotaController.reserve`、in-flight admission、upstream call は実行しません。
TokenizerController は RPC 処理だけを行い、入力本文・API key・tokenizer state をログや
Durable Object storage に保存しません。

ここまででローカル開発環境の準備は完了です。実運用する場合は [テンプレートから新規作成（デプロイする場合）](#テンプレートから新規作成デプロイする場合) を参照してください。

---

## テンプレートから新規作成（デプロイする場合）

`git clone` せずに、自分専用の Gateway インスタンスを Cloudflare にデプロイする手順です。

本リポジトリは [Template repository](https://docs.github.com/ja/repositories/creating-and-managing-repositories/creating-a-template-repository) として公開しています。

1. 上部の **Use this template** バッジ（または [Generate from template](https://github.com/yohi/octg/generate)）をクリックします。
2. 新しいリポジトリ名・所有者・可視性を入力し、**Create repository from template** をクリックします。
3. 生成されたリポジトリをローカルに展開（`git clone <your-new-repo>` または GitHub Codespaces）します。
4. `npm install` を実行します。
5. D1 の作成後、次のコマンドで本番設定を対話的に行います。D1 の作成方法や AI Gateway / Access の準備は [docs/DEPLOY_FROM_TEMPLATE.md](./docs/DEPLOY_FROM_TEMPLATE.md) を参照してください。

   ```bash
   npm install
   npm run setup:deploy
   ```

   スクリプトは `database_id`、AI Gateway URL、Access の `Team domain` と `Audience tag` を入力として受け取り、`wrangler.jsonc` の更新、3 つの Secret の登録、remote D1 migration、Worker deploy を順番に実行します。Worker deploy は `TokenizerController` の binding と Durable Object migration `v2` も含めて適用します。

> Template repository の留意点: フォークと異なり upstream との同期は自動で行われません。本リポジトリ側で修正が入った場合は、必要に応じて手動で取り込みます。

---

## 開発

セットアップ済みの環境での日次開発コマンド:

```bash
npm test            # 全ワークスペース (Vitest + @cloudflare/vitest-pool-workers)
npm run typecheck
npm run dev -w apps/gateway-worker   # ローカルで Worker 起動
```

初回の環境構築手順は [セットアップ（開発する場合）](#セットアップ開発する場合) を参照してください。

### Durable Object migration の不変条件

`apps/gateway-worker/wrangler.jsonc` の migration は次の順序を維持します。

```jsonc
"migrations": [
  { "tag": "v1", "new_sqlite_classes": ["QuotaController"] },
  { "tag": "v2", "new_sqlite_classes": ["TokenizerController"] }
]
```

- 既に適用した tag を削除・改名・内容変更しないでください。
- TokenizerController は SQLite class として登録されますが、現在の実装は
  `ctx.storage` を使用せず、入力本文・tokenizer state を永続化しません。
- 変更は必ず新しい migration tag の追加として行い、`apps/gateway-worker/wrangler.jsonc`
  を使って Gateway Worker と一緒に deploy します。

## デプロイ前の必須プロビジョニング（手動）

1. `wrangler d1 create octg` → 発行された `database_id` を `apps/gateway-worker/wrangler.jsonc` に設定する。
2. AI Gateway を作成し、OpenAI Project A（shared-free, Data Sharing ON）の API キーを **BYOK + Secrets Store** に登録する。OCTG のコード・クライアントには OpenAI キーを配布しない。
3. AI Gateway の Spend Limit を無料枠と同額に設定する（二次防御。authoritative ではない）。
4. `wrangler.jsonc` の vars を実値に差し替える: `OCTG_UPSTREAM_BASE_URL`（アカウント ID 込み）、`ACCESS_TEAM_DOMAIN` / `ACCESS_AUD`（Admin API 用 Cloudflare Access アプリケーション）。
5. Secrets を設定する:
   - `npx wrangler secret put OCTG_KEY_PEPPER --config apps/gateway-worker/wrangler.jsonc` — クライアントキーの keyed hash 用 pepper
   - `npx wrangler secret put OCTG_UPSTREAM_API_TOKEN --config apps/gateway-worker/wrangler.jsonc` — AI Gateway REST 用 Cloudflare API token（AI Gateway Run 権限）
   - `npx wrangler secret put OPENAI_USAGE_API_KEY --config apps/gateway-worker/wrangler.jsonc` — OpenAI Organization Usage API 読み取り用 admin key
6. `npx wrangler d1 migrations apply octg --remote --config apps/gateway-worker/wrangler.jsonc` で remote D1 migration を適用する。
7. `npx wrangler deploy --config apps/gateway-worker/wrangler.jsonc`（CI からのデプロイを推奨）。

### デプロイ前の Tokenizer / quota 確認

本番 credential や入力本文をログへ出さず、次の順で確認します。

```bash
npm run typecheck
npm test
npm test -w apps/gateway-worker
npm test -w durable-objects/tokenizer-controller
```

少なくとも、次の条件を満たすことを確認してください。

- `TokenizerController` の exact BPE success 後にだけ `quota_reserve` が発生する。
- `work_limit` は HTTP 413 / `request_too_large` / `reject:request_too_large` となり、
  reservation、in-flight admission、upstream call が発生しない。
- RPC failure、malformed result、RPC preflight ceiling 超過は HTTP 500 /
  `api_error` / `internal_error` / `error:internal_error` となり、reservation、in-flight
  admission、upstream call が発生しない。
- `MAX_INPUT_TEXT_BYTES = 16 * 1024 * 1024 - 65_536` の `inputText` UTF-8 byte 境界を確認する。
  - `MAX_INPUT_TEXT_BYTES - 1` bytes: 受け入れる。
  - `MAX_INPUT_TEXT_BYTES` bytes: 受け入れる。
  - `MAX_INPUT_TEXT_BYTES + 1` bytes: Tokenizer RPC では HTTP 500 / `error:internal_error` で拒否し、
    reservation、in-flight admission、upstream call を実行しない。Worker の HTTP 正規化経路では
    RPC より前に HTTP 413 / `reject:request_too_large` で拒否する。
- token budget の算術異常は HTTP 500 / `api_error` / `internal_error` となり、公開 route は
  `error:internal_error`、resource stage route は `error:arithmetic_error` になる。
- 74,000 token 級 fixture で tokenization 結果が安定し、success response の実 usage で settle される。
- `apps/gateway-worker/wrangler.jsonc` の `TOKENIZER_CONTROLLER` binding と migration `v2` が残っている。

## Secret ローテーション

各 Secret は (1) 新規トークン発行 → (2) `wrangler secret put` で設定 → (3) デプロイ / 動作確認 → (4) 旧トークン失効、の順で実施する。Worker コード・ログ・`octg_sk_*` の鍵素材に Secret の値を含めない。

`OCTG_KEY_PEPPER` の変更は通常の Secret ローテーションと分離して扱う。旧 pepper との併用期間を設けて段階的に全キーを再発行するか、全クライアントの `key_hash` を新 pepper で移行してから旧 pepper を無効化する。単純な即時変更は既存キーを無効化するため避ける。

## エンドポイント一覧（MVP）

```text
POST /v1/responses          # OpenAI 互換（予約・精算つき）
POST /v1/chat/completions   # OpenAI 互換（同上）
GET  /v1/models             # 互換 endpoint（registry から生成し client policy で絞る）
GET  /quota                 # pool 状態の可視化（クライアントキー認証必須）
GET  /admin/quota           # 以下 Admin API（Cloudflare Access 必須）
GET  /admin/usage
GET  /admin/clients
GET  /admin/models
PUT  /admin/clients/:id/policy
PUT  /admin/models/:model
POST /admin/reconcile
```

`/v1/embeddings`・`/v1/audio/*`・`/v1/images/*` は将来対応。

## 既知の限界

課金 0 円の完全保証はしない。conservative reservation + fail-closed + OpenAI reconciliation の三重防御（詳細は SPEC.md §15 参照）。監査ログは best-effort で配送欠損を許容する（authoritative な制御は DO が担う）。

## Tokenizer の監視・運用

- Tokenizer の custom stage event は request ID、revision、stage、duration、safe な byte/token 数、
  allowlist 済み outcome だけを記録します。入力本文、Authorization、API key、encoder 例外文字列は記録しません。
- Tokenizer RPC が利用できない場合は `500 internal_error` として fail-closed になります。
  この場合に local BPE、未検証の byte 比率式、paid fallback を有効化しないでください。
- 74,000 token 級 payload の canary は、同じ revision の Workers invocation outcome、CPU/wall time、
  Tokenizer stage、quota reserve、upstream 到達を request ID で相関して確認します。

### ロールバック

- Durable Object migration は不可逆として扱い、適用済みの `v1` / `v2` を削除・改名・再利用しません。
- アプリケーションを戻す場合は Cloudflare の deployment version rollback を使い、`v2` binding を含む
  manifest を維持します。rollback のために Gateway や shared package へ local BPE を戻さないでください。
- rollback 後は `/v1/chat/completions` または `/v1/responses` の小さい非機密 fixture で、
  `quota_reserve` と upstream が成功すること、`/quota` の状態が不自然に減っていないことを確認します。
- Tokenizer RPC failure が継続する場合は、原因が解消するまで再試行を増やさず fail-closed のままにし、
  revision ID と安全な stage event だけを記録します。

## 今回のレビューで未対応とした項目

`handleAdmin` のルート別 handler への分割は、今回の修正では実施していない。これは機能不具合ではなく構造改善であり、JWT 検証、入力検証、エラー境界、reconciliation の挙動修正とは独立しているため、変更範囲と回帰リスクを抑える目的で保留した。
