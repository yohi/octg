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

OCTG Worker が Gateway A の Custom Provider エンドポイント（`custom-octg` または OCTG 自身の Worker URL に戻る経路）を upstream として指すと、リクエストが `Gateway A → OCTG → Gateway A → OCTG → ...` と循環するリスクがある。これを避けるため、inbound と outbound で異なる AI Gateway インスタンスを使用する。

なお、同一 Gateway ID の `/openai` provider-native endpoint は OpenAI への単純な転送経路であり、Gateway A → OCTG → Gateway A `/openai` → OpenAI という経路では循環しない。Gateway 分離の主な目的は、inbound 側と outbound 側のログ・キー・ポリシーを分離し、運用境界を明確にすることにある。

Gateway A と Gateway B を別の Gateway として作成しても、それ自体は認可境界ではない。AI Gateway の Run token はアカウント単位の権限であり、同一 Cloudflare アカウント内の他 Gateway や登録済み BYOK credential にアクセスできる範囲を持ち得る。そのため、強い認可境界が必要な場合は Gateway A と Gateway B を別 Cloudflare アカウントに配置するか、Worker 側の AI Gateway binding を使用して outbound 経路を Worker に束縛する。Run token が漏洩した場合の影響範囲（同一アカウント内の Gateway 実行、ログ・BYOK credential の利用可能範囲）は発行時に確認し、Gateway A/B ごとに別トークンとして管理する。

Run token の漏洩時は、影響を受けるアカウント内の Gateway、BYOK credential、ログを確認し、該当 token を直ちに失効させる。その後、新しい最小権限の Run token を発行して Secret を更新し、デプロイ後に Gateway B の疎通を確認する。漏洩時は可用性より不正利用の阻止を優先し、旧 token の疎通確認後失効は行わない。

計画ローテーション時は、新しい最小権限の Run token を発行して Secret を更新し、デプロイ後に Gateway B の疎通を確認してから旧 token を失効させる。別アカウント構成では、各アカウントの token と BYOK credential を混在させない。

## 5. 通信契約

### 5.1 Client → Gateway A

```text
POST https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_a_id}/custom-octg/v1/chat/completions
Authorization: Bearer <OCTG client key>
cf-aig-authorization: Bearer <Gateway A Run token>
Content-Type: application/json

{
  "model": "gpt-5.6-luna",
  "messages": [{"role": "user", "content": "Hello"}]
}
```

- モデル名は素の `gpt-5.6-luna` 形式で指定する。`custom-octg/` prefix は不要。
- `Authorization` ヘッダーには OCTG クライアントキーを指定する。これは OCTG Worker の provider access 用であり、Gateway A の実行認可には使用しない。
- `cf-aig-authorization` ヘッダーには Gateway A の Authenticated Gateway 用 Run token を指定する。Gateway A の Run token は OCTG クライアントキーとは別に発行・配布・ローテーションする。
- Gateway A の Provider Keys に登録した `octg_sk_*` は、AI Gateway から OCTG Worker へ転送される際に `Authorization: Bearer octg_sk_*` として到達する。

### 5.2 Gateway A → OCTG Worker

- Custom Provider の Base URL: `https://octg-gateway.<subdomain>.workers.dev`（末尾に `/v1` を含めない）
- AI Gateway はリクエストパスの `custom-octg/` 以降（`/v1/chat/completions`）を Base URL に連結する。
- その結果、OCTG Worker への実際のリクエストは `/v1/chat/completions` となる。
- `Authorization` ヘッダーには Provider Keys に登録した `octg_sk_*` が `Authorization: Bearer octg_sk_*` として到達する。OCTG Worker はこの値を D1 に登録された `key_hash` と照合する。
- body はそのまま転送される。
- Gateway A は Authenticated Gateway を有効化し、Run permission を持つ token を要求する。Run token は account-wide のため、Gateway A 用と Gateway B 用を同一 token にしない。

### 5.3 OCTG Worker → Gateway B

- `OCTG_UPSTREAM_BASE_URL` に `/openai` が含まれることを確認する。
- 例: `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_b_id}/openai`
- OCTG Worker は `/chat/completions` または `/responses` を連結して呼び出す。
- 認証には `OCTG_UPSTREAM_API_TOKEN` を使用する。
- `OCTG_UPSTREAM_API_TOKEN` は Gateway B 専用の AI Gateway Run token とし、`cf-aig-authorization: Bearer <Gateway B Run token>` として送信する。OCTG client key や Gateway A の Run token を Gateway B の認証に流用しない。

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
6. Gateway の **Settings** で **Authenticated Gateway** を有効化する。
7. **Create authentication token** から Gateway A 用 token を作成し、必要な **Run** permission を付与する。token の scope（対象アカウントと account-wide であること）を記録し、OCTG client key とは別の Secret 管理経路で Gateway A の利用者へ配布する。
8. **Provider Keys** → **Add API Key**:
   - プロバイダー: `octg`
   - alias: `default`
   - API Key: 発行済みの OCTG クライアントキー

### 6.3 OCTG 側の確認事項

- `OCTG_UPSTREAM_BASE_URL` が Gateway B の `/openai` URL であること。
- `OCTG_UPSTREAM_API_TOKEN` が Gateway B の **AI Gateway Run token** であること。
- `OCTG_UPSTREAM_API_TOKEN` は Gateway B への provider-native endpoint 呼び出しで、`cf-aig-authorization: Bearer <token>` として送信される。
- Gateway B 上の OpenAI provider キーは BYOK 登録済みであり、Worker 側からは送信しないこと。
- クライアントキーが D1 に `key_hash` として登録されていること。
- Gateway A の curl では `cf-aig-authorization: Bearer <Gateway A Run token>` を付与し、OCTG client key（`Authorization`）とは別に管理すること。
- Gateway B の Run token は Gateway A と別に発行し、`OCTG_UPSTREAM_API_TOKEN` として Worker Secret に設定すること。AI Gateway token は account-wide で登録済み BYOK key を利用できるため、A/B の token を共有しない。

## 7. 動作確認

### 7.1 非ストリーミング

```bash
curl https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_a_id}/custom-octg/v1/chat/completions \
  -H "Authorization: Bearer <OCTG client key>" \
  -H "cf-aig-authorization: Bearer <Gateway A Run token>" \
  -H "cf-aig-collect-log-payload: false" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.6-luna",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### 7.2 ストリーミング

```bash
curl -N https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_a_id}/custom-octg/v1/chat/completions \
  -H "Authorization: Bearer <OCTG client key>" \
  -H "cf-aig-authorization: Bearer <Gateway A Run token>" \
  -H "cf-aig-collect-log-payload: false" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.6-luna",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

### 7.3 確認ポイント

- Cloudflare AI Gateway のログ収集は Gateway A/B とも metadata を既定の保存対象とし、raw request/response payload は保存しない方針とする。Client → Gateway A の request と OCTG Worker → Gateway B の outbound request の両方に `cf-aig-collect-log-payload: false` を設定し、payload を保存せず metadata のみ記録する。payload を保存する例外は、対象 Gateway、request/response の別、保存期間ではなくログ件数上限、アクセス権、削除方法を事前承認した場合に限る。
- payload を保存する場合の対象は、Gateway A では Client → Gateway A の request/response payload、Gateway B では OCTG → Gateway B および OpenAI outbound の payload とする。アクセス権は Gateway A/B の運用管理者と監査担当者に限定する。削除は各 Gateway の Logs 画面または対応する管理 API から対象ログを特定して実行し、削除結果を監査記録に残す。外部保存する場合は承認済みの暗号化ストレージへ Logpush 等で転送し、保存先の IAM と暗号化鍵へのアクセスも同じ担当者に限定する。ログ 1 件あたりの保存サイズ上限も確認し、上限を超える payload は保存対象にしない。
- Gateway A/B ごとにログ件数の保存上限と上限到達時の動作を設定する。動作は `STOP_INSERTING`（新規ログ保存を停止）または `DELETE_OLDEST`（最も古いログを削除して保存を継続）のいずれかとし、上限到達時に payload を metadata-only へ自動切替する前提にはしない。保持は固定日数ではなくログ件数・プラン上のストレージ制限で管理し、上限、選択した動作、現在の到達状況を定期確認する。prompt・response の独自保存は D1 では行わない。
- AI Gateway A のログにリクエストが記録される。
- OCTG の `/quota` でクォータが消費されている。
- AI Gateway B のログに OpenAI への outbound が記録される。
- OpenAI からのレスポンスがクライアントに返る。
- Gateway A のレスポンスキャッシュを無効化し、同一リクエストがキャッシュから返らず、必ず OCTG Worker と QuotaController を通過することを確認する。Dashboard で無効化できない場合は Client → Gateway A の request に `cf-aig-skip-cache: true` を付与し、response の `cf-aig-cache-status` が `HIT` でないことを確認する。`cf-aig-cache-ttl: 0` は使用しない。

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
- `OCTG_UPSTREAM_BASE_URL` が Gateway A の `custom-octg` エンドポイント、または OCTG Worker 自身へ戻る経路を指している。

**対処**:
- `OCTG_UPSTREAM_BASE_URL` は Gateway B の `/openai` URL（例: `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_b_id}/openai`）を指すようにする。
- 必ず Gateway A と Gateway B は別の AI Gateway インスタンスを使用する。

### 8.5 レスポンスが返らない / タイムアウト

**原因**:
- Gateway A から OCTG への転送に時間がかかっている。
- OCTG の quota reservation でブロックされている。

**対処**:
- `/quota` でクォータ残量を確認する。
- AI Gateway A の timeout 設定を確認する。
- D1 の `requests` テーブルでリクエスト到達を確認する。
- Gateway A の自動 retry はデフォルトで無効化するか、最大試行回数を 1 に設定する。OCTG Worker は delivery ごとに新しい `req_${ulid()}` を生成するため、Gateway A が同じ delivery を再試行すると、重複した reservation・upstream call・settlement が発生し得る。
- retry を有効化する場合は、Client が安定した idempotency key を Gateway A から Worker まで転送する契約を追加し、その key を reservation、Gateway B への upstream call、settlement の重複排除に使用する。retry 間で同じ key が使われ、最初の成功応答または最終状態を再利用することを確認する。現行の `req_${ulid()}` だけではこの end-to-end 冪等性を満たさない。

### 8.6 ストリーミングが動作しない

**原因**:
- AI Gateway A が SSE を正しく転送していない。
- body に `stream: true` が含まれていない。

**対処**:
- まず非ストリーミングで動作確認する。
- `stream: true` を含めて再試行する。
- `/chat/completions` では `stream === true` の場合に限り、upstream へ `stream_options: { include_usage: true }` を付与する。`/responses` にはこのオプションを付与しない。
- `/responses` の streaming usage は `response.completed` イベントに含まれる `response.usage` を利用して settlement する。

## 9. 非スコープ・将来拡張

本設計では以下は扱わない。

- Worker 側での AI Gateway 検出ロジック
- 循環ルーティング防止ロジック
- 自動設定スクリプトへの組み込み
- Unified API (`/compat/chat/completions`) 経由の `custom-octg/` prefix 除去処理

これらは運用で課題が確認された段階で別途検討する。
