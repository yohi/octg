# Admin Web UI 設計書

## 目的

Cloudflare Access 認証済みの運用者が、ブラウザから Admin API の内容を
参照・編集できる Web UI を提供する。

JSON Admin API とブラウザ UI の実装済み契約を本書に記載する。Cloudflare Access
application の実際の path 設定と本番デプロイ後の確認事項は、末尾の運用手順に分ける。

## 現在の実装状況

| 対象 | 状態 | 実装箇所 |
| --- | --- | --- |
| JSON Admin API | 実装済み | `apps/gateway-worker/src/admin.ts` |
| Cloudflare Access JWT 検証 | 実装済み | `apps/gateway-worker/src/access.ts` |
| Reconciliation API | 実装済み | `POST /admin/reconcile` |
| ブラウザ UI | 実装済み | `apps/gateway-worker/public/admin/ui/` |
| Workers Static Assets | 実装済み | `apps/gateway-worker/wrangler.jsonc` |
| `ASSETS` binding | 実装済み | `apps/gateway-worker/src/index.ts` の `Env` |
| UI 配信統合テスト | 実装済み | `apps/gateway-worker/test/admin-ui.test.ts` |
| ブラウザ QA | 実施済み | Chromium による desktop / tablet / mobile 手動確認 |

現在実装されている Admin API は次のとおりである。

```text
GET  /admin/quota
GET  /admin/usage
GET  /admin/clients
GET  /admin/models
PUT  /admin/clients/:id/policy
PUT  /admin/models/:model
POST /admin/reconcile
POST /admin/reconcile/:pool/:utcDay/:targetRequestId
```

`/admin/ui` および `/admin/ui/*` は `handleAdmin` とは別の Worker-first ルートである。
JWT 検証後に `env.ASSETS.fetch(request)` へ渡し、`/admin/ui` は Workers Static Assets
の HTML handling により `/admin/ui/` へ正規化する。その他の `/admin/*` は既存の
JSON Admin API として扱う。

## 背景

`apps/gateway-worker/src/admin.ts` に実装された Admin API は JSON API として
動作しており、運用者は `curl` などで直接呼び出す必要がある。
運用頻度の高い quota / usage / clients / models の確認と、
クライアントポリシー・モデル設定の変更を、同じ Cloudflare Access セッションで
保護されたブラウザ UI から行えるようにする。

## UI の設計選択

以下の方式を実装に採用している。

| 項目 | 採用 | 理由 |
| --- | --- | --- |
| 配信方式 | 同じ Worker 内の Static Assets | 認証・ドメイン・デプロイを API と一元管理する |
| UI パス | `/admin/ui/*` | API `/admin/*` と分離し、既存 API の互換性を維持する |
| 認証 | Cloudflare Access | UI と API で同じ Access セッションを利用する |
| 画面構成 | 単一ページダッシュボード | quota / usage / clients / models を一画面で確認する |
| 編集 UX | インライン編集 | Clients と Models の PUT に対応する |
| 技術スタック | バニラ HTML/CSS/JS + Pico.css | 依存追加とビルドを避け、軽量に保つ |
| CSS 配信 | Pico.css を同梱 | 外部 CDN に依存せず同一ドメインから配信する |
| UI テスト | Worker 統合テスト + 実ブラウザ QA | Static Assets 境界と操作結果を分けて確認する |

## アーキテクチャ

### 現在の Admin API フロー

```text
HTTP Client
        │ /admin/* + cf-access-jwt-assertion
        ▼
Cloudflare Worker
        │ handleAdmin
        │ verifyAccessJwt
        ▼
JSON Admin API
        │
        ├── Durable Object: QuotaController
        └── D1: clients, client_policies, model_registry, requests
```

### ブラウザ UI フロー

```text
Browser (Cloudflare Access 認証済み)
        │ GET /admin/ui/
        ▼
Cloudflare Worker
        │ verifyAccessJwt → env.ASSETS.fetch(request)
        ▼
Browser (同じ Access セッション)
        │ fetch /admin/quota, /admin/usage, ...
        ▼
現在の JSON Admin API
```

Static Assets と Admin API は Worker 側で同じ Access JWT 検証を通過する。さらに、
Cloudflare Access application が `/admin/*` を実際に保護していること、同じ AUD を
使用していることを本番デプロイ後に確認する。

## 配信パスとルーティング

`public/admin/ui/...` に静的ファイルを配置し、`/admin/ui/*` のみを認証後に
Static Assets へ渡す。

| パス | 実ファイル | 処理 |
| --- | --- | --- |
| `/admin/ui` | `public/admin/ui/index.html` | `/admin/ui/` へ誘導する |
| `/admin/ui/` | `public/admin/ui/index.html` | `index.html` を返す |
| `/admin/ui/app.js` | `public/admin/ui/app.js` | Static Assets |
| `/admin/ui/api.js` | `public/admin/ui/api.js` | Static Assets |
| `/admin/ui/render.js` | `public/admin/ui/render.js` | Static Assets |
| `/admin/ui/editors.js` | `public/admin/ui/editors.js` | Static Assets |
| `/admin/ui/styles.css` | `public/admin/ui/styles.css` | Static Assets |
| `/admin/ui/pico.min.css` | `public/admin/ui/pico.min.css` | Static Assets |
| `/admin/*` | なし | 既存 `handleAdmin` が JSON API を処理する |

HTML からは絶対パス `/admin/ui/app.js`、`/admin/ui/styles.css`、
`/admin/ui/pico.min.css` を参照する。

## UI 構成

### ページレイアウト

単一ページを Pico.css と `styles.css` でスタイリングし、次の要素を配置する。

1. **ヘッダー**: タイトル「OCTG Admin」と最終更新時刻
2. **Quota セクション**: `GET /admin/quota` の STANDARD / MINI をカード表示
3. **Usage セクション**: `GET /admin/usage` の結果をテーブル表示
4. **Clients セクション**: `GET /admin/clients` の結果を表示し、インライン編集を提供
5. **Models セクション**: `GET /admin/models` の結果を表示し、インライン編集を提供

### Quota / Usage のレスポンススキーマ

UI は公開 `/quota` のレスポンスではなく、Admin API 固有のレスポンスを使用する。
レスポンスの JSON キー、表示、空結果、順序、更新時刻の扱いを次のとおり固定する。

#### `GET /admin/quota`

実装済みレスポンスは次の形である。

```json
{
  "request_id": "req_01H...",
  "utc_day": "2026-08-12",
  "pools": {
    "standard": {
      "pool": "STANDARD",
      "limit": 1000000,
      "used": 1500,
      "remaining": 998500,
      "resetAt": "2026-08-13T00:00:00.000Z"
    },
    "mini": {
      "pool": "MINI",
      "limit": 10000000,
      "used": 0,
      "remaining": 10000000,
      "resetAt": "2026-08-13T00:00:00.000Z"
    }
  }
}
```

| JSON フィールド | 表示ラベル | 単位 | 空結果・表示規則 |
| --- | --- | --- | --- |
| `request_id` | Request ID | 識別子 | 常に保持する。画面では詳細またはエラー調査用に表示する |
| `utc_day` | UTC 日 | `YYYY-MM-DD` | 常に表示し、ローカル日へ変換しない |
| `pools.standard` | STANDARD | オブジェクト | 常にカードを表示する。値が 0 の場合も「0」と表示する |
| `pools.mini` | MINI | オブジェクト | 常にカードを表示する。値が 0 の場合も「0」と表示する |
| `limit` | 上限 | tokens | トークン数として整数表示する |
| `used` | 使用済み | tokens | 0 を空欄にせず表示する |
| `remaining` | 残り | tokens | 0 を空欄にせず表示する |
| `resetAt` | リセット時刻 | ISO 8601 timestamp | 各プールの次回 UTC 日境界として表示する |
| `pool` | Pool | enum | `STANDARD` または `MINI` を表示する |

カードの順序は STANDARD、MINI の固定順とし、カード内の統計は上限、使用済み、
残り、リセット時刻の順で表示する。Quota は空の
プールを返さず、値がない場合は API 契約違反としてエラー表示にする。

#### `GET /admin/usage`

実装済みレスポンスは次の形である。

```json
{
  "request_id": "req_01H...",
  "utc_day": "2026-08-12",
  "clients": [
    { "client_id": "client_demo", "requests": 12, "tokens": 1500 }
  ]
}
```

| JSON フィールド | 表示ラベル | 単位 | 空結果・表示規則 |
| --- | --- | --- | --- |
| `request_id` | Request ID | 識別子 | 常に保持する。画面では詳細またはエラー調査用に表示する |
| `utc_day` | UTC 日 | `YYYY-MM-DD` | 集計対象日として常に表示し、ローカル日へ変換しない |
| `clients` | Clients | 配列 | 空配列の場合は「利用実績なし」と表示し、空行は追加しない |
| `clients[].client_id` | Client ID | 識別子 | そのまま表示する |
| `clients[].requests` | Requests | requests | 0 を空欄にせず表示する |
| `clients[].tokens` | Tokens | tokens | 0 を空欄にせず表示する |

Usage の行は `client_id` の昇順で UI 側が並べる。現行 API の SQL は配列順を保証
しないため、API の返却順を表示順の契約として扱わない。Usage レスポンスには
更新 timestamp がないため、ヘッダーの最終更新時刻にはレスポンス取得完了時刻を
使用し、`utc_day` を更新時刻として扱わない。Quota の最終更新時刻は各プールの
`resetAt` を使用する。Usage のヘッダー時刻は各 response の取得完了時刻である。

### インライン編集

- 編集対象行の「Edit」ボタンで対象フィールドを入力要素に切り替える
- 「Save」で `PUT` を送信し、「Cancel」で元の表示へ戻す
- 成功時は該当セクションを再取得する
- 失敗時は入力値を維持し、行内にエラーメッセージを表示する

### Clients 編集フィールド

| フィールド | 型 | 入力方法 |
| --- | --- | --- |
| `overflow_mode` | enum | select: REJECT, PAID_SHARED |
| `output_limit_mode` | enum | select: REJECT, CLAMP |
| `max_paid_usd_day` | number | number input (`min=0`) |
| `cache_enabled` | boolean | checkbox |
| `tools_mode` | enum | select: REJECT, ALLOW |

Admin API は全フィールドを必須とし、`max_paid_usd_day` には有限の 0 以上の数値を
要求する。`tools_mode` も必須であり、`REJECT` または `ALLOW` 以外は不正な入力として
400 を返す。UI は保存時にこの 5 フィールドを常に送信する。

### Models 編集フィールド

| フィールド | 型 | 入力方法 |
| --- | --- | --- |
| `complimentary_pool` | enum | select: STANDARD, MINI, NONE |
| `enabled` | boolean | checkbox |
| `fallback_model` | string \| null | text input（空欄で null） |

Admin API は全フィールドを必須とする。不正な入力には 400 を返し、対象モデルが
存在しない場合は 404 を返す。

## 認証

### 現在の Admin API 認証

- `cf-access-jwt-assertion` ヘッダーを必須とする
- 署名アルゴリズムは RS256 のみを許可する
- `iss` は `ACCESS_TEAM_DOMAIN`、`aud` は `ACCESS_AUD` と一致させる
- `exp` を必須とし、期限切れ JWT を拒否する
- `ACCESS_JWT_PUBLIC_JWK` があればローカル JWK set を使用する
- ローカル JWK set がなければ Access の `/cdn-cgi/access/certs` から JWKS を取得する
- 検証失敗は理由を公開せず、共通の 401 `invalid_api_key` 応答とする
- `Authorization: Bearer` と Service Token は Admin API の認証に使用しない

### ブラウザ UI 認証

UI からの API リクエストは、ブラウザの Cloudflare Access セッションを利用する。
追加の認証情報や秘密鍵をブラウザへ配布しない。
`/admin/ui/*` と `/admin/*` は同一の Cloudflare Access application で保護し、
その application の同一 AUD tag を `ACCESS_AUD` に設定する。別の application を
使用する構成を採用する場合は、Linked App Token 等の構成を明記し、UI と API の
両方で実際の `cf-access-jwt-assertion` の `aud` が `ACCESS_AUD` と一致することを
本番確認手順で検証する。
セッション失効時のリダイレクト動作はリポジトリ内のコードだけでは保証せず、
Cloudflare Access アプリケーションの設定と合わせて本番環境で確認する。

## Static Assets の実装

次の静的ファイルを `apps/gateway-worker/public/admin/ui/` から配信する。

- `index.html`: UI エントリポイント
- `styles.css`: Pico.css 上書き用の追加スタイル
- `pico.min.css`: 同梱する Pico.css
- `app.js`: fetch、レンダリング、インライン編集のロジック
- `api.js`: Admin API の同一オリジン request と response/error 正規化
- `render.js`: quota / usage / clients / models の安全な DOM 描画
- `editors.js`: clients / models のインライン編集

`apps/gateway-worker/wrangler.jsonc` の Static Assets 設定は次のとおりである。

```jsonc
{
  // ... existing config
  "assets": {
    "directory": "./public",
    "binding": "ASSETS",
    "html_handling": "auto-trailing-slash",
    "not_found_handling": "none",
    "run_worker_first": ["/admin/*"]
  }
}
```

次の点を Worker 統合テストとローカル実ブラウザ QA で検証する。Cloudflare の
production path と Access application の設定はデプロイ後にも同じ項目を確認する。

- `/admin/ui` と `/admin/ui/` の正規化
- `/admin/ui/*` と既存 `/admin/*` JSON API の競合がないこと
- 未知の静的パスが意図どおり API handler または 404 に到達すること
- `ASSETS` binding は JWT 検証済みの UI request からのみ使用する

### Static Assets の認証境界

`run_worker_first: ["/admin/*"]` により Worker が先に処理し、UI path では
`verifyAccessJwt()` 成功後にだけ `env.ASSETS.fetch(request)` を呼び出す。
認証前に直接 Static Assets へ到達する fallback は持たない。

- `/admin/ui/`
- `/admin/ui/app.js`
- `/admin/ui/styles.css`

`pico.min.css` および `/admin/ui/*` のすべての静的ファイルも同じ境界で保護する。
Static Assets の設定だけで認証を実現できると仮定せず、Cloudflare Access application
の path 設定と未認証時の拒否結果を本番確認する。

## エラー処理

### 現在の Admin API エラー

| 場面 | 動作 |
| --- | --- |
| JWT がない、または無効 | 401 `invalid_api_key` |
| PUT の入力が不正 | 400 `invalid_request` |
| 対象 client / model が存在しない | 404 `not_found` |
| Reconciliation 実行失敗 | 502 `reconciliation_failed` |
| 未知の Admin API ルート | JWT 検証後に 404 `not_found` |

### ブラウザ UI エラー

| 場面 | 動作 |
| --- | --- |
| API 取得失敗 | セクションにエラーメッセージと再試行ボタンを表示する |
| 編集 PUT 失敗 | 行内にエラーメッセージを表示し、入力値を維持する |
| ネットワークエラー | ページ内の通知領域で表示する |
| 認証切れ | Access の応答に従い、必要なら再認証を案内する |

## セキュリティ

### 現在の実装

- Admin API は Cloudflare Access JWT を検証する
- Service Token や秘密鍵をブラウザへ露出する実装は存在しない
- Clients / Models の入力値は Admin API 側で検証する
- 認証失敗の詳細を応答 body に含めない

### UI の実装済み要件

- UI と API を同一の Access 保護対象にする
- クライアント側バリデーションは UX 向上のために行い、API 側の検証を維持する
- Pico.css を同梱し、外部 CDN への依存を追加しない
- UI 内へ Service Token、秘密鍵、クライアントキーを埋め込まない
- 状態変更要求に `Origin` がある場合は `new URL(request.url).origin` と完全一致する
  ことを要求する。Origin がない認証済み CLI request は互換性のため許可する。
  SameSite cookie 設定だけを認証境界または CSRF 対策として扱わない。
- 次の 4 つの状態変更 endpoint について、有効な Access JWT があっても異なる
  Origin の要求を 403 `origin_not_allowed` で拒否し、状態を変更しないテストを用意する。
  - `PUT /admin/clients/:id/policy`
  - `PUT /admin/models/:model`
  - `POST /admin/reconcile`
  - `POST /admin/reconcile/:pool/:utcDay/:targetRequestId`

## テスト・動作確認

### 現在の自動テスト

`apps/gateway-worker/test/admin-api.test.ts` は主に次を検証している。

- JWT がない Admin API リクエストの 401
- JWT 検証後の未知ルートの 404
- Clients / Models の PUT が認証境界の内側にあること
- Client policy の正常な更新
- Clients / Models の不正 payload の拒否
- Client policy の effective value とデフォルト値
- `output_limit_mode` の保存と読み戻し
- `tools_mode` の保存と読み戻し
- `utc_day` を含む Admin GET response metadata
- 4 つの状態変更 endpoint に対する foreign Origin 拒否と無変更
- `/admin/ui/` の JWT 保護、Static Assets 配信、未知 Admin API route の JSON 404

`apps/gateway-worker/test/access.test.ts` は Access JWT の issuer、audience、
署名、`exp` などの検証を扱う。Reconciliation の処理自体は
`apps/gateway-worker/test/reconcile.test.ts` で検証する。

ブラウザ UI の操作自体は自動 E2E にせず、Chromium による手動 QA で確認する。
Worker 統合テストは Static Assets 認証境界を、`admin-api.test.ts` は Admin API の
認証・Origin・mutation 契約を確認する。`POST /admin/reconcile` の実サービス成功経路は
ローカル fixture の範囲外であり、デプロイ後の運用確認に残す。

### 現在のローカル確認手順

1. `npm install`
2. `npm run dev -w apps/gateway-worker`
3. 有効な Access JWT を使い、各 Admin API が JSON を返すことを確認する
4. JWT なし、無効 JWT、期限切れ JWT が 401 になることを確認する
5. Clients / Models の `PUT` 後に対応する `GET` で値を確認する
6. `POST /admin/reconcile` の成功時と失敗時の JSON 応答を確認する
7. 認証済み `/admin/ui/` で UI を開き、4 セクション、再試行、Clients / Models の
   編集・保存・Cancel を Chromium で確認する
8. 375px、768px、1280px 幅で横 overflow がないこと、表だけが内部 scroll することを確認する

### UI の本番確認手順

1. Cloudflare Access が `/admin/ui/*` と `/admin/*` を保護することを確認する
2. 両パスが同一 application と同一 AUD tag を使用し、実際の
   `cf-access-jwt-assertion` の `aud` が `ACCESS_AUD` と一致することを本番環境で
   確認する。別 application の場合は Linked App Token 等の構成も確認する
3. 未認証の `/admin/ui/`、`app.js`、`styles.css` が拒否されることを確認する。
   `run_worker_first` の場合は、認証後に Worker が `env.ASSETS.fetch(request)` を
   呼び出すことも確認する
4. `/admin/ui/`、`app.js`、`styles.css`、`pico.min.css` から静的 HTML/CSS/JavaScript
   が配信され、外部 CDN request がないことを確認する
5. quota / usage / clients / models の JSON が UI に表示されることを確認する
6. Clients / Models の編集・保存結果が API response と一致することを確認する
7. 有効な JWT + foreign Origin が 4 つの mutation endpoint で 403 になり、状態を変更
   しないことを確認する。Origin なしの管理 CLI は引き続き利用できることも確認する
8. 未認証、認証済み、セッション失効後の各ブラウザ動作を確認する
9. Static Assets の未知 path と既存 Admin API の routing が競合しないことを確認する

## 将来の拡張候補

- 実装済み `POST /admin/reconcile` を呼び出す手動実行ボタン
- 履歴データのグラフ表示
- ダーク / ライトテーマ切り替え
- E2E 自動テスト（Playwright）
- TypeScript 化やフロントエンドフレームワークの導入

## 関連ファイル

- `apps/gateway-worker/src/admin.ts`
- `apps/gateway-worker/src/access.ts`
- `apps/gateway-worker/src/index.ts`
- `apps/gateway-worker/src/reconcile.ts`
- `apps/gateway-worker/wrangler.jsonc`
- `apps/gateway-worker/test/admin-api.test.ts`
- `apps/gateway-worker/test/access.test.ts`
- `apps/gateway-worker/test/reconcile.test.ts`
- `SPEC.md`
