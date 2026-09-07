# Cloudflare AI Gateway Custom Provider

[English](./cloudflare-ai-gateway-custom-provider.md)

この文書は [cloudflare-ai-gateway-custom-provider.md](./cloudflare-ai-gateway-custom-provider.md) の日本語版です。英語版を正本とします。

デプロイ済み OCTG Worker を Cloudflare AI Gateway の Custom Provider として登録する場合、推奨構成は ingress の Gateway A と、OCTG が OpenAI へ出ていく Gateway B を分離します。

```text
Client
  |
  v
Cloudflare AI Gateway A
  Custom Provider: OCTG
  |
  v
OCTG Worker
  |
  v
Cloudflare AI Gateway B
  OpenAI provider
  |
  v
OpenAI API
```

Gateway B を Gateway A の `custom-octg` route や OCTG Worker 自身へ向けないでください。

## 前提条件

- OCTG Worker がデプロイ済み
- Gateway B が OCTG → OpenAI 用に設定済み
- `OCTG_UPSTREAM_BASE_URL` が Gateway B の `/openai` endpoint
- `octg_sk_*` client key の hash が D1 に登録済み
- Gateway A / Gateway B の Run token を分離管理

AI Gateway の `AI Gateway Run` permission は account-scoped で、単一の Gateway や BYOK credential に制限できません。同一 Cloudflare account 内の Gateway A / Gateway B で token を分離しても、強い認可境界を保証できません。より強い分離が必要な場合は、別 account または別アーキテクチャを利用してください。

## Gateway A の登録

Custom Provider を次のように登録します。

```text
Provider name: OCTG
Provider slug: octg
Base URL: https://octg-gateway.<subdomain>.workers.dev
```

Base URL に `/v1` は付けません。

Gateway A の authenticated gateway を有効化し、Gateway A 用 Run token を作成します。Custom Provider の provider credential には既存の `octg_sk_*` を登録します。OpenAI key ではありません。

呼び出し path は次の形です。

```text
/custom-octg/v1/chat/completions
/custom-octg/v1/responses
```

## Credential の分離

| Credential | 用途 |
| --- | --- |
| OCTG `octg_sk_*` | Gateway A provider credential / OCTG client auth |
| Gateway A Run token | client → Gateway A |
| Gateway B Run token | OCTG Worker → Gateway B |
| OpenAI project credential | Gateway B provider credential |
| `OCTG_KEY_PEPPER` | OCTG client key hashing |

prompt / response payload を AI Gateway logs に残さない運用では、ingress / outbound の両方で payload collection を無効化してください。

## OpenCode

Responses provider の例は英語正本を参照してください。重要な点は次のとおりです。

- OpenCode の local provider ID と Cloudflare provider slug は別概念
- client は Gateway A Run token を `cf-aig-authorization` に使用
- `octg_sk_*` や OpenAI key を OpenCode config へ埋め込まない
- Responses では `previous_response_id` / `conversation` に依存せず、quota estimation に必要な history を request body へ含める
- `store: false` を利用する場合も、次 request に必要な text/tool/reasoning history を再送する

## 動作確認

```bash
curl https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_a_id}/custom-octg/v1/chat/completions \
  -H "Authorization: Bearer <OCTG client key>" \
  -H "cf-aig-authorization: Bearer <Gateway A Run token>" \
  -H "cf-aig-collect-log-payload: false" \
  -H "cf-aig-skip-cache: true" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.6-luna","messages":[{"role":"user","content":"Hello"}]}'
```

Gateway A / OCTG `/quota` / Gateway B の各観測点で意図した経路になっていることを確認します。

## Retry / Idempotency

OCTG は Gateway B への outbound attempts を 1 に固定します。Ingress 側で retry する構成では `Idempotency-Key` を使い、trusted ingress で retry policy を固定してください。

OCTG の idempotency key は UTF-8 255 bytes 以下です。空値は absent として扱います。

## Troubleshooting

- Gateway A の `Invalid provider`: Worker root を Base URL にし、`/v1` を含めない
- Gateway B の `Invalid provider`: `OCTG_UPSTREAM_BASE_URL` が Gateway B の `/openai` で終わることを確認
- OCTG 401: provider credential と D1 hash / pepper の組み合わせを確認
- routing loop: Gateway B が Gateway A または OCTG Worker 自身を指していないことを確認
- Responses history: stored context reference ではなく、OCTG が estimate できる request-contained history を使用

設定の正本は [configuration.md](./configuration.md) です。
