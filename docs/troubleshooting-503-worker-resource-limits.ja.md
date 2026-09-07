# 503 / Cloudflare Error 1102 インシデント記録

[English](./troubleshooting-503-worker-resource-limits.md)

この文書は 2026-08-16 に観測された OCTG Worker resource-limit incident の日本語記録です。現在の request architecture の正本ではありません。

現在の technical contract は [../SPEC.md](../SPEC.md)、運用手順は [operations.md](./operations.md) を参照してください。

## 観測事実

2026-08-16 02:16:29〜02:16:47 JST に、Cloudflare AI Gateway Custom Provider 経由の大規模 `/v1/responses` request で HTTP 200 と HTTP 503 が混在しました。

成功 request は約 74,000 input-token 級でした。503 は OCTG の通常の structured error ではなく、Cloudflare `Worker exceeded resource limits` / Error 1102 の HTML response でした。

この証拠から Worker resource limit 到達は確認できますが、CPU / memory のどちらが原因かは単独では確定できません。

調査のために request payload、authentication material、tokenizer input text をログへ追加しないでください。

## 必要な照合証拠

- Worker deployment/version ID
- 対応する commit/revision
- 実効 resource limits
- Cloudflare invocation outcome
- CPU time / wall time
- concurrency
- OCTG request ID
- resource-stage telemetry
- tokenization provider / measured input bytes
- quota reserve 到達有無
- upstream 到達有無

現在の default 値や別 deployment の値から事故時の実効 limit を推定しません。

## 現行 request path

事故時 baseline から実装は変化しています。

```text
authenticate
  -> body read / parse
  -> normalize
  -> model / policy
  -> quota state
  -> tokenization routing
       small or Deno disabled -> TokenizerController DO
       large and Deno enabled -> Deno tokenizer
  -> token budget
  -> quota reserve
  -> in-flight admission
  -> upstream
  -> settle / uncertain / release
```

現在の事故調査では、すべて `TokenizerController` と仮定せず、実際の `tokenizationProvider` を確認します。

## Triage

1. response が OCTG JSON か Cloudflare HTML か確認
2. timestamp / hostname を記録
3. 取得可能なら `X-OCTG-Request-Id` / Worker version を記録
4. matching Worker invocation を特定
5. body size / tokenization provider を照合
6. 最後に完了した resource stage を特定
7. request ID の reservation state を確認
8. upstream 到達可能性があれば fail-closed uncertainty を維持
9. 同じ Worker version の成功 / 失敗 request で CPU / wall-time evidence を比較
10. 再現は synthetic payload と明示的 safety limit で行う

## Quota safety

client が 503 / timeout / disconnect を見たことだけでは upstream usage が 0 とは証明できません。

canonical QuotaController state と reconciliation evidence を使用してください。`reserve_unknown` は [operations.md](./operations.md) の explicit operator reconciliation path で扱います。

## Tokenizer offload の acceptance

- threshold 未満は `TokenizerController`
- threshold 以上は Deno enabled 時に Deno
- Deno failure は fail-closed
- tokenization success 前に quota reserve しない
- representative synthetic large input が resource acceptance target を満たす
- payload / secret をログしない
- settlement / uncertainty accounting が維持される

2026-08-16 の観測事実は historical evidence として保持し、当時 Deno routing が存在したかのように書き換えません。
