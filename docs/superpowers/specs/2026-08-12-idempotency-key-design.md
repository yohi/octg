# Idempotency-Key による end-to-end 冪等性設計

**作成日:** 2026-08-12
**対象:** OCTG Cloudflare AI Gateway Custom Provider 構成
**目標:** Gateway A からの retry による reservation / upstream call / settlement の重複を防ぐ

## 背景

- `apps/gateway-worker/src/proxy.ts` は delivery ごとに `req_${ulid()}` を生成する
- Gateway A が retry すると、同じ論理リクエストでも Worker 側では別の `request_id` として到達する
- その結果、reservation / Gateway B への upstream call / settlement が重複する可能性がある
- `docs/cloudflare-ai-gateway-custom-provider.md` では `cf-aig-max-attempts: 1` の推奨を既に明記している
- 指摘は「retry を有効化する場合の冪等契約」を追加すること

## 設計

### 基本方針

- Worker は Gateway A から送信された `Idempotency-Key` ヘッダーを受信する
- client × pool × UTC day の同一 key に対して Durable Object 内で reserve / settle を各 1 回に制限する
- Worker は同じ key を Gateway B への upstream call でも転送する
- key がない場合は従来通り `req_${ulid()}` で新規処理する

### Dedupe スコープ

- `Idempotency-Key` の重複排除は Durable Object 内（client × pool × UTC day）で行う
- 同一 key が別 pool / 別日に到達した場合は別リクエストとして扱う
- 同一 key が同じ scope 内で再送された場合のみ duplicate として扱う

### 再送時のレスポンス

- **全リクエスト:** レスポンス body は保存・再生しない。既存 entry が `reserved`・`uncertain`・`settled`・`reconciled` の再送は `409 Conflict` を返し、Gateway A の retry を停止させる
- `released` entry の key は新しい予約として再利用する
- いずれの場合も quota の二重消費は発生しない

### 保持 TTL

- Durable Object の既存ライフサイクルに従い、当該 UTC 日の翌々日 00:00 UTC まで保持する
- 既存の `finalizeDay()` / `deleteAll()` 手順で削除する

## 影響ファイル

- `durable-objects/quota-controller/src/quota-controller.ts`
  - RPC インターフェースに `idempotencyKey` パラメータを追加
  - `idempotencyKey` があればそれを重複排除キーとして使用する
  - 既存の `requestId` ベースの重複排除は維持する
- `durable-objects/quota-controller/src/store.ts`
  - `idempotencyKey` から `requestId` へのマップを保存するためのキー/値を追加
- `durable-objects/quota-controller/src/quota-lifecycle.ts`
  - settle / markUncertain / release / reconcile で `idempotencyKey` マップを維持する
- `apps/gateway-worker/src/proxy.ts`
  - `Idempotency-Key` ヘッダーを読み取る
  - `requestId` と `idempotencyKey` を分離して扱う
  - 再送時のレスポンス制御を追加
- `apps/gateway-worker/src/upstream.ts`
  - Gateway B へ `Idempotency-Key` ヘッダーを転送する
- `apps/gateway-worker/test/proxy.test.ts`
  - 同一 key の再送で reserve と settle が各 1 回だけ実行される integration test を追加
  - Gateway B に同じ key が渡ることを確認する test を追加
- `docs/cloudflare-ai-gateway-custom-provider.md`
  - retry 冪等性契約を明記
- `SPEC.md`
  - 必要に応じて QuotaController / Worker 設計を更新

## 実装計画

別途 `docs/superpowers/plans/2026-08-12-idempotency-key.md` に記載する。
