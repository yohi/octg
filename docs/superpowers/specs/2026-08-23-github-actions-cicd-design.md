# GitHub Actions CI/CD Design

- Date: 2026-08-23
- Status: Approved
- Scope: `.github/workflows/` 配下の新規ワークフロー 2 本と、それに付随する運用手順

## 目的

OCTG（OpenAI 互換 API Gateway）のデプロイと検証を GitHub Actions へ集約し、次の 2 つの自動化を実現する。

1. master マージ時に production 環境へ自動デプロイする
2. master 向け PR の更新時に Worker の Preview URL へデプロイし、実環境での疎通テストを行う

## 決定事項（ユーザー承認済み）

| 項目 | 決定 |
| --- | --- |
| 環境構成 | production のみ。staging 等の名前付き wrangler 環境は作らない |
| PR 時の Preview 方式 | `wrangler versions upload`。Preview URL で検証し、本番トラフィックには影響しない。D1 / DO は本番と共有する（疎通テストは本番 MINI プールを微小消費する） |
| 疎通テスト範囲 | `POST /v1/chat/completions` 1 リクエストのみ。認証 → 分類 → Tokenizer → quota reserve → upstream → settle の全経路を通す |
| 疎通テスト用モデル | 既に model_registry 登録済みの MINI プールモデル `gpt-5-mini` を使用。`gpt-5-nano` 用 migration は作らない（クォータはプール単位のトークン数で管理され、モデル価格は無関係なため）。モデル名は workflow 内で変数化し差し替え可能にする |
| Secret 管理 | GitHub Secrets に登録。生値はコード・ログへ出力しない |
| 品質ゲート | PR 時・master push 時の両方で `npm run typecheck` + `npm test` をデプロイ前に実行 |

## アーキテクチャ

```text
PR 更新 (→ master)
  └─ preview-smoke.yml
       typecheck/test → wrangler versions upload → preview URL で疎通テスト (gpt-5-mini)

master マージ (push)
  └─ deploy-production.yml
       typecheck/test → d1 migrations apply --remote → wrangler deploy
```

### ワークフロー構成

案 A（2 本分離）を採用する。

- トリガーとログが分離され、失敗時の切り分けが容易
- 疎通テストを PR check として表示できる（required check 化も可能）
- 共通ステップ（typecheck/test）の重複は数行程度であり、reusable workflow 化は YAGNI

### preview-smoke.yml（PR 時）

| 項目 | 内容 |
| --- | --- |
| トリガー | `pull_request` → master（types: opened, synchronize, reopened） |
| Step 1 | Node.js 20 セットアップ、`npm ci`、`npm run typecheck`、`npm test` |
| Step 2 | `wrangler versions upload --message "pr-<number> <sha>"`。stdout から Preview URL を抽出し job output へ格納 |
| Step 3 | Preview URL へ `POST /v1/chat/completions`（model: `gpt-5-mini`、最小 fixture）。HTTP 200 かつ応答本文に content 相当が存在することを検証 |
| リトライ | 最大 3 回・10 秒間隔（Worker 初期化・伝播遅延対策）、1 回あたりタイムアウト 60 秒 |
| concurrency | group: `preview-${{ github.event.pull_request.number }}`、cancel-in-progress: true |
| permissions | `contents: read` のみ |

### deploy-production.yml（master push 時）

| 項目 | 内容 |
| --- | --- |
| トリガー | `push` to master |
| Step 1 | Node.js 20 セットアップ、`npm ci`、`npm run typecheck`、`npm test` |
| Step 2 | `wrangler d1 migrations apply octg --remote --config apps/gateway-worker/wrangler.jsonc`（冪等。適用済み tag はスキップされる） |
| Step 3 | `wrangler deploy --config apps/gateway-worker/wrangler.jsonc`。DO migration v1/v2 を含む manifest でデプロイする |
| concurrency | group: `production-deploy`、cancel-in-progress: **false**（デプロイの直列化） |
| permissions | `contents: read` のみ |

## Secrets / 変数

GitHub Secrets に以下を登録する。

| Secret 名 | 用途 | 備考 |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Workers デプロイ + D1 migration | 最小権限: Workers Scripts Edit、D1 Edit、Account Settings Read |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare アカウント ID | vars ではなく secrets 扱いでよい（機微性は低いが統一） |
| `OCTG_SMOKE_API_KEY` | 疎通テスト用クライアントキー（`octg_sk_*`） | CI 専用キー。policy で利用可能モデルを絞ることを推奨 |

取り扱い規則:

- キー素材は curl コマンドラインへ直接展開せず、必ず `env:` 経由で参照する
- ワークフロー内でキー値を echo / ログ出力しない
- `octg_sk_*`・OpenAI API key をリポジトリのコード・ドキュメントへ記載しない（AGENTS.md 制約）

### 事前手順（一度だけ実施）

1. `scripts/seed-client.mjs` で CI 専用クライアントキーの seed SQL を生成する
2. `scripts/seed-client-remote.mjs`（または `wrangler d1 execute octg --remote`）で本番 D1 へ登録する
3. GitHub Secrets へ 3 つの値を登録する
4. Cloudflare 側で API token を発行し、権限スコープを最小化する

## エラー処理

| 状況 | 挙動 |
| --- | --- |
| typecheck / unit test 失敗 | 後続ステップへ進まない（workflow 失敗） |
| Preview URL 抽出失敗 | smoke-test job を失敗扱いにする |
| 疎通テスト失敗 | PR check 失敗。必要に応じて branch protection の required check に設定できる |
| 本番デプロイ失敗 | workflow 失敗。rollback は Cloudflare deployment version rollback を手動実施（README の運用手順に従う） |
| D1 migration | 冪等なため再実行安全。適用済み tag はスキップされる |

## テスト方針

- ワークフローファイル自体は PR 作成時に実環境で検証する（初回 PR で preview-smoke が緑になることを確認）
- actionlint による構文チェックをローカルで任意実施する
- 疎通テストの期待値: HTTP 200、JSON 応答、`choices[0]` 相当の本文存在。quota reserve/settle は `/quota` 参照やログで別途目視確認できる（自動検証対象外）

## 対象外（Out of Scope）

- staging 環境の新設
- `gpt-5-nano` の model_registry 登録 migration
- Admin API（Cloudflare Access 背後）の疎通テスト
- デプロイ通知（Slack 等）
- OpenAI Usage API との reconciliation の自動化
