# Admin Web UI Implementation Plan

<!-- markdownlint-disable MD013 MD032 -->

> **Execution mode:** This plan must be implemented inline by one engineer.
> Do not dispatch or use subagents. Track every step with the checkboxes below.

**Goal:** Cloudflare Access で保護された `/admin/ui/` から、Admin API の
quota、usage、clients、models を参照・編集できる単一ページの管理画面を提供する。

**Architecture:** Workers Static Assets は `/admin/*` を Worker-first で処理し、
`handleAdmin` と同じ Access JWT 検証を通過した UI リクエストだけを
`env.ASSETS.fetch()` に渡す。UI は依存なしの ES modules と同梱 Pico.css で構成し、
API JSON を `textContent` だけでレンダリングする。状態変更 API は有効な Access JWT
に加え、存在する `Origin` が要求 URL の origin と一致する場合にだけ受け入れる。

**Tech Stack:** TypeScript strict、Cloudflare Workers Static Assets、D1、
Vanilla HTML/CSS/JavaScript、Pico.css 2.1.1、Vitest +
`@cloudflare/vitest-pool-workers`、Wrangler 4。

## Global Constraints

- authoritative な quota 制御は Durable Object のままとし、D1 を課金判定に使わない。
- `octg_sk_*`、Service Token、秘密鍵、Access JWT を静的資産・UI・ログへ置かない。
- UI と `/admin/*` は同一 Cloudflare Access application と同一 `ACCESS_AUD` を使う。
- Static Assets は `assets.directory: "./public"`、`binding: "ASSETS"`、
  `html_handling: "auto-trailing-slash"`、`not_found_handling: "none"` とする。
- `run_worker_first` は `"/admin/*"` のみとし、Worker は UI の JWT 検証後だけ
  `env.ASSETS.fetch(request)` を呼ぶ。認証前の asset fallback を作らない。
- API の Clients policy は `tools_mode` を必須とする。UI でも
  `REJECT` / `ALLOW` を表示・編集し、PUT payload から省略しない。
- `Origin` がある状態変更 request は `new URL(request.url).origin` と完全一致が必須。
  `Origin` がない既存の非ブラウザ管理 CLI は互換性のため許可する。
- `as any`、`@ts-ignore`、`@ts-expect-error`、non-null assertion を追加しない。
- UI は外部 CDN を使用せず、Pico.css 2.1.1 のライセンスヘッダーを保持して同梱する。
- E2E 自動テストは今回追加しない。Worker 統合テストと実ブラウザの手動 QA を行う。
- Git 操作（commit、stack の初期化・追加、push、PR 作成・submit、merge を含む）は、ユーザーの明示的な承認なしには実行しない。実装・検証が完了しても、`gh stack submit`、push、PR 作成、merge の直前には停止し、人間による明示的な承認・ハンドオフを受けてから実行する。PR merge は人間が bottom-to-top で行う。
- 以下の `git add` / `git commit` ブロックは実行例であり、各ブロックの直前に人間の明示的な承認を取得する。承認がなければコマンドを実行せず、ハンドオフする。

## File Map

| File | Responsibility | Action |
| --- | --- | --- |
| `apps/gateway-worker/wrangler.jsonc` | assets binding と admin Worker-first routing | Modify |
| `apps/gateway-worker/src/index.ts` | `ASSETS: Fetcher` を含む `Env` と UI route dispatch | Modify |
| `apps/gateway-worker/src/admin.ts` | state-changing Admin API の Origin guard | Modify |
| `packages/shared/src/errors.ts` | 403 `origin_not_allowed` response factory | Modify |
| `packages/shared/test/errors.test.ts` | forbidden-origin error contract | Modify |
| `apps/gateway-worker/vitest.config.ts` | test-only static assets binding | Modify |
| `apps/gateway-worker/test/admin-api.test.ts` | cross-origin rejection と no mutation regression | Modify |
| `apps/gateway-worker/test/admin-ui.test.ts` | JWT-protected static UI route integration | Create |
| `apps/gateway-worker/public/admin/ui/index.html` | semantic dashboard shell | Create |
| `apps/gateway-worker/public/admin/ui/pico.min.css` | Pico.css 2.1.1 vendored stylesheet | Create |
| `apps/gateway-worker/public/admin/ui/styles.css` | dashboard layout and edit-state styles | Create |
| `apps/gateway-worker/public/admin/ui/api.js` | same-origin API client and typed response checks | Create |
| `apps/gateway-worker/public/admin/ui/render.js` | safe DOM renderers for all four sections | Create |
| `apps/gateway-worker/public/admin/ui/editors.js` | client/model inline edit forms and client validation | Create |
| `apps/gateway-worker/public/admin/ui/app.js` | bootstrap, refresh, retry, and edit orchestration | Create |
| `SPEC.md` | shipped UI route/security contract | Modify |
| `README.md` | local verification and Access deployment requirements | Modify |
| `docs/superpowers/specs/2026-08-12-admin-web-ui-design.md` | correct Clients fields to include `tools_mode` | Modify |

## Stacked PR Delivery Strategy

この変更は 1 個の PR にまとめない。以下の linear stack を**実装開始前**に作る。ただし、stack の作成自体が Git 操作であるため、実装者は最初に人間の明示的な承認を取得し、承認がない場合はここで停止する。

```text
(master) <- admin-ui/security-assets <- admin-ui/dashboard <- admin-ui/editing-docs
```

| PR | Branch | Base | Scope | Required gate |
| --- | --- | --- | --- | --- |
| 1 | `admin-ui/security-assets` | `master` | Worker-first asset routing、Access JWT、Origin guard、integration tests | focused tests + typecheck |
| 2 | `admin-ui/dashboard` | `admin-ui/security-assets` | vendored CSS、HTML、read-only quota/usage/clients/models dashboard | static asset test + browser read-only QA |
| 3 | `admin-ui/editing-docs` | `admin-ui/dashboard` | inline edits、UX validation、docs、full manual QA | full test + typecheck + browser edit QA |

After the human explicitly approves stack initialization and confirms `master` as the trunk, create and inspect the stack non-interactively:

```bash
gh stack init --base master admin-ui/security-assets
gh stack add admin-ui/dashboard
gh stack add admin-ui/editing-docs
gh stack view --json
```

After every layer is green, stop and request a new explicit human approval to push branches and create draft PRs. `gh stack submit` performs both the push and the PR creation, so do not run it before that handoff.

```bash
gh stack submit --auto --remote origin
gh stack view --json
```

Do not use subagents for any task in this plan. Do not run `gh stack merge` or any other merge
command from this plan; a human operator merges the three PRs bottom-to-top after a separate
explicit approval.

---

## PR 1: `admin-ui/security-assets`

### Task 1: Add the origin-rejection error contract

**Files:**
- Modify: `packages/shared/src/errors.ts`
- Modify: `packages/shared/test/errors.test.ts`

**Interfaces:**
- Produces: `errOriginNotAllowed(requestId: string): OctgHttpError`.
- Contract: HTTP 403, `permission_error`, code `origin_not_allowed`; no sensitive
  origin value appears in the response.

- [x] **Step 1: Write the failing contract test**

```ts
import { errOriginNotAllowed } from "../src/errors";

it("returns a generic forbidden-origin response", async () => {
  const response = errorResponse(errOriginNotAllowed("req_origin"));
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({
    error: {
      message: "Request origin is not allowed.",
      type: "permission_error",
      param: null,
      code: "origin_not_allowed",
    },
    request_id: "req_origin",
  });
});
```

- [x] **Step 2: Run the focused test and confirm RED**

```bash
npm exec vitest run packages/shared/test/errors.test.ts
```

Expected: failure because `errOriginNotAllowed` is not exported.

- [x] **Step 3: Add the minimal error factory**

```ts
export function errOriginNotAllowed(requestId: string): OctgHttpError {
  return makeError(
    403,
    requestId,
    "Request origin is not allowed.",
    "permission_error",
    null,
    "origin_not_allowed",
  );
}
```

- [x] **Step 4: Run the focused test and typecheck**

```bash
npm exec vitest run packages/shared/test/errors.test.ts
npm run typecheck -w packages/shared
```

Expected: both commands exit 0.

- [ ] **Step 5: Commit PR 1 Task 1**

```bash
git add packages/shared/src/errors.ts packages/shared/test/errors.test.ts
git commit -m "feat(admin): Origin 拒否エラー契約を追加"
```

### Task 2: Guard all Admin state changes against a foreign Origin

**Files:**
- Modify: `apps/gateway-worker/src/admin.ts`
- Modify: `apps/gateway-worker/test/admin-api.test.ts`

**Interfaces:**
- Produces: `isAllowedAdminOrigin(request: Request): boolean` local helper.
- Consumes: request URL and optional `Origin` header.
- Contract: a missing Origin remains allowed for existing authenticated CLI clients;
  a mismatched Origin returns `errOriginNotAllowed()` before D1 or reconciliation work.

- [x] **Step 1: Write one RED test per protected endpoint**

Add a helper to `admin-api.test.ts`. Pass it a real signed Access JWT from the test file's
existing `token()` helper; never use a fixed placeholder token.

```ts
function withForeignOrigin(accessJwt: string, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("cf-access-jwt-assertion", accessJwt);
  headers.set("origin", "https://attacker.example");
  headers.set("content-type", "application/json");
  return {
    ...init,
    headers,
  };
}
```

Add tests that issue valid-JWT foreign-Origin requests to all four state-changing endpoints:
the two PUT endpoints, `POST /admin/reconcile`, and
`POST /admin/reconcile/:pool/:utcDay/:targetRequestId`. Call
`withForeignOrigin(await token(), init)` so every request passes JWT verification and reaches
the Origin guard. For each response assert `403` and `error.code === "origin_not_allowed"`.
For the two PUT endpoints, follow with an authenticated read and assert the seeded D1 value is
unchanged. For both reconciliation endpoints, snapshot the relevant Durable Object state and
the seeded `requests` projection before the request, then assert both remain unchanged after the
403 response. Keep existing signed-token no-Origin and same-Origin success tests so valid
requests can still assert their normal `200` responses.

- [x] **Step 2: Run the focused tests and confirm RED**

```bash
npm exec vitest run --config apps/gateway-worker/vitest.config.ts \
  apps/gateway-worker/test/admin-api.test.ts
```

Expected: the requests currently reach their handlers instead of returning 403.

- [x] **Step 3: Add the guard after JWT verification and before mutation dispatch**

In `admin.ts`, import `errOriginNotAllowed`. Add:

```ts
function isAllowedAdminOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin === null || origin === new URL(request.url).origin;
}
```

After successful `verifyAccessJwt()` and before each of these four mutation branches,
return `errorResponse(errOriginNotAllowed(requestId))` when the helper returns false:

```text
PUT  /admin/clients/:id/policy
PUT  /admin/models/:model
POST /admin/reconcile
POST /admin/reconcile/:pool/:utcDay/:targetRequestId
```

Keep existing input parsing, error bodies, and reconciliation behavior unchanged.

- [x] **Step 4: Verify foreign Origin rejection and CLI compatibility**

```bash
npm exec vitest run --config apps/gateway-worker/vitest.config.ts \
  apps/gateway-worker/test/admin-api.test.ts
```

Expected: foreign Origin tests return 403 without mutation; existing tests without
`Origin` remain green.

- [ ] **Step 5: Commit PR 1 Task 2**

```bash
git add apps/gateway-worker/src/admin.ts apps/gateway-worker/test/admin-api.test.ts
git commit -m "feat(admin): 状態変更に Origin 検証を追加"
```

### Task 3: Configure authenticated Worker-first static asset delivery

**Files:**
- Modify: `apps/gateway-worker/wrangler.jsonc`
- Modify: `apps/gateway-worker/src/index.ts`
- Modify: `apps/gateway-worker/vitest.config.ts`
- Create: `apps/gateway-worker/test/admin-ui.test.ts`

**Interfaces:**
- Produces: `Env.ASSETS: Fetcher`.
- Produces: `isAdminUiPath(pathname: string): boolean` for `/admin/ui` and
  `/admin/ui/*` only.
- Contract: `/admin/ui/*` returns static assets only after Access JWT verification;
  JSON Admin APIs retain `handleAdmin`; unknown `/admin/*` retains JSON 404 behavior.

- [x] **Step 1: Write RED Worker integration tests**

Create `admin-ui.test.ts` using the existing JWT setup pattern. Test:

```ts
it("rejects /admin/ui/ without an Access JWT", async () => {
  expect((await SELF.fetch("https://octg.test/admin/ui/")).status).toBe(401);
});

it("serves the authenticated dashboard entrypoint", async () => {
  const response = await SELF.fetch("https://octg.test/admin/ui/", {
    headers: { "cf-access-jwt-assertion": await token() },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/html");
});

it("serves an authenticated non-entry asset as text/plain in the test double", async () => {
  const response = await SELF.fetch("https://octg.test/admin/ui/app.js", {
    headers: { "cf-access-jwt-assertion": await token() },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/plain");
  expect(await response.text()).toBe("asset");
});

it("keeps an authenticated unknown admin API route as JSON 404", async () => {
  const response = await SELF.fetch("https://octg.test/admin/unknown", {
    headers: { "cf-access-jwt-assertion": await token() },
  });
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toContain("application/json");
});
```

- [x] **Step 2: Add the asset configuration and test binding**

Add this top-level `assets` object to `wrangler.jsonc`:

```jsonc
"assets": {
  "directory": "./public",
  "binding": "ASSETS",
  "html_handling": "auto-trailing-slash",
  "not_found_handling": "none",
  "run_worker_first": ["/admin/*"]
}
```

In `vitest.config.ts`, configure the existing Worker pool with a test-only `ASSETS`
service binding. Return `text/html` for `/admin/ui/` and `text/plain` otherwise:

```ts
miniflare: {
  serviceBindings: {
    ASSETS: (request: Request) => {
      const isEntrypoint = new URL(request.url).pathname === "/admin/ui/";
      return new Response(isEntrypoint ? "<title>OCTG Admin</title>" : "asset", {
        headers: {
          "content-type": isEntrypoint
            ? "text/html; charset=utf-8"
            : "text/plain; charset=utf-8",
        },
      });
    },
  },
}
```

This test double proves the Worker authentication and dispatch boundary. It does not
claim to emulate Workers Static Assets URL normalization; that behavior is checked
against the real staging deployment in Task 6.

- [x] **Step 3: Add the route dispatch**

Extend `Env` with `readonly ASSETS: Fetcher`. In the default fetch handler,
before calling `handleAdmin`, branch only for `/admin/ui` and paths starting
`/admin/ui/`:

```ts
if (url.pathname === "/admin/ui" || url.pathname.startsWith("/admin/ui/")) {
  const uiRequestId = `req_${ulid()}`;
  const access = await verifyAccessJwt(request, env, uiRequestId);
  if (access !== true) return errorResponse(access);
  return env.ASSETS.fetch(request);
}
```

Use the existing `ulid` import and generate `uiRequestId` inside this branch. Do not pass the
possibly undefined outer `requestId`, and do not use a non-null assertion.

Do not route `/admin/ui` through `handleAdmin`; let configured HTML handling redirect it
to `/admin/ui/`. Do not fetch assets for any other `/admin/*` path.

- [x] **Step 4: Add minimal temporary entrypoint fixtures, then run GREEN**

Before PR 2 supplies the dashboard, create a minimal `public/admin/ui/index.html`
containing a title and no secrets so the route test is meaningful. Run:

```bash
npm exec vitest run --config apps/gateway-worker/vitest.config.ts \
  apps/gateway-worker/test/admin-ui.test.ts
npm run typecheck -w apps/gateway-worker
```

Expected: authenticated `/admin/ui/` is HTML, unauthenticated access is 401, and
unknown JSON Admin routes remain JSON 404.

- [ ] **Step 5: Commit PR 1 Task 3**

```bash
git add apps/gateway-worker/wrangler.jsonc apps/gateway-worker/src/index.ts \
  apps/gateway-worker/vitest.config.ts apps/gateway-worker/test/admin-ui.test.ts \
  apps/gateway-worker/public/admin/ui/index.html
git commit -m "feat(admin): Access 保護付き静的 UI 配信を追加"
```

## PR 2: `admin-ui/dashboard`

### Task 4: Add the dashboard shell, local CSS, and safe API modules

**Files:**
- Modify: `apps/gateway-worker/public/admin/ui/index.html`
- Create: `apps/gateway-worker/public/admin/ui/pico.min.css`
- Create: `apps/gateway-worker/public/admin/ui/styles.css`
- Create: `apps/gateway-worker/public/admin/ui/api.js`
- Create: `apps/gateway-worker/public/admin/ui/render.js`
- Create: `apps/gateway-worker/public/admin/ui/app.js`

**Interfaces:**
- Produces: `requestJson(path, options?)`, `loadDashboard()`, and safe DOM renderers.
- Contract: every request uses an absolute `/admin/...` path and
  `credentials: "same-origin"`; response values are rendered with DOM nodes and
  `textContent`, never `innerHTML`.

- [x] **Step 1: Replace the temporary page with semantic dashboard markup**

Create `<main class="container">` with a header title `OCTG Admin`, a
`<time id="last-updated">`, `aria-live="polite"` notification region, and four
sections with stable IDs: `quota-section`, `usage-section`, `clients-section`, and
`models-section`. Each section has a heading, a refresh button, and a
`<div class="section-content">` target. Link only:

```html
<link rel="stylesheet" href="/admin/ui/pico.min.css">
<link rel="stylesheet" href="/admin/ui/styles.css">
<script type="module" src="/admin/ui/app.js"></script>
```

- [x] **Step 2: Vendor Pico.css 2.1.1 without a CDN**

Use the checked package artifact, preserving its license banner:

```bash
npm pack @picocss/pico@2.1.1 --pack-destination /tmp
tar -xOf /tmp/picocss-pico-2.1.1.tgz package/css/pico.min.css \
  > apps/gateway-worker/public/admin/ui/pico.min.css
```

Verify the file begins with the upstream license comment and has no network URL.

- [x] **Step 3: Implement the API client with error normalization**

`api.js` must expose this behavior:

```js
export class AdminApiError extends Error {
  constructor(status, message, requestId) {
    super(message);
    this.status = status;
    this.requestId = requestId;
  }
}

export async function requestJson(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { accept: "application/json", ...options.headers },
    ...options,
  });
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new AdminApiError(
      response.status,
      body?.error?.message ?? `Request failed (${response.status}).`,
      body?.request_id ?? null,
    );
  }
  return body;
}
```

Use only `/admin/quota`, `/admin/usage`, `/admin/clients`, and `/admin/models`.

- [x] **Step 4: Implement read-only renderers**

In `render.js`, render quota cards in fixed `standard`, `mini` order and show every
zero. Throw a displayable contract error if either pool is absent. Render usage
sorted by `client_id` and show exactly `利用実績なし` for an empty list. Render
clients and models as tables, including client `tools_mode` and model provider.
Show request IDs and UTC dates; do not transform `utc_day` to local time. Set the
header timestamp from the completion time of each successful refresh.

- [x] **Step 5: Wire load, retry, and per-section failure states**

`app.js` calls all four GET endpoints at startup and on each section refresh button.
On failure, preserve other sections and put the error message plus a retry button in
the failed section. For 401/403, show a neutral notification that Access
authentication may need renewal; never display a token or response body verbatim.

- [x] **Step 6: Verify static assets and syntax**

```bash
node --check apps/gateway-worker/public/admin/ui/api.js
node --check apps/gateway-worker/public/admin/ui/render.js
node --check apps/gateway-worker/public/admin/ui/app.js
npm exec vitest run --config apps/gateway-worker/vitest.config.ts \
  apps/gateway-worker/test/admin-ui.test.ts
```

Expected: syntax checks and route integration tests exit 0.

- [x] **Step 7: Manual read-only browser QA**

Run `npm run dev -w apps/gateway-worker`, authenticate through the configured
Cloudflare Access staging route, then open `/admin/ui/` in a real browser. Confirm
all four sections render, quota order is STANDARD then MINI, usage is sorted, and a
failed request shows only its section-level retry UI.

- [ ] **Step 8: Commit PR 2**

```bash
git add apps/gateway-worker/public/admin/ui
git commit -m "feat(admin): 管理ダッシュボードの参照画面を追加"
```

## PR 3: `admin-ui/editing-docs`

### Task 5: Add accessible inline edit workflows

**Files:**
- Create: `apps/gateway-worker/public/admin/ui/editors.js`
- Modify: `apps/gateway-worker/public/admin/ui/render.js`
- Modify: `apps/gateway-worker/public/admin/ui/app.js`
- Modify: `apps/gateway-worker/public/admin/ui/styles.css`

**Interfaces:**
- Produces: `beginClientEdit(client, onSaved)` and `beginModelEdit(model, onSaved)`.
- Consumes: `requestJson()`.
- Contract: Save sends complete API payloads; Cancel restores the original row;
  failed Save keeps all entered values and renders a row-local error.

- [x] **Step 1: Implement complete client policy form data**

The editor must use labelled controls for all five required fields:

```js
const payload = {
  overflow_mode: overflowMode.value,
  output_limit_mode: outputLimitMode.value,
  max_paid_usd_day: Number(maxPaidUsdDay.value),
  cache_enabled: cacheEnabled.checked,
  tools_mode: toolsMode.value,
};
```

Validate `Number.isFinite(payload.max_paid_usd_day)` and `>= 0` before PUT. Use
select options `REJECT` / `PAID_SHARED`, `REJECT` / `CLAMP`, and `REJECT` /
`ALLOW`; use `<input type="number" min="0" step="any">` and a checkbox.

- [x] **Step 2: Implement complete model form data**

```js
const payload = {
  complimentary_pool: complimentaryPool.value,
  enabled: enabled.checked,
  fallback_model: fallbackModel.value.trim() || null,
};
```

Allow only `STANDARD`, `MINI`, and `NONE` for `complimentary_pool`. Send the PUT to
`/admin/models/${encodeURIComponent(model.model)}` and client updates to
`/admin/clients/${encodeURIComponent(client.id)}/policy` with
`content-type: application/json`.

- [x] **Step 3: Handle Save, Cancel, and failure state**

Disable Save while the request is pending. On success, call the applicable GET
endpoint and replace that section from authoritative API data. On error, re-enable
Save, retain each input value, and append a `role="alert"` message using
`textContent`. Cancel must restore the non-edit row without making a request.

- [x] **Step 4: Update rendering and styles**

Add an `Edit` button to each client/model row. Style edit rows and errors in
`styles.css` while preserving Pico defaults. Use responsive overflow for tables and
visible keyboard focus. Do not add a reconcile button; it remains an explicitly
deferred extension despite receiving server-side Origin protection in PR 1.

- [x] **Step 5: Syntax and Worker verification**

```bash
node --check apps/gateway-worker/public/admin/ui/editors.js
npm test
npm run typecheck
```

Expected: all project tests and workspace typechecks exit 0.

- [x] **Step 6: Manual edit browser QA**

In the authenticated staging browser, edit one seeded client policy including
`tools_mode`, save it, reload the page, and confirm all five saved values match the
API. Edit one model, set `fallback_model` empty, save, reload, and confirm it is
displayed as null/empty. Trigger a local invalid `max_paid_usd_day` value and an API
failure; confirm Save keeps the form values and shows a row-local error. Click
Cancel and confirm no API request is issued.

- [ ] **Step 7: Commit Task 5**

```bash
git add apps/gateway-worker/public/admin/ui
git commit -m "feat(admin): クライアントとモデルのインライン編集を追加"
```

### Task 6: Update operational documentation and complete production validation

**Files:**
- Modify: `SPEC.md`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-12-admin-web-ui-design.md`

**Interfaces:**
- Documents the deployed routes, same-Origin state-change rule, all five Client
  policy fields, and Cloudflare Access verification steps.

- [x] **Step 1: Correct the design specification**

In the Clients edit-fields table, add:

```markdown
| `tools_mode` | enum | select: REJECT, ALLOW |
```

State that it is included because `PUT /admin/clients/:id/policy` requires all five
policy fields. Document the chosen compatibility rule: absent Origin is permitted
for authenticated CLI requests; any supplied Origin must match the request origin.

- [x] **Step 2: Update `SPEC.md` and `README.md`**

Document `/admin/ui/` asset paths, Worker-first JWT validation, no external CDN,
and the following production confirmation sequence:

```text
1. One Access application covers /admin/* and its AUD equals ACCESS_AUD.
2. Unauthenticated /admin/ui/, app.js, styles.css, and pico.min.css are rejected.
3. Authenticated UI assets load and all API fetches retain the Access session.
4. A valid JWT plus Origin: https://attacker.example receives 403 on all four
   protected mutation endpoints, including
   `POST /admin/reconcile/:pool/:utcDay/:targetRequestId`, and does not alter data.
5. A valid JWT with no Origin remains usable by the documented admin CLI flow.
```

- [x] **Step 3: Run final verification**

```bash
npm test
npm run typecheck
npx markdownlint-cli2 docs/superpowers/plans/2026-08-22-admin-web-ui.md \
  SPEC.md README.md docs/superpowers/specs/2026-08-12-admin-web-ui-design.md
```

Expected: all commands exit 0. If `markdownlint-cli2` is unavailable, record that
fact and run the repository's configured Markdown command instead; do not add a
dependency merely for this check.

- [x] **Step 4: Complete production manual QA**

Use a real browser against the Access-protected staging deployment. Confirm `/admin/ui`
redirects to `/admin/ui/`, all local assets load without third-party requests, all
read/edit behavior from Task 5 works, an expired Access session is handled by Access,
and an unknown `/admin/ui/missing.js` does not shadow an Admin API route.

- [ ] **Step 5: Commit PR 3**

```bash
git add SPEC.md README.md docs/superpowers/specs/2026-08-12-admin-web-ui-design.md
git commit -m "docs(admin): 管理 UI の運用手順を追加"
```

## Self-Review Checklist

1. **Spec coverage:** Static Assets, `/admin/ui` canonical URL, Access protection,
   quota/usage ordering, empty usage, retries, all client/model edit rules, no CDN,
   Origin/CSRF defense, and required cross-origin tests map to Tasks 1-6.
2. **Correction recorded:** the source design omitted `tools_mode` from the UI even
   though the current Admin API requires it. Task 5 and Task 6 correct this rather
   than shipping a Save button that always produces HTTP 400.
3. **Routing safety:** `run_worker_first` is constrained to `/admin/*`; UI assets
   require JWT before `ASSETS.fetch`; other Admin paths remain JSON API routes.
4. **Placeholder scan:** this plan contains no TBD/TODO, generic validation step, or
   unspecified test action.
5. **Type/API consistency:** client JSON uses snake_case five-field policy payloads;
   model JSON uses the existing three-field payload; all paths match `admin.ts`.
6. **Execution constraint:** all tasks explicitly prohibit subagent use, describe a three-layer
   stacked PR delivery sequence, and require human approval immediately before Git operations,
   branch pushes, PR creation, and merge handoff.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-22-admin-web-ui.md`.

Execute it inline only, without subagents, beginning with the bottom stacked branch
`admin-ui/security-assets` after explicit approval for the initial stack Git operations. Do not
commit, create, push, submit, or merge PRs unless explicitly approved. After all layer checks are
green, stop and hand off to a human for explicit approval immediately before `gh stack submit`
or any push/PR creation; merge remains a separate human-only handoff.
