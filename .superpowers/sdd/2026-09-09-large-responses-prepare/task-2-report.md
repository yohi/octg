# Task 2 Report

## Status

完了。Stage 1 の `readJsonBody` 呼び出し元互換性をテストで確認しました。プロダクションコードの変更はありません。

## Changes

- `apps/gateway-worker/test/proxy-failures.test.ts`
  - 宣言された Content-Length が 1 MiB を超えるリクエストが 413 と `request_too_large` を返すことを追加検証。
  - body cancellation が exactly once であることを検証。
  - tokenizer、quota、upstream が呼び出されないことを検証。
- `apps/gateway-worker/test/admin-api.test.ts`
  - 宣言された Content-Length が入力範囲内の有効 JSON を Admin policy API が受理することを検証。
  - 同条件の不正 JSON が 400 `invalid_request` になることを検証。

既存の `apps/gateway-worker/test/request-body.test.ts` により、宣言超過時の reader 単体のキャンセルと結果 metrics は既にカバーされているため、追加変更は不要でした。

## Verification

- `npm test -w apps/gateway-worker -- proxy-failures.test.ts request-body.test.ts admin-api.test.ts`
  - 3 files / 85 tests passed
- `npm test -w apps/gateway-worker -- proxy-failures.test.ts request-body.test.ts`
  - 2 files / 58 tests passed
- `npm run typecheck -w apps/gateway-worker`
  - passed
- `git diff --check`
  - passed

## Commits

- `8e1304d test(gateway-worker): verify request body caller compatibility`
- `af7647e test(gateway-worker): assert oversized body cancellation`
