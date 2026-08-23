# GitHub Actions CI/CD Design

- Date: 2026-08-23
- Status: Approved (Version Override 方式へ改訂)
- Scope: `.github/workflows/` 配下の新規ワークフロー 2 本と、それに付随する運用手順

## 目的

OCTG（OpenAI 互換 API Gateway）のデプロイと検証を GitHub Actions へ集約し、次の 2 つの自動化を実現する。

1. master マージ時に production 環境へ自動デプロイする
2. master 向け PR の更新時に専用 preview Worker の新バージョンを 0% traffic で active deployment へ追加し、Version Override で preview 環境の疎通テストを行う

## 決定事項（ユーザー承認済み）

| 項目 | 決定 |
| --- | --- |
| 環境構成 | production deploy と preview Worker / D1 / Durable Object / control-plane data を分離する。upstream billing principal は dedicated または shared を選択できるが、shared の場合は bounded quota coordination を必須とする。staging 等の名前付き wrangler environment は作らず、preview workflow が一時 config で resource ID と quota limit を指定する |
| PR 時の Preview 方式 | Durable Objects Worker では Cloudflare Preview URL が生成されないため、専用 preview Worker に `wrangler versions upload` → 新バージョン 0% / 現行バージョン 100% の `versions deploy` → `Cloudflare-Workers-Version-Overrides` ヘッダーで新バージョンを指定して検証する。通常トラフィックには新バージョンを流さず、検証後は現行バージョン 100% に戻す。PR checkout のコード・`wrangler.jsonc`・smoke script は preview control-plane credential / resource のみで実行し、production D1/Worker/DO secret / resource を渡さない。shared upstreamを使う場合も、preview quota coordinationが未設定なら実行しない |
| 疎通テスト範囲 | 1 つの論理テストとして `POST /v1/chat/completions` を最大 3 回試行する。認証 → 分類 → Tokenizer → quota reserve → upstream → settle の全経路を通す。各試行は独立した request のため、preview MINI pool の bounded quota は最大 3 回分消費し得る。shared upstream の場合も coordination 上限を超える request は upstream へ送らない |
| 疎通テスト用モデル | 既に model_registry 登録済みの MINI プールモデル `gpt-5-mini` を使用。`gpt-5-nano` 用 migration は作らない（クォータはプール単位のトークン数で管理され、モデル価格は無関係なため）。モデル名は workflow 内で変数化し差し替え可能にする |
| Secret 管理 | production deploy secret と preview environment secret を分離して登録する。生値はコード・ログへ出力しない |
| 品質ゲート | PR 時・master push 時の両方で `npm run typecheck` + `npm test` をデプロイ前に実行 |

## アーキテクチャ

```text
PR 更新 (→ master)
  └─ preview-smoke.yml (environment: preview)
       typecheck/test → preview config生成 → preview D1 migration → versions upload
       → 新版 0% / 現行版 100% → Version Override で preview URL に疎通テスト
       → 現行版 100% に復元

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
| Step 1 | Node.js 22 セットアップ、`npm ci`、`npm run typecheck`、`npm test` |
| Step 2 | PR checkout の `wrangler.jsonc` を TypeScript の JSONC parser で読み、main/assets/migrations_dir を repository absolute path に変換した一時 configを生成する。preview D1 の database ID、upstream URL、`QUOTA_LIMIT_STANDARD`、`QUOTA_LIMIT_MINI` を注入し、preview credentialで `wrangler d1 migrations apply DB --remote` を実行する。STANDARD quotaは未設定または0未満、MINI quotaは未設定または0以下の場合に fail-closed で停止する。STANDARDの`0`はpool無効化を表す。その後、`WRANGLER_OUTPUT_FILE_PATH` を指定した `wrangler versions upload --message "pr-<number> <sha>"` で専用 preview Worker の新バージョンを作成し、ND-JSON の `version-upload.version_id` を取得する。同時に `wrangler deployments status --json` から現行の 100% version ID を取得する。現行 deployment が単一の 100% version でない場合は変更せず失敗する |
| Step 3 | `wrangler versions deploy <new>@0% <current>@100% --yes` で専用 preview Worker に新バージョンを追加する。preview URL へ `Cloudflare-Workers-Version-Overrides: <preview-worker-name>="<new>"`（`OCTG_PREVIEW_WORKER_NAME`、省略時 `octg-gateway-preview`）を付けて `POST /v1/chat/completions`（model: `gpt-5-mini`、最小 fixture）を最大 3 回試行し、HTTP 200、応答本文の content 相当、`X-OCTG-Worker-Version: <new>` を検証する。失敗ログは HTTP status、形式検証済み request ID、sanitize/truncate 済み error message のみを記録し、response body は出力しない |
| Step 4 | smoke test の成否にかかわらず `wrangler versions deploy <current>@100% --yes` を実行し、現行バージョン 100% に復元する。復元失敗も workflow 失敗とする |
| リトライ | 最大 3 回・10 秒間隔（Worker 初期化・伝播遅延対策）、1 回あたりタイムアウト 60 秒 |
| concurrency | production deploy と同じ group: `octg-deployment`、cancel-in-progress: **false**。Workers は 1 deployment に最大 2 version のため、PR 間および production deploy を直列化し cleanup を必ず実行する |
| permissions | `contents: read` のみ |

### deploy-production.yml（master push 時）

| 項目 | 内容 |
| --- | --- |
| トリガー | `push` to master |
| Step 1 | Node.js 22 セットアップ、`npm ci`、`npm run typecheck`、`npm test` |
| Step 2 | `wrangler d1 migrations apply octg --remote --config apps/gateway-worker/wrangler.jsonc`（冪等。適用済み tag はスキップされる） |
| Step 3 | `wrangler deploy --config apps/gateway-worker/wrangler.jsonc`。DO migration v1/v2 を含む manifest でデプロイする |
| concurrency | group: `octg-deployment`、cancel-in-progress: **false**（preview smoke と production deploy の直列化） |
| permissions | `contents: read` のみ |

## Secrets / 変数

production deploy 用の GitHub Secrets、アカウント識別子用の GitHub Actions Variables、PR preview 用の GitHub Environment `preview` Secrets を分離して登録する。

| Secret 名 | 用途 | 備考 |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | production Worker deploy + production D1 migration | production workflow のみ。最小権限: Workers Scripts Edit、D1 Edit、Account Settings Read |

GitHub Environment `preview` の Secrets:

| Secret 名 | 用途 | 備考 |
| --- | --- | --- |
| `CLOUDFLARE_PREVIEW_API_TOKEN` | preview Worker deploy + preview D1 migration | preview resourceだけに権限を限定する |
| `OCTG_PREVIEW_SMOKE_API_KEY` | preview疎通テスト用クライアントキー（`octg_sk_*`） | preview D1に登録するCI専用キー。policyで利用可能モデルを絞る |

GitHub Actions Variables に以下を登録する。

| Variable 名 | 用途 | 備考 |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | production Cloudflare アカウント ID | production workflow のみ |
| `CLOUDFLARE_PREVIEW_ACCOUNT_ID` | preview Cloudflare アカウント ID | production accountと分離することを推奨 |
| `OCTG_PREVIEW_DATABASE_ID` | preview D1 database ID | production D1 IDを設定しない |
| `OCTG_PREVIEW_UPSTREAM_BASE_URL` | preview upstream の URL | dedicated endpointまたはshared billing principalのendpoint。`CLOUDFLARE_PREVIEW_ACCOUNT_ID` とupstream billing accountを同一視しない |
| `OCTG_PREVIEW_QUOTA_LIMIT_STANDARD` | Preview STANDARD poolの上限 | 必須。0でSTANDARD poolを無効化できる。Production配分と合算してupstreamのbounded quotaを超えない値 |
| `OCTG_PREVIEW_QUOTA_LIMIT_MINI` | Preview MINI poolの上限 | 必須。smoke最大3試行分を含むbounded quota。未設定時はworkflowを停止 |
| `OCTG_PREVIEW_BASE_URL` | Version Override を付けて呼び出す preview Worker URL | 固定 preview WorkerのURL。Secretではない |
| `OCTG_PREVIEW_WORKER_NAME` | preview Worker 名 | 任意。未設定時は `octg-gateway-preview` |
| `SMOKE_MODEL` | 疎通テスト用モデル | 任意。未設定時は `gpt-5-mini` |

取り扱い規則:

- キー素材は curl コマンドラインへ直接展開せず、必ず `env:` 経由で参照する
- ワークフロー内でキー値を echo / ログ出力しない
- `octg_sk_*`・OpenAI API key をリポジトリのコード・ドキュメントへ記載しない（AGENTS.md 制約）

### 事前手順（一度だけ実施）

1. preview Worker、preview D1、preview Durable Object、client/policy/model registry、監査・reconciliation stateをproductionと分離して作成する。upstreamはdedicatedまたはshared billing principalを選択する
2. `OCTG_KEY_PEPPER` を Preview Worker と同じ値に設定し、`scripts/seed-client.mjs` で preview専用クライアントキーの seed SQL を生成して preview D1へ登録する。production用 `seed-client-remote.mjs` をpreview resourceへ向けて実行しない
3. shared upstreamを選択する場合、Preview quota上限、Production側の配分、coordination未設定時のfail-closed条件、監視項目を定義する
4. GitHub Environment `preview` の Secrets と、Actions Variablesへ必要な値を登録する
5. production用 Secretsは `deploy-production.yml` にだけ登録し、preview workflowへ渡さない
6. Cloudflare側でpreview API tokenを発行し、preview resourceだけへ権限を限定する

## エラー処理

| 状況 | 挙動 |
| --- | --- |
| typecheck / unit test 失敗 | 後続ステップへ進まない（workflow 失敗） |
| Version ID / 現行 100% version の取得失敗 | deployment を変更せず workflow を失敗扱いにする |
| Version deployment 失敗 | smoke test を実行せず workflow を失敗扱いにする |
| 疎通テスト失敗 | PR check 失敗。1 つの論理テストにつき最大 3 回試行し、それでも失敗した場合に失敗扱いにする。必要に応じて branch protection の required check に設定できる |
| 復元 deployment 失敗 | workflow を失敗扱いにする。手動で現行 version 100% の deployment を復元する |
| 本番デプロイ失敗 | workflow 失敗。rollback は Cloudflare deployment version rollback を手動実施（README の運用手順に従う） |
| D1 migration | 冪等なため再実行安全。適用済み tag はスキップされる |

## テスト方針

- ワークフローファイル自体は PR 作成時に実環境で検証する（初回 PR で Version Override smoke test と復元が緑になることを確認）
- actionlint がインストール済みなら両 workflowへ実行し、未インストール時だけ YAML parserへfallbackする。actionlint自体の失敗はfallbackで隠さない
- 疎通テストの期待値: HTTP 200、JSON 応答、`choices[0]` 相当の本文存在、`X-OCTG-Worker-Version` と override ID の一致。preview D1 IDがProductionと異なること、Preview quota limitが一時configへ注入されること、shared upstream時のcoordination上限超過がupstreamへ到達しないことを運用検証する

## 対象外（Out of Scope）

- staging 環境の新設
- Cloudflare が自動生成する Preview URL の利用（Durable Objects Worker ではURLが生成されないため、固定preview WorkerとVersion Overrideを使う）
- `gpt-5-nano` の model_registry 登録 migration
- Admin API（Cloudflare Access 背後）の疎通テスト
- デプロイ通知（Slack 等）
- OpenAI Usage API との reconciliation の自動化
