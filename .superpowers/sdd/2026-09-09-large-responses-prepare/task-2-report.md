
## Review Fix

宣言超過プロキシ統合テストに `ReadableStream.prototype.cancel` の spy を追加し、body cancellation が exactly once であることを検証しました。

- `npm test -w apps/gateway-worker -- proxy-failures.test.ts request-body.test.ts`: 2 files / 58 tests passed
- `npm run typecheck -w apps/gateway-worker`: passed
