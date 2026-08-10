# OCTG — OpenAI Complimentary Token Gateway

OpenAI Data Sharing Program (Tier 3) の無料枠を複数クライアントで共有するための OpenAI 互換 API Gateway。
設計: `docs/superpowers/specs/2026-08-09-octg-mvp-design.md` / 計画: `docs/superpowers/plans/2026-08-09-octg-mvp-implementation.md`。

## 開発

```bash
npm install
npm test            # 全ワークスペース (Vitest + @cloudflare/vitest-pool-workers)
npm run typecheck
npm run dev -w apps/gateway-worker
```

ローカル用クライアント発行:

```bash
cd apps/gateway-worker
printf 'OCTG_KEY_PEPPER=dev-pepper\n' > .dev.vars
node ../../scripts/seed-client.mjs client_demo Demo octg_sk_xxx > /tmp/octg-seed.sql
npx wrangler d1 execute octg --local --file /tmp/octg-seed.sql
```

## デプロイ前の必須プロビジョニング（手動）

1. `wrangler d1 create octg` → 発行された `database_id` を `apps/gateway-worker/wrangler.jsonc` に設定する。
2. AI Gateway を作成し、OpenAI Project A（shared-free, Data Sharing ON）の API キーを **BYOK + Secrets Store** に登録する。OCTG のコード・クライアントには OpenAI キーを配布しない。
3. AI Gateway の Spend Limit を無料枠と同額に設定する（二次防御。authoritative ではない）。
4. `wrangler.jsonc` の vars を実値に差し替える: `OCTG_UPSTREAM_BASE_URL`（アカウント ID 込み）、`ACCESS_TEAM_DOMAIN` / `ACCESS_AUD`（Admin API 用 Cloudflare Access アプリケーション）。
5. Secrets を設定する:
   - `npx wrangler secret put OCTG_KEY_PEPPER --config apps/gateway-worker/wrangler.jsonc` — クライアントキーの keyed hash 用 pepper
   - `npx wrangler secret put OCTG_UPSTREAM_API_TOKEN --config apps/gateway-worker/wrangler.jsonc` — AI Gateway REST 用 Cloudflare API token（AI Gateway Run 権限）
   - `npx wrangler secret put OPENAI_USAGE_API_KEY --config apps/gateway-worker/wrangler.jsonc` — OpenAI Organization Usage API 読み取り用 admin key
6. `npx wrangler d1 migrations apply octg --remote --config apps/gateway-worker/wrangler.jsonc` で remote D1 migration を適用する。
7. `npx wrangler deploy --config apps/gateway-worker/wrangler.jsonc`（CI からのデプロイを推奨）。

## Secret ローテーション

各 Secret は (1) 新規トークン発行 → (2) `wrangler secret put` で設定 → (3) デプロイ / 動作確認 → (4) 旧トークン失効、の順で実施する。Worker コード・ログ・`octg_sk_*` の鍵素材に Secret の値を含めない。

`OCTG_KEY_PEPPER` の変更は通常の Secret ローテーションと分離して扱う。旧 pepper との併用期間を設けて段階的に全キーを再発行するか、全クライアントの `key_hash` を新 pepper で移行してから旧 pepper を無効化する。単純な即時変更は既存キーを無効化するため避ける。

## 既知の限界

課金 0 円の完全保証はしない。conservative reservation + fail-closed + OpenAI reconciliation の三重防御（設計書 §15）。監査ログは best-effort で配送欠損を許容する（authoritative な制御は DO が担う）。

## 今回のレビューで未対応とした項目

`handleAdmin` のルート別 handler への分割は、今回の修正では実施していない。これは機能不具合ではなく構造改善であり、JWT 検証、入力検証、エラー境界、reconciliation の挙動修正とは独立しているため、変更範囲と回帰リスクを抑える目的で保留した。
