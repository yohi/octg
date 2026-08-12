# Admin Web UI 設計書

## 目的

Cloudflare Access 認証済みの運用者が、ブラウザから Admin API の内容を
参照・編集できる Web UI を将来提供する。

現時点では JSON の Admin API のみ実装済みであり、ブラウザ UI は未実装である。
本書は、実装済み API の契約と、将来実装する UI の設計を区別して記載する。

## 現在の実装状況

| 対象 | 状態 | 実装箇所 |
| --- | --- | --- |
| JSON Admin API | 実装済み | `apps/gateway-worker/src/admin.ts` |
| Cloudflare Access JWT 検証 | 実装済み | `apps/gateway-worker/src/access.ts` |
| Reconciliation API | 実装済み | `POST /admin/reconcile` |
| ブラウザ UI | 未実装 | `apps/gateway-worker/public/admin/ui/` は未作成 |
| Workers Static Assets | 未設定 | `wrangler.jsonc` に `assets` 設定なし |
| `ASSETS` binding | 未設定 | `Env` に binding なし |
| UI E2E テスト | 未実装 | Admin API の自動テストのみ存在 |

現在実装されている Admin API は次のとおりである。

```text
GET  /admin/quota
GET  /admin/usage
GET  /admin/clients
GET  /admin/models
PUT  /admin/clients/:id/policy
PUT  /admin/models/:model
POST /admin/reconcile
```

`/admin/ui` および `/admin/ui/*` に対する静的配信ルートは存在しない。
これらのパスも現在は未知の Admin API ルートとして扱われ、JWT 検証を通過した後に
JSON の 404 応答となる。

## 背景

`apps/gateway-worker/src/admin.ts` に実装された Admin API は JSON API として
動作しており、運用者は `curl` などで直接呼び出す必要がある。
運用頻度の高い quota / usage / clients / models の確認と、
クライアントポリシー・モデル設定の変更を、同じ Cloudflare Access セッションで
保護されたブラウザ UI から行えるようにする。

## 将来 UI の設計選択

以下はブラウザ UI 実装時の提案であり、現在のリポジトリには未実装である。

| 項目 | 提案 | 理由 |
| --- | --- | --- |
| 配信方式 | 同じ Worker 内の Static Assets | 認証・ドメイン・デプロイを API と一元管理できる |
| UI パス | `/admin/ui/*` | API `/admin/*` と分離し、既存 API の互換性を維持する |
| 認証 | Cloudflare Access | UI と API で同じ Access セッションを利用する |
| 画面構成 | 単一ページダッシュボード | 第一弾として最小構成にする |
| 編集 UX | インライン編集 | クリック数が少なく、API との対応が明確になる |
| 技術スタック | バニラ HTML/CSS/JS + Pico.css | 依存追加とビルドを避け、軽量に保つ |
| CSS 配信 | Pico.css を同梱 | 外部 CDN に依存せず同一ドメインから配信する |
| UI テスト | 初期実装では手動確認 | E2E 自動化は将来拡張とする |

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

### 将来のブラウザ UI フロー

```text
Browser (Cloudflare Access 認証済み)
        │ GET /admin/ui/
        ▼
Cloudflare Worker
        │ Static Assets: public/admin/ui/index.html, styles.css, app.js
        ▼
Browser (同じ Access セッション)
        │ fetch /admin/quota, /admin/usage, ...
        ▼
現在の JSON Admin API
```

Static Assets と Admin API の双方が意図した Access ポリシーで保護されることは、
UI 実装時に Cloudflare 側のルート設定を含めて検証する。

## 将来の配信パスとルーティング

提案方式は `public/admin/ui/...` に静的ファイルを配置する方式とする。

| パス | 実ファイル | 提案する処理 |
| --- | --- | --- |
| `/admin/ui` | `public/admin/ui/index.html` | `/admin/ui/` へ誘導する |
| `/admin/ui/` | `public/admin/ui/index.html` | `index.html` を返す |
| `/admin/ui/app.js` | `public/admin/ui/app.js` | Static Assets で配信する |
| `/admin/ui/styles.css` | `public/admin/ui/styles.css` | Static Assets で配信する |
| `/admin/ui/pico.min.css` | `public/admin/ui/pico.min.css` | 静的配信する |
| `/admin/*` | なし | 既存 `handleAdmin` が JSON API を処理する |

HTML からは絶対パス `/admin/ui/app.js`、`/admin/ui/styles.css`、
`/admin/ui/pico.min.css` を参照する。

## 将来の UI 構成

### ページレイアウト

単一ページを Pico.css でスタイリングし、次の要素を配置する。

1. **ヘッダー**: タイトル「OCTG Admin」と最終更新時刻
2. **Quota セクション**: `GET /admin/quota` の STANDARD / MINI をカード表示
3. **Usage セクション**: `GET /admin/usage` の結果をテーブル表示
4. **Clients セクション**: `GET /admin/clients` の結果を表示し、インライン編集を提供
5. **Models セクション**: `GET /admin/models` の結果を表示し、インライン編集を提供

### Quota / Usage のレスポンススキーマ

UI は公開 `/quota` のレスポンスではなく、Admin API 固有のレスポンスを使用する。
レスポンスの JSON キー、表示、空結果、順序、更新時刻の扱いを次のとおり固定する。

#### `GET /admin/quota`

レスポンスは次の形とする。

```json
{
  "request_id": "req_01H...",
  "utc_day": "2026-08-12",
  "pools": {
    "standard": {
      "utcDay": "2026-08-12",
      "limit": 1000000,
      "confirmedTokens": 1200,
      "reservedTokens": 300,
      "uncertainTokens": 0,
      "requestCount": 12,
      "updatedAt": "2026-08-12T12:00:00.000Z",
      "pool": "STANDARD",
      "remaining": 998500
    },
    "mini": {
      "utcDay": "2026-08-12",
      "limit": 10000000,
      "confirmedTokens": 0,
      "reservedTokens": 0,
      "uncertainTokens": 0,
      "requestCount": 0,
      "updatedAt": "2026-08-12T12:00:00.000Z",
      "pool": "MINI",
      "remaining": 10000000
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
| `utcDay` | 対象 UTC 日 | `YYYY-MM-DD` | 各カード内で表示し、`utc_day` と一致することを前提とする |
| `limit` | 上限 | tokens | トークン数として整数表示する |
| `confirmedTokens` | 確定済み | tokens | 0 を空欄にせず表示する |
| `reservedTokens` | 予約中 | tokens | 0 を空欄にせず表示する |
| `uncertainTokens` | 不確実 | tokens | 0 を空欄にせず表示する |
| `requestCount` | リクエスト数 | requests | 0 を空欄にせず表示する |
| `remaining` | 残り | tokens | 0 を空欄にせず表示する |
| `updatedAt` | 最終更新 | ISO 8601 timestamp | 各プールの更新時刻として表示する |
| `pool` | Pool | enum | `STANDARD` または `MINI` を表示する |

カードの順序は STANDARD、MINI の固定順とし、カード内の統計は上限、確定済み、
予約中、不確実、リクエスト数、残り、最終更新の順で表示する。Quota は空の
プールを返さず、値がない場合は API 契約違反としてエラー表示にする。

#### `GET /admin/usage`

レスポンスは次の形とする。

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
`updatedAt` を使用する。

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

Admin API は全フィールドを必須とし、`max_paid_usd_day` には有限の 0 以上の数値を
要求する。不正な入力には 400 を返す。

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

### 将来のブラウザ UI 認証

UI からの API リクエストは、ブラウザの Cloudflare Access セッションを利用する。
追加の認証情報や秘密鍵をブラウザへ配布しない。
`/admin/ui/*` と `/admin/*` は同一の Cloudflare Access application で保護し、
その application の同一 AUD tag を `ACCESS_AUD` に設定する。別の application を
使用する構成を採用する場合は、Linked App Token 等の構成を明記し、UI と API の
両方で実際の `cf-access-jwt-assertion` の `aud` が `ACCESS_AUD` と一致することを
本番確認手順で検証する。
セッション失効時のリダイレクト動作はリポジトリ内のコードだけでは保証せず、
Cloudflare Access アプリケーションの設定と合わせて本番環境で確認する。

## Static Assets の実装案

ブラウザ UI の実装時には、次の静的ファイルを
`apps/gateway-worker/public/admin/ui/` に追加する。

- `index.html`: UI エントリポイント
- `styles.css`: Pico.css 上書き用の追加スタイル
- `pico.min.css`: 同梱する Pico.css
- `app.js`: fetch、レンダリング、インライン編集のロジック

`apps/gateway-worker/wrangler.jsonc` には Workers Static Assets の設定を追加する。
次の設定は実装案であり、現在の設定には含まれていない。

```jsonc
{
  // ... existing config
  "assets": {
    "directory": "./public",
    "binding": "ASSETS",
    "html_handling": "auto-trailing-slash",
    "not_found_handling": "none"
  }
}
```

UI 実装時には、次の点を実際の Workers Static Assets の挙動で検証する。

- `/admin/ui` と `/admin/ui/` の正規化
- `/admin/ui/*` と既存 `/admin/*` JSON API の競合がないこと
- 未知の静的パスが意図どおり API handler または 404 に到達すること
- `ASSETS` binding をコードから使用する必要があるかどうか

### Static Assets の認証境界

Static Assets が `handleAdmin` より先に処理される構成で `run_worker_first` を
使用しない場合、Cloudflare Access は未認証の次のリクエストを拒否しなければ
ならない。

- `/admin/ui/`
- `/admin/ui/app.js`
- `/admin/ui/styles.css`

`pico.min.css` および将来追加する `/admin/ui/*` の静的ファイルも同じ境界で保護
する。Static Assets の設定だけで認証を実現できると仮定せず、Cloudflare Access
application の path 設定と、未認証時の拒否結果を本番確認する。

`run_worker_first` を選択する場合は、Worker が Access の認証境界を維持した上で
`env.ASSETS.fetch(request)` を呼び出して静的ファイルを返す実装とする。認証前に
直接 `env.ASSETS.fetch(request)` へ到達するフォールバックを作らない。

## エラー処理

### 現在の Admin API エラー

| 場面 | 動作 |
| --- | --- |
| JWT がない、または無効 | 401 `invalid_api_key` |
| PUT の入力が不正 | 400 `invalid_request` |
| 対象 client / model が存在しない | 404 `not_found` |
| Reconciliation 実行失敗 | 502 `reconciliation_failed` |
| 未知の Admin API ルート | JWT 検証後に 404 `not_found` |

### 将来のブラウザ UI エラー

| 場面 | 提案する動作 |
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

### 将来 UI の要件

- UI と API を同一の Access 保護対象にする
- クライアント側バリデーションは UX 向上のために行い、API 側の検証を維持する
- Pico.css を同梱し、外部 CDN への依存を追加しない
- UI 内へ Service Token、秘密鍵、クライアントキーを埋め込まない
- 状態変更要求の要求元は、許可した Origin との一致検証または CSRF token により
  検証する。SameSite cookie 設定だけを認証境界または CSRF 対策として扱わない。
- 次の3つの状態変更 endpoint について、有効な Access JWT があっても異なる
  Origin の要求を拒否し、状態を変更しないテストを用意する。
  - `PUT /admin/clients/:id/policy`
  - `PUT /admin/models/:model`
  - `POST /admin/reconcile`

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

`apps/gateway-worker/test/access.test.ts` は Access JWT の issuer、audience、
署名、`exp` などの検証を扱う。Reconciliation の処理自体は
`apps/gateway-worker/test/reconcile.test.ts` で検証する。

ブラウザ UI、Static Assets 配信、インライン編集の E2E テストは存在しない。
また、Admin API の全 GET endpoint と `POST /admin/reconcile` の HTTP 成功経路を
`admin-api.test.ts` が網羅しているわけではない。

### 現在のローカル確認手順

1. `npm install`
2. `npm run dev -w apps/gateway-worker`
3. 有効な Access JWT を使い、各 Admin API が JSON を返すことを確認する
4. JWT なし、無効 JWT、期限切れ JWT が 401 になることを確認する
5. Clients / Models の `PUT` 後に対応する `GET` で値を確認する
6. `POST /admin/reconcile` の成功時と失敗時の JSON 応答を確認する
7. `/admin/ui/` は現時点で UI を返さず、認証後に JSON の 404 となることを確認する

### 将来 UI の本番確認手順

1. Cloudflare Access が `/admin/ui/*` と `/admin/*` を保護することを確認する
2. 両パスが同一 application と同一 AUD tag を使用し、実際の
   `cf-access-jwt-assertion` の `aud` が `ACCESS_AUD` と一致することを本番環境で
   確認する。別 application の場合は Linked App Token 等の構成も確認する
3. 未認証の `/admin/ui/`、`app.js`、`styles.css` が拒否されることを確認する。
   `run_worker_first` の場合は、認証後に Worker が `env.ASSETS.fetch(request)` を
   呼び出すことも確認する
4. `/admin/ui/` から静的 HTML、CSS、JavaScript が配信されることを確認する
5. quota / usage / clients / models の JSON が UI に表示されることを確認する
6. Clients / Models の編集・保存結果が API 応答と一致することを確認する
7. 未認証、認証済み、セッション失効後の各ブラウザ動作を確認する
8. Static Assets の未知パスと既存 Admin API のルーティングが競合しないことを確認する

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
