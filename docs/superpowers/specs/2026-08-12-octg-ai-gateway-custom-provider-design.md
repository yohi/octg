# OCTG を Cloudflare AI Gateway の Custom Provider として登録する設計

## 1. 背景と目的

OCTG は OpenAI Data Sharing Program（Tier 3）の無料枠を複数クライアントで共有するための OpenAI 互換 API Gateway である。運用管理を Cloudflare AI Gateway 上で一元化するため、OCTG 自体を AI Gateway の **Custom Provider** として登録し、クライアントから AI Gateway 経由で OCTG に到達できるようにする。

本設計はドキュメント・手順の整備を中心とし、原則としてコード変更は行わない。

## 2. 採用アプローチ

**アプローチ 2: ドキュメント + 検証用 curl 例 + トラブルシューティング節の追加**

- 現行の OCTG Worker は OpenAI 互換エンドポイントを既に提供しているため、Custom Provider としての振る舞いにほぼ対応済みである。
- コード変更を最小化し、OCTG の核となる quota 制御ロジックに影響を与えない。
- まず手順を確立し、運用で課題が出た段階で保護ロジック等の追加実装を検討する。

## 3. 前提条件

- OCTG Worker は既にデプロイ済みであること。
- Gateway B（OCTG → OpenAI 用の AI Gateway）が存在し、`OCTG_UPSTREAM_BASE_URL` が `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_b_id}/openai` で終わっていること。
- Gateway B には OpenAI Project A（Data Sharing ON）の API キーが BYOK 方式で登録されていること。
- 発行済みの OCTG クライアントキー（`octg_sk_*`）が存在すること。
- Gateway B から OpenAI への outbound 認証には、Gateway B の **AI Gateway Run token** を `cf-aig-authorization: Bearer <token>` として使用する。BYOK で登録された OpenAI プロバイダーキーは AI Gateway が `Authorization` ヘッダーとして OpenAI に送信するため、Worker 側から `Authorization` ヘッダーで送信しないこと。

## 4. アーキテクチャ

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

### 4.1 Gateway A と Gateway B を分離する理由

OCTG を同じ AI Gateway 内の Custom Provider として登録しつつ、OCTG の upstream もその同じ Gateway の `/openai` エンドポイントを指すと、リクエストが `Gateway A → OCTG → Gateway A → ...` と循環するリスクがある。これを避けるため、inbound と outbound で異なる AI Gateway インスタンスを使用する。

## 5. 通信契約

### 5.1 Client → Gateway A

```text
POST https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_a_id}/custom-octg/v1/chat/completions
Authorization: Bearer <OCTG client key>
Content-Type: application/json

{
  "model": "gpt-5.6-luna",
  "messages": [{"role": "user", "content": "Hello"}]
}
```

- モデル名は素の `gpt-5.6-luna` 形式で指定する。`custom-octg/` prefix は不要。
- `Authorization` ヘッダーには OCTG クライアントキーを指定する。
- Gateway A の Provider Keys に登録した `octg_sk_*` は、AI Gateway から OCTG Worker へ転送される際に `Authorization: Bearer octg_sk_*` として到達する。

### 5.2 Gateway A → OCTG Worker

- Custom Provider の Base URL: `https://octg-gateway.<subdomain>.workers.dev`（末尾に `/v1` を含めない）
- AI Gateway はリクエストパスの `custom-octg/` 以降（`/v1/chat/completions`）を Base URL に連結する。
- その結果、OCTG Worker への実際のリクエストは `/v1/chat/completions` となる。
- `Authorization` ヘッダーには Provider Keys に登録した `octg_sk_*` が `Authorization: Bearer octg_sk_*` として到達する。OCTG Worker はこの値を D1 に登録された `key_hash` と照合する。
- body はそのまま転送される。

### 5.3 OCTG Worker → Gateway B

- `OCTG_UPSTREAM_BASE_URL` に `/openai` が含まれることを確認する。
- 例: `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_b_id}/openai`
- OCTG Worker は `/chat/completions` または `/responses` を連結して呼び出す。
- 認証には `OCTG_UPSTREAM_API_TOKEN` を使用する。

## 6. 設定手順

### 6.1 Gateway B の確認

1. AI Gateway B の `OCTG_UPSTREAM_BASE_URL` が `/openai` で終わっていることを確認する。
2. OpenAI provider-native endpoint が有効で、OpenAI Project A の API キーが BYOK 登録されていることを確認する。

### 6.2 Gateway A の作成と Custom Provider 設定

1. Cloudflare Dashboard → AI Gateway → Create Gateway。
2. Gateway 名を入力（例: `octg-ingress`）。
3. **Custom Providers** → **Add Custom Provider**。
4. 以下を入力:
   - **Provider Name**: `OCTG`
   - **Provider Slug**: `octg`
   - **Base URL**: `https://octg-gateway.<subdomain>.workers.dev`
   - **Enable**: 有効化
5. **Save**。
6. **Provider Keys** → **Add API Key**:
   - プロバイダー: `octg`
   - alias: `default`
   - API Key: 発行済みの OCTG クライアントキー

### 6.3 OCTG 側の確認事項

- `OCTG_UPSTREAM_BASE_URL` が Gateway B の `/openai` URL であること。
- `OCTG_UPSTREAM_API_TOKEN` が Gateway B の **AI Gateway Run token** であること。
- `OCTG_UPSTREAM_API_TOKEN` は Gateway B への provider-native endpoint 呼び出しで、`cf-aig-authorization: Bearer <token>` として送信される。
- Gateway B 上の OpenAI provider キーは BYOK 登録済みであり、Worker 側からは送信しないこと。
- クライアントキーが D1 に `key_hash` として登録されていること。

## 7. 動作確認

### 7.1 非ストリーミング

```bash
curl https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_a_id}/custom-octg/v1/chat/completions \
  -H "Authorization: Bearer <OCTG client key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.6-luna",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### 7.2 ストリーミング

```bash
curl https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_a_id}/custom-octg/v1/chat/completions \
  -H "Authorization: Bearer <OCTG client key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.6-luna",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

### 7.3 確認ポイント

- AI Gateway A のログにリクエストが記録される。
- OCTG の `/quota` でクォータが消費されている。
- AI Gateway B のログに OpenAI への outbound が記録される。
- OpenAI からのレスポンスがクライアントに返る。

## 8. トラブルシューティング

### 8.1 `Invalid provider`（Gateway A 側）

**原因**:
- Custom Provider の Base URL に `/v1` ではなく `/v1/chat/completions` などのパスが含まれている。
- slug が `octg` ではなく、リクエスト URL の `custom-octg` と一致していない。

**対処**:
- Base URL は `https://octg-gateway.<subdomain>.workers.dev` のみにする。
- Provider Slug は `octg` にし、リクエストパスは `/custom-octg/v1/chat/completions` とする。

### 8.2 `Invalid provider`（OCTG → Gateway B 側）

**原因**:
- `OCTG_UPSTREAM_BASE_URL` の末尾に `/openai` がない。

**対処**:
- `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_b_id}/openai` に修正する。

### 8.3 401 Unauthorized（OCTG 側）

**原因**:
- Gateway A の Provider Key と OCTG D1 に登録された `key_hash` が一致していない。
- `OCTG_KEY_PEPPER` が一致していない。

**対処**:
- Provider Key に登録した値が、発行時の `octg_sk_*` と完全一致することを確認する。
- ローカルや別環境で `OCTG_KEY_PEPPER` が変わっていないか確認する。

### 8.4 循環ルーティング

**原因**:
- Gateway A と Gateway B が同じインスタンス。

**対処**:
- 必ず別の AI Gateway インスタンスを作成する。

### 8.5 レスポンスが返らない / タイムアウト

**原因**:
- Gateway A から OCTG への転送に時間がかかっている。
- OCTG の quota reservation でブロックされている。

**対処**:
- `/quota` でクォータ残量を確認する。
- AI Gateway A の timeout 設定を確認する。
- D1 の `requests` テーブルでリクエスト到達を確認する。

### 8.6 ストリーミングが動作しない

**原因**:
- AI Gateway A が SSE を正しく転送していない。
- body に `stream: true` が含まれていない。

**対処**:
- まず非ストリーミングで動作確認する。
- `stream: true` を含めて再試行する。
- OCTG は `stream === true` の場合、upstream へ `stream_options: { include_usage: true }` を付与する。

## 9. 非スコープ・将来拡張

本設計では以下は扱わない。

- Worker 側での AI Gateway 検出ロジック
- 循環ルーティング防止ロジック
- 自動設定スクリプトへの組み込み
- Unified API (`/compat/chat/completions`) 経由の `custom-octg/` prefix 除去処理

これらは運用で課題が確認された段階で別途検討する。
