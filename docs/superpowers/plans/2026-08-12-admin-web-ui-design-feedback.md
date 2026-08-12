# Admin Web UI 設計書フィードバック対応 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** レビュー指摘に基づき、admin API の認証を JWT 一本化し、clients レスポンスに effective policy 値を追加し、設計書に UI 配信方式・CSS 配信方針・認証境界テスト手順を明記する。

**Architecture:** 管理者認証は `verifyAccessJwt` のみに統一し、Service Token 分岐を削除する。clients 一覧は inline 編集に必要な effective policy 値を含めて返す。設計書は Static Assets の実パス対応と Pico.css 配信方針を決定し、運用確認手順を追加する。

**Tech Stack:** TypeScript, Cloudflare Workers, D1, Vitest, `@cloudflare/vitest-pool-workers`

## Global Constraints

- `octg_sk_*` などの認証素材は keyed hash で保存し、生値をコード・ログに残さない。
- 監査ログの D1 書き込みは best-effort。課金判定を監査ログ到達に依存させない。
- authoritative なクォータ制御は Durable Object が担う。D1 は監査・証跡用途のみ。
- 型安全性: `as any`, `@ts-ignore`, `@ts-expect-error` を禁止。
- テスト: 新しい挙動にはテスト先行（TDD）。失敗テストを書いてから実装する。
- コミット: ユーザーが明示的に指示した場合のみ。
- 絶対パスをコミットに含めない。

---

## File Map

- `apps/gateway-worker/src/access.ts` — 認証関数。`verifyAccessJwtOrServiceToken` を削除し JWT 検証のみ残す。
- `apps/gateway-worker/src/admin.ts` — admin API。`verifyAccessJwt` を使うよう変更。`GET /admin/clients` に effective policy 値を追加。
- `apps/gateway-worker/src/index.ts` — Worker エントリ。`Env` から `ACCESS_ALLOWED_SERVICE_TOKEN_IDS` を削除。
- `apps/gateway-worker/test/access.test.ts` — 認証ユニットテスト。Service Token テストを削除。
- `apps/gateway-worker/test/admin-api.test.ts` — admin API 統合テスト。Service Token 認証テストを削除。
- `apps/gateway-worker/test/seed.ts` — テスト用 client シード。clients テストデータにポリシー値を追加する場合はここを拡張。
- `docs/superpowers/specs/2026-08-12-admin-web-ui-design.md` — 設計書。UI 配信方式、Pico.css 配信方針、認証境界テスト手順を更新。

---

### Task 1: 認証を JWT 一本化

**Files:**
- Modify: `apps/gateway-worker/src/access.ts:17-33`
- Modify: `apps/gateway-worker/src/admin.ts:3, :36`
- Modify: `apps/gateway-worker/src/index.ts:20`
- Test: `apps/gateway-worker/test/access.test.ts`
- Test: `apps/gateway-worker/test/admin-api.test.ts`

**Interfaces:**
- Consumes: `verifyAccessJwt(request, env, requestId)` from `access.ts`
- Produces: `verifyAccessJwtOrServiceToken` は削除。`Env` から `ACCESS_ALLOWED_SERVICE_TOKEN_IDS` 削除。

- [ ] **Step 1: 既存テストを実行し baseline を確認する**

Run: `npm test`
Expected: 全テストが現状通過（Service Token 分岐あり）

- [ ] **Step 2: `access.ts` から `verifyAccessJwtOrServiceToken` を削除する**

`apps/gateway-worker/src/access.ts`:
```typescript
export async function verifyAccessJwt(request: Request, env: Env, requestId: string): Promise<true | OctgHttpError> {
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return errInvalidApiKey(requestId);
  try {
    const jwks = env.ACCESS_JWT_PUBLIC_JWK ? createLocalJWKSet(JSON.parse(env.ACCESS_JWT_PUBLIC_JWK)) : createRemoteJWKSet(new URL(`${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`));
    await jwtVerify(token, jwks, { audience: env.ACCESS_AUD, issuer: env.ACCESS_TEAM_DOMAIN });
    return true;
  } catch {
    return errInvalidApiKey(requestId);
  }
}
```

`verifyAccessJwtOrServiceToken` 関数を丸ごと削除する。

- [ ] **Step 3: `admin.ts` を `verifyAccessJwt` を使うように変更する**

`apps/gateway-worker/src/admin.ts`:
```typescript
import { verifyAccessJwt } from "./access";
```

```typescript
const verified = await verifyAccessJwt(request, env, requestId); if (verified !== true) return errorResponse(verified);
```

- [ ] **Step 4: `index.ts` の `Env` から `ACCESS_ALLOWED_SERVICE_TOKEN_IDS` を削除する**

`apps/gateway-worker/src/index.ts`:
```typescript
export interface Env {
  // ... existing fields ...
  readonly ACCESS_JWT_PUBLIC_JWK?: string;
  // ACCESS_ALLOWED_SERVICE_TOKEN_IDS は削除
}
```

- [ ] **Step 5: `wrangler.jsonc` から `ACCESS_ALLOWED_SERVICE_TOKEN_IDS` を削除する**

`apps/gateway-worker/wrangler.jsonc` の `vars` セクションから削除する。

- [ ] **Step 6: テストを更新する**

`apps/gateway-worker/test/access.test.ts`:
- `describe("verifyAccessJwtOrServiceToken", ...)` 全体を削除する。

`apps/gateway-worker/test/admin-api.test.ts`:
- "accepts a valid Service Token client id" テストを削除する。
- "rejects an unknown Service Token client id" テストを削除する。
- `admin()` ヘルパーから `authenticated: "service"` 分岐を削除する。
- "allows client policy writes with a Service Token" テストを JWT 認証に変更するか削除する。
- "keeps client policy and model writes behind the guard" テストは JWT なしのまま 401 を確認するので変更なし。

- [ ] **Step 7: テストを実行する**

Run: `npm test`
Expected: 全テスト通過

Run: `npm run typecheck`
Expected: 全ワークスペースで型検査通過

- [ ] **Step 8: コミットする**

```bash
git add apps/gateway-worker/src/access.ts apps/gateway-worker/src/admin.ts apps/gateway-worker/src/index.ts apps/gateway-worker/wrangler.jsonc apps/gateway-worker/test/access.test.ts apps/gateway-worker/test/admin-api.test.ts
git commit -m "refactor(gateway-worker): admin API 認証を Access JWT のみに統一"
```

---

### Task 2: clients レスポンスに effective policy 値を追加

**Files:**
- Modify: `apps/gateway-worker/src/admin.ts:36-37`
- Modify: `apps/gateway-worker/test/admin-api.test.ts`
- Test: `apps/gateway-worker/test/admin-api.test.ts`

**Interfaces:**
- Consumes: D1 `clients` テーブルと `client_policies` テーブル
- Produces: `GET /admin/clients` レスポンスに `overflow_mode`, `output_limit_mode`, `max_paid_usd_day`, `cache_enabled` を追加。未設定時は effective デフォルト値を返す。

- [ ] **Step 1: 失敗するテストを書く**

`apps/gateway-worker/test/admin-api.test.ts` に以下を追加する：

```typescript
it("returns effective client policy values in the list", async () => {
  await admin(`/admin/clients/${TEST_CLIENT_ID}/policy`, { method: "PUT", body: JSON.stringify({ overflow_mode: "PAID_SHARED", output_limit_mode: "CLAMP", max_paid_usd_day: 10, cache_enabled: true }) }, "jwt");
  const response = await admin("/admin/clients", undefined, "jwt");
  expect(response.status).toBe(200);
  const body = await response.json<{ clients: Array<{ id: string; overflow_mode: string; output_limit_mode: string; max_paid_usd_day: number; cache_enabled: boolean }> }>();
  const client = body.clients.find((c) => c.id === TEST_CLIENT_ID);
  expect(client).toMatchObject({ overflow_mode: "PAID_SHARED", output_limit_mode: "CLAMP", max_paid_usd_day: 10, cache_enabled: true });
});

it("returns default policy values for clients without a configured policy", async () => {
  const response = await admin("/admin/clients", undefined, "jwt");
  expect(response.status).toBe(200);
  const body = await response.json<{ clients: Array<{ id: string; overflow_mode: string; output_limit_mode: string; max_paid_usd_day: number; cache_enabled: boolean }> }>();
  const client = body.clients.find((c) => c.id === TEST_CLIENT_ID);
  expect(client).toMatchObject({ overflow_mode: "REJECT", output_limit_mode: "REJECT", max_paid_usd_day: 0, cache_enabled: false });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npm test -- apps/gateway-worker/test/admin-api.test.ts`
Expected: 追加したテストが FAIL（レスポンスに policy 値がない）

- [ ] **Step 3: `GET /admin/clients` に effective policy 値を追加する**

`apps/gateway-worker/src/admin.ts`:

```typescript
type ClientListRow = { id: string; name: string; enabled: number; created_at: string; overflow_mode: string | null; output_limit_mode: string | null; max_paid_usd_day: number | null; cache_enabled: number | null };

const DEFAULT_CLIENT_POLICY = { overflow_mode: "REJECT", output_limit_mode: "REJECT", max_paid_usd_day: 0, cache_enabled: false } as const;

function effectiveClientPolicy(row: { overflow_mode: string | null; output_limit_mode: string | null; max_paid_usd_day: number | null; cache_enabled: number | null }): { overflow_mode: "REJECT" | "PAID_SHARED"; output_limit_mode: "REJECT" | "CLAMP"; max_paid_usd_day: number; cache_enabled: boolean } {
  const overflow_mode = row.overflow_mode === "PAID_SHARED" ? "PAID_SHARED" : "REJECT";
  const output_limit_mode = row.output_limit_mode === "CLAMP" ? "CLAMP" : "REJECT";
  const max_paid_usd_day = typeof row.max_paid_usd_day === "number" && Number.isFinite(row.max_paid_usd_day) && row.max_paid_usd_day >= 0 ? row.max_paid_usd_day : 0;
  const cache_enabled = row.cache_enabled === 1 ? true : row.cache_enabled === 0 ? false : DEFAULT_CLIENT_POLICY.cache_enabled;
  return { overflow_mode, output_limit_mode, max_paid_usd_day, cache_enabled };
}
```

`GET /admin/clients` ハンドラ:

```typescript
if (request.method === "GET" && url.pathname === "/admin/clients") {
  const rows = await env.DB.prepare(`
    SELECT
      c.id, c.name, c.enabled, c.created_at,
      p.overflow_mode, p.output_limit_mode, p.max_paid_usd_day, p.cache_enabled
    FROM clients c
    LEFT JOIN client_policies p ON c.id = p.client_id
    ORDER BY c.id
  `).all<ClientListRow>();
  const clients = rows.results.map((row) => ({
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    created_at: row.created_at,
    ...effectiveClientPolicy(row),
  }));
  return json({ request_id: requestId, clients });
}
```

- [ ] **Step 4: テストが通過することを確認する**

Run: `npm test -- apps/gateway-worker/test/admin-api.test.ts`
Expected: 全テスト通過

Run: `npm test`
Expected: 全テスト通過

Run: `npm run typecheck`
Expected: 全ワークスペースで型検査通過

- [ ] **Step 5: コミットする**

```bash
git add apps/gateway-worker/src/admin.ts apps/gateway-worker/test/admin-api.test.ts
git commit -m "feat(gateway-worker): admin clients 一覧に effective policy 値を追加"
```

---

### Task 3: 設計書を更新

**Files:**
- Modify: `docs/superpowers/specs/2026-08-12-admin-web-ui-design.md`

**Interfaces:**
- 設計書の手順・方式を明記する。実装コードとの整合性を保つ。

- [ ] **Step 1: `/admin/ui/*` と `public/*` の対応方式を決定し明記する**

採用方式: `public/admin/ui/...` に配置する方式。

理由:
- Workers Static Assets は `directory: "./public"` をルートとして配信する。
- `/admin/ui/*` を `public/admin/ui/*` に配置することで、`assets.not_found_handling = "none"` としても自然にマッピングされる。
- `assets.run_worker_first` と fetch handler での pathname 書き換えは、Cloudflare Workers Static Assets の挙動に依存し、現状では `public/admin/ui/...` 配置の方が実装が単純で予測可能。

設計書の「配信パスとルーティング」セクションを以下のように更新する：

```markdown
## 配信パスとルーティング

採用方式: `public/admin/ui/...` に配置する方式。

| パス | 実ファイル | 処理 |
|---|---|---|
| `/admin/ui` | `public/admin/ui/index.html` | Workers Static Assets が `html_handling: "auto-trailing-slash"` で `/admin/ui/` にリダイレクトし、index.html を返す |
| `/admin/ui/` | `public/admin/ui/index.html` | 同上 |
| `/admin/ui/app.js` | `public/admin/ui/app.js` | Static Assets によりそのまま配信 |
| `/admin/ui/styles.css` | `public/admin/ui/styles.css` | Static Assets によりそのまま配信 |
| `/admin/*` | — | 既存 `handleAdmin` による JSON API |

HTML 内で CSS/JS を読み込む際は、絶対パス `/admin/ui/app.js` および `/admin/ui/styles.css` を使用する。
```

- [ ] **Step 2: Pico.css 配信方針を具体化する**

採用方式: `public/admin/ui/pico.min.css` に同梱して Static Assets から配信する。

理由:
- CSP 設定を簡潔にできる。
- CDN 障害時の運用リスクを回避できる。
- SRI 計算・固定バージョン管理が不要になる。

設計書の「技術スタック」セクションを以下のように更新する：

```markdown
| 技術スタック | バニラ HTML/CSS/JS + Pico.css（`public/admin/ui/pico.min.css` 同梱） | 依存追加なし、ビルド不要、軽量、CDN 障害リスクなし |
```

セキュリティセクションに追加：
```markdown
- Pico.css は `public/admin/ui/pico.min.css` として同梱し、同一ドメインから配信する。
```

- [ ] **Step 3: 認証境界テスト手順を追加する**

「テスト・動作確認」セクションの「ローカル確認手順」と「本番確認手順」に追加：

```markdown
### Static Assets の認証境界テスト

1. 未認証状態で以下にアクセスし、200 以外の Cloudflare Access リダイレクトまたは拒否となることを確認:
   - `/admin/ui`
   - `/admin/ui/`
   - `/admin/ui/app.js`
   - `/admin/ui/styles.css`
2. Cloudflare Access 認証済みセッションで以下を取得できることを確認:
   - HTML (`/admin/ui/`)
   - CSS (`/admin/ui/styles.css`)
   - JavaScript (`/admin/ui/app.js`)
3. セッション失効後の API 呼び出し（`fetch /admin/quota` など）で UI が再読み込みし、Cloudflare Access のログイン画面に案内されることを確認。
4. Cloudflare Access の保護対象パスに `/admin/ui/*` が含まれていることを確認。
```

- [ ] **Step 4: 設計書の編集後、自己レビューする**

以下を確認する：
- TBD/TODO/曖昧な表現が残っていないか
- 実ファイルパスと Static Assets 設定との整合性
- API 側の変更（Task 1, Task 2）と設計書の Clients 編集フィールド定義の整合性
- 認証境界テスト手順が具体的か

- [ ] **Step 5: コミットする**

```bash
git add docs/superpowers/specs/2026-08-12-admin-web-ui-design.md
git commit -m "docs: Admin Web UI 設計書に配信方式、Pico.css 配信方針、認証境界テストを明記"
```

---

## Skipped Items with Reason

- **Client ID + Client Secret → Cloudflare Access JWT assertion 統合テスト**: テスト環境で Cloudflare Access Service Token エンドポイントに実際にリクエストする必要があり、テストの再現性・外部依存を避けるため対応しない。代わりに既存のローカル JWK 署名検証テストで JWT 検証をカバーする。
- **`wrangler.jsonc` の `workers_dev` 無効化**: ローカル開発時（`npm run dev`）に `workers_dev = true` が必要なため、現状では無効化しない。本番カスタムドメイン運用時は環境別設定で上書きする。

---

## Verification

- `npm test` 全テスト通過
- `npm run typecheck` 全ワークスペースで型検査通過
- 設計書の更新内容が指摘事項を網羅していること（レビュー指摘との対応表を作成して確認）
