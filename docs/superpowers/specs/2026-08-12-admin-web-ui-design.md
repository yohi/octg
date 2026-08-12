# Admin Web UI 設計書

## 目的

Cloudflare Access 認証済みの運用者が、ブラウザから admin-api の内容を参照・編集できる Web UI を提供する。

## 背景

`apps/gateway-worker/src/admin.ts` に実装された admin-api は JSON API として動作しており、
運用者は curl 等で直接呼び出す必要がある。
運用頻度の高い quota / usage / clients / models の確認と、
クライアントポリシー・モデル設定の変更を、
同じ Cloudflare Access セッションで保護されたブラウザ UI から行えるようにする。

## 設計選択の経緯

| 項目 | 選択 | 理由 |
| --- | --- | --- |
| 配信方式 | 同じ Worker 内 Static Assets | 認証・ドメイン・デプロイを API と一元管理できる |
| UI パス | `/admin/ui/*` | API `/admin/*` と分離し、既存 API の互換性を維持 |
| 認証 | Cloudflare Access（既存） | UI と API が同じセッションで保護される。追加認証ロジック不要 |
| 画面構成 | 単一ページダッシュボード | 第一弾として最小構成で十分 |
| 編集 UX | インライン編集 | クリック数が少なく、API との対応が明確 |
| 技術スタック | バニラ HTML/CSS/JS + Pico.css | 依存追加なし、ビルド不要、軽量。 |
| | | Pico.css は `public/admin/ui/pico.min.css` へ同梱 |
| テスト | 手動確認（第一弾） | 軽量 UI のため、今回は自動 E2E テストは実施しない |

## アーキテクチャ

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
Cloudflare Worker
        │ verifyAccessJwt
        ▼
admin-api (handleAdmin)
        │
        ├── Durable Object: QuotaController
        └── D1: clients, client_policies, model_registry, requests
```

## 配信パスとルーティング

採用方式: `public/admin/ui/...` に配置する方式。

| パス | 実ファイル | 処理 |
| --- | --- | --- |
| `/admin/ui` | `public/admin/ui/index.html` | `html_handling` で |
| | | `/admin/ui/` へ誘導 |
| `/admin/ui/` | `public/admin/ui/index.html` | `index.html` を返す |
| `/admin/ui/app.js` | `public/admin/ui/app.js` | Static Assets によりそのまま配信 |
| `/admin/ui/styles.css` | `public/admin/ui/styles.css` | Static Assets 配信 |
| `/admin/*` | — | 既存 `handleAdmin` による JSON API |

絶対パス `/admin/ui/app.js` および `/admin/ui/styles.css` を使用する。

## UI 構成

### ページレイアウト

単一ページ。Pico.css でスタイリング。構成要素：

1. **ヘッダー**: タイトル「OCTG Admin」と最終更新時刻
2. **Quota セクション**: STANDARD / MINI の `GET /admin/quota` 結果をカード表示
3. **Usage セクション**: `GET /admin/usage` 結果をテーブル表示
4. **Clients セクション**: `GET /admin/clients` 結果をテーブル表示＋インライン編集
5. **Models セクション**: `GET /admin/models` 結果をテーブル表示＋インライン編集

### インライン編集

- 編集対象行の「Edit」ボタンを押すと、対象フィールドが入力要素に切り替わる
- 変更後「Save」ボタンで `PUT` 送信、「Cancel」で元に戻す
- 成功時は該当セクションを再取得して表示更新、失敗時は行内にエラーメッセージ

### Clients 編集フィールド

| フィールド | 型 | 入力方法 |
| --- | --- | --- |
| `overflow_mode` | enum | select: REJECT, PAID_SHARED |
| `output_limit_mode` | enum | select: REJECT, CLAMP |
| `max_paid_usd_day` | number | number input (min=0) |
| `cache_enabled` | boolean | checkbox |

### Models 編集フィールド

| フィールド | 型 | 入力方法 |
| --- | --- | --- |
| `complimentary_pool` | enum | select: STANDARD, MINI, NONE |
| `enabled` | boolean | checkbox |
| `fallback_model` | string \| null | text input（空欄で null） |

## 認証の動作

- API リクエストには `cf-access-jwt-assertion` ヘッダーが必要
- API 側の `verifyAccessJwt` が JWT を検証し、通過する
- Service Token は UI から利用しない

## 静的アセット配信（将来実装）

この設計書は管理 UI の API 契約と動作を定めるものとして作成された。
ブラウザ UI（HTML/CSS/JS）自体は、本 PR では**実装しない**。

実装時には以下を行う予定である：

- `apps/gateway-worker/public/admin/ui/` 配下に静的ファイルを配置する。
  - `index.html` — UI エントリポイント
  - `styles.css` — 追加スタイル（Pico.css 上書き用・最小限）
  - `pico.min.css` — 同梱 Pico.css
  - `app.js` — UI ロジック（fetch, レンダリング, インライン編集）
- `apps/gateway-worker/wrangler.jsonc` に `assets` 設定を追加して Workers Static Assets を有効化する。

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

`not_found_handling` は `none` とし、`/admin/ui` 配下以外は API handler に委ねる。
Static Assets はオリジンリクエストを優先して処理するため、
上記設定で `/admin/ui/*` は自動的に `public/admin/ui/*` へマップされ、
fetch handler への到達はない。

### `apps/gateway-worker/src/index.ts`

Static Assets による配信で十分なため、fetch handler における
`/admin/ui/*` 判定は不要。
`Env` インターフェースに `ASSETS: Fetcher` を追加する必要もない。

## エラー処理

| 場面 | 動作 |
| --- | --- |
| API 取得失敗 | セクションにエラーメッセージ表示、再試行ボタンを表示 |
| 編集 PUT 失敗 | 行内にエラーメッセージ、入力値は維持 |
| ネットワークエラー | トースト風メッセージで通知 |
| 認証切れ | Cloudflare Access がログイン画面にリダイレクトするため UI 側では特別対処不要 |

## セキュリティ

- UI も API も同一ドメイン・同一 Access 保護下
- Service Token や秘密鍵をブラウザに露出しない
- 入力値は admin-api 側で既存の検証が入るため、
  UI 側でもクライアント側バリデーションを行う（二重防御ではなく UX 向上のため）
- Pico.css は `public/admin/ui/pico.min.css` として同梱し、同一ドメインから配信する。

## テスト・動作確認

### ローカル確認手順

1. `npm install`
2. `npm run dev -w apps/gateway-worker`
3. 静的 UI は本 PR で未実装のため、API のみ動作確認する。
4. `curl` またはブラウザで以下の admin API にアクセスし、
   認証済みセッションでは JSON が取得でき、未認証セッションでは
   401 または Cloudflare Access ログイン画面に遷移することを確認する。
   - `/admin/quota`
   - `/admin/usage`
   - `/admin/clients`
   - `/admin/models`
5. Clients / Models の `PUT` API を呼び出した後、対応する `GET` API で
   値が保持されることを確認する。
6. **認証境界テスト**:
   - 未認証状態で `/admin/quota` などが 200 以外になることを確認
   - 認証済みセッションで JSON が取得できることを確認
   - セッション失効後の API 呼び出しで 401 または Cloudflare Access ログイン画面に遷移することを確認

### 本番確認手順

1. Cloudflare Access 経由で admin API (`/admin/*`) にアクセス
2. quota / usage / clients / models データが表示されることを確認
3. 編集・保存が成功し、API レスポンスと整合することを確認
4. **認証境界テスト**:
   - Cloudflare Access アプリで `/admin/*` が保護対象に含まれていることを確認
   - 未認証のブラウザセッションから `/admin/quota` などへアクセスし、
     200 以外の応答または Cloudflare Access ログイン画面へのリダイレクトとなることを確認
   - 認証済みセッションで JSON が取得できることを確認
   - セッション失効後の API 呼び出しで 401 または Cloudflare Access ログイン画面に遷移することを確認

## 将来の拡張候補（今回のスコープ外）

- `/admin/reconcile` の手動実行ボタン
- 履歴データのグラフ表示
- ダーク/ライトテーマ切り替え
- E2E 自動テスト（Playwright）
- TypeScript 化やフロントエンドフレームワークの導入

## 関連ファイル

- `apps/gateway-worker/src/admin.ts`
- `apps/gateway-worker/src/index.ts`
- `apps/gateway-worker/wrangler.jsonc`
- `apps/gateway-worker/test/admin-api.test.ts`
