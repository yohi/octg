<!-- markdownlint-disable MD013 -->

# OCTG を Cloudflare AI Gateway の Custom Provider として登録する

この手順では、デプロイ済みの OCTG Worker を Cloudflare AI Gateway の **Custom Provider** として登録します。クライアントは Gateway A 経由で OCTG を呼び出し、OCTG は Gateway B 経由で OpenAI に接続します。

## アーキテクチャ

```text
Client
  │
  ▼
Cloudflare AI Gateway A  (Custom Provider: custom-octg)
  │
  ▼
OCTG Worker
  │
  ▼
Durable Object: QuotaController
  │
  ▼
Cloudflare AI Gateway B  (OpenAI provider-native endpoint)
  │
  ▼
OpenAI API
```

Gateway A と Gateway B は別の Gateway インスタンスにする必要があります。これにより、outbound リクエストが Gateway A の `custom-octg` ルートへ戻ることを防ぎ、inbound と outbound のログ、認証情報、ポリシーを分離できます。

AI Gateway の Run token はアカウント単位の権限であり、同一 Cloudflare アカウント内の他 Gateway や登録済み BYOK credential にアクセスできる範囲を持ち得ます。強い認可境界が必要な場合は、Gateway A と Gateway B を別 Cloudflare アカウントに配置するか、Worker 側の AI Gateway binding を使用して outbound 経路を Worker に束縛することを推奨します。

## 前提条件

- OCTG Worker がデプロイ済みであること。
- Gateway B（OCTG → OpenAI）が存在し、`OCTG_UPSTREAM_BASE_URL` が `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_b_id}/openai` で終わっていること。
- Gateway B に OpenAI Project A（Data Sharing ON）の API キーが BYOK として登録されていること。
- 少なくとも 1 つの OCTG クライアントキー（`octg_sk_*`）が存在し、その `key_hash` が D1 に登録されていること。
- Gateway A と Gateway B の Run token がアカウント全体に適用されることを理解し、それぞれを分離して管理・ローテーションすること。

## Gateway A の設定

1. Cloudflare Dashboard → AI Gateway → **Create Gateway** を開きます。
2. Gateway 名を入力します（例: `octg-ingress`）。
3. **Custom Providers** → **Add Custom Provider** を開き、以下を設定します。
   - **Provider Name**: `OCTG`
   - **Provider Slug**: `octg`
   - **Base URL**: `https://octg-gateway.<subdomain>.workers.dev`（末尾に `/v1` を付けない）
   - **Enable**: 有効
4. **Save** をクリックします。
5. Gateway A の **Settings** を開き、**Authenticated Gateway** を有効にします。
6. Gateway A 用に **Create authentication token** を実行し、**Run** 権限を付与します。OCTG クライアントキーとは分離して保管してください。
7. **Provider Keys** → **Add API Key** を開き、以下を設定します。
   - Provider: `octg`
   - Alias: `default`
   - API Key: 既存の `octg_sk_*` クライアントキー

クライアントからのリクエストパスは `/custom-octg/v1/chat/completions` です。Custom Provider の Base URL には `/v1` やエンドポイントのパスを含めないでください。

## OCTG 側の確認事項

- `OCTG_UPSTREAM_BASE_URL` が Gateway B を指し、`/openai` で終わっていること。
- `OCTG_UPSTREAM_API_TOKEN` が Gateway B の **AI Gateway Run token** であること。
- `OCTG_UPSTREAM_API_TOKEN` が Gateway B へ `cf-aig-authorization: Bearer <token>` として送信されること。
- Gateway B の OpenAI provider key が BYOK であり、Worker が OpenAI キーを**送信しない**こと。
- クライアントキーが D1 に `key_hash` として存在すること。

> **注意:** Gateway B への outbound リクエストには `cf-aig-authorization` ヘッダーで Run token を送信します。`Authorization` ヘッダーは OCTG クライアント認証（Gateway A 経由の受信リクエスト）にのみ使用されます。Worker 側では `cf-aig-collect-log-payload: false` を既定で付与し、prompt や response を Gateway B に記録させません。

## 動作確認

### 非ストリーミング

```bash
curl https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_a_id}/custom-octg/v1/chat/completions \
  -H "Authorization: Bearer <OCTG client key>" \
  -H "cf-aig-authorization: Bearer <Gateway A Run token>" \
  -H "cf-aig-collect-log-payload: false" \
  -H "cf-aig-skip-cache: true" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.6-luna",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### ストリーミング

```bash
curl -N https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_a_id}/custom-octg/v1/chat/completions \
  -H "Authorization: Bearer <OCTG client key>" \
  -H "cf-aig-authorization: Bearer <Gateway A Run token>" \
  -H "cf-aig-collect-log-payload: false" \
  -H "cf-aig-skip-cache: true" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.6-luna",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

### 確認ポイント

- Gateway A のログにリクエストが記録されること（metadata のみ）。
- OCTG の `/quota` で該当 pool のクォータが消費されていること。
- Gateway B のログに OpenAI への outbound 呼び出しが記録されること。
- OpenAI 互換レスポンスがクライアントへ返ること。
- Gateway A のレスポンスキャッシュが無効化またはバイパスされていること（`cf-aig-skip-cache: true`）。応答ヘッダーの `cf-aig-cache-status` が `HIT` でないことを確認します。

Gateway A へのクライアントリクエストと、Gateway B への Worker リクエストの両方で `cf-aig-collect-log-payload: false` を使用してください。prompt や response を Gateway ログに保存させないでください。`cf-aig-collect-log-payload: true` になっていないことを、Cloudflare Dashboard の AI Gateway ログ画面で「Log payload」列が空欄（または `false`）であることで確認できます。

## トラブルシューティング

### Gateway A で `Invalid provider` が返る

- Base URL は `https://octg-gateway.<subdomain>.workers.dev` とし、`/v1/chat/completions` を含めないでください。
- Provider slug は `octg` とし、リクエストパスに `/custom-octg/` を含めてください。

### OCTG → Gateway B で `Invalid provider` が返る

- `OCTG_UPSTREAM_BASE_URL` は `/openai` で終わっている必要があります。例: `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_b_id}/openai`

### OCTG で 401 Unauthorized が返る

- Gateway A の Provider Key の値が、D1 にハッシュを登録した `octg_sk_*` と完全一致している必要があります。
- Worker の `OCTG_KEY_PEPPER` が、そのクライアントキーのハッシュ生成に使用した pepper と一致している必要があります。

### ルーティングループ

- `OCTG_UPSTREAM_BASE_URL` が Gateway A の `custom-octg` エンドポイントや OCTG Worker 自身を指していないことを確認してください。
- 必ず Gateway A と Gateway B を別インスタンスにしてください。

### レスポンスが返らない / タイムアウトする

- `/quota` で残りクォータを確認してください。
- Gateway A の timeout 設定を確認してください。
- D1 の `requests` テーブルでリクエスト到達を確認してください。
- **Gateway A の retry と冪等性**: Gateway A の retry 試行回数は、重複配送を避けるため `1`（= `cf-aig-max-attempts: 1`）に設定してください。retry を有効化する場合、同じ論理リクエストは同一の `Idempotency-Key` ヘッダーを付ける必要があります。OCTG Worker はその key を QuotaController の client-scoped dedupe 判定と Gateway B への upstream call に変更せず利用し、Durable Object 内（client × pool × UTC day）で重複排除します。key が欠落した場合は新規リクエストとして処理されます。完了済み key の再送は `409 Conflict` で拒否され、reserve / Gateway B 呼び出し / settle の重複実行を防ぎます。保持 TTL は Durable Object の既存ライフサイクルに従います。Worker から Gateway B への outbound に設定する `cf-aig-max-attempts: 2` は inbound 側の retry とは独立です。

### OpenCode / BYOK の Responses ツール履歴

OpenCode を BYOK プラグイン経由で Responses API に接続する場合は、参照先をOCTGが取得できず quota 推定できないため、`store: false` を使用してください。`item_reference`、`previous_response_id`、`conversation` は送信せず、必要なテキスト・`function_call`・`function_call_output`・reasoning 履歴をリクエストへ再送します。

OCTG は、assistant の `output_text`、user/system/developer の `input_text`、文字列または `input_text` の tool output、reasoning の `summary_text` と `encrypted_content` を受理します。画像・音声・ファイル、未知の item/part、参照状態は予約前に拒否します。BYOK プラグインのデプロイ後は、実際のプラグイン／OpenCode バージョンが `store: false` と履歴再送設定を使用していることを確認してください。

### ストリーミングが動作しない

- まず非ストリーミングが動作することを確認してください。
- body に `"stream": true` を含めてください。
- `/chat/completions` では、ストリーミング時に OCTG が `stream_options: { include_usage: true }` を自動追加します。
- `/responses` では、settlement に `response.completed` の `response.usage` を使用します。

## トークンのローテーション

**トークンが漏洩した場合:** 直ちに失効させ、最小権限の新しい Run token を発行し、該当する Secret を更新してデプロイした後、Gateway B への接続を確認します。旧トークンの疎通が失敗するまで待ってから失効させないでください。

**計画的にローテーションする場合:** 最小権限の新しい Run token を発行し、Secret を更新してデプロイし、Gateway B への接続を確認してから旧トークンを失効させます。

Gateway A と Gateway B の Run token は分離して管理してください。複数アカウント構成では、トークンや BYOK credential をアカウント間で混在させないでください。

## ログポリシー

両 Gateway では metadata のみを記録するログ（`cf-aig-collect-log-payload: false`）を既定にしてください。payload の記録が必要な場合は、対象 Gateway、request/response の別、ログ件数上限、アクセス制御、削除手順、外部保存先を含む事前承認を取得してください。

Gateway A/B ごとにログ件数の保存上限と上限到達時の動作を設定してください。動作は `STOP_INSERTING`（新規ログ保存を停止）または `DELETE_OLDEST`（最も古いログを削除して保存を継続）のいずれかとし、上限到達時に payload を metadata-only へ自動切替する前提にはしないでください。prompt・response の独自保存は D1 では行いません。

## 非スコープ（将来拡張候補）

本手順では以下を扱いません。運用で課題が確認された段階で別途検討します。

- Worker 側での AI Gateway 検出ロジック
- 循環ルーティング防止ロジック（コード実装）
- 自動設定スクリプトへの組み込み
- Unified API (`/compat/chat/completions`) 経由の `custom-octg/` prefix 除去処理
