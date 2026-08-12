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
- reservation の重複を避けるため、Gateway A の retry を無効化するか、1 回に制限してください。OCTG は delivery ごとに新しい `req_${ulid()}` を生成します。

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
