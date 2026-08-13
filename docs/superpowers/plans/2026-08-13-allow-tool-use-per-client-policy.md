# Allow Tool-Use per Client Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the unconditional tool-use rejection in the gateway proxy and replace it with a client-policy based gate, so OpenCode agent requests with `tools`/`tool_choice` can use the complimentary quota when explicitly enabled.

**Architecture:** Add a `tools_mode` column to `client_policies` with values `"REJECT"` (default) or `"ALLOW"`. Load it in `loadPolicy()`, then change `proxy.ts` to consult `policy.toolsMode` instead of always rejecting tool-use requests. Update the Admin API policy parser/writer and seed script, and add tests verifying both default rejection and explicit allowance flow through to upstream settlement.

**Tech Stack:** TypeScript, Cloudflare Workers, Vitest + `@cloudflare/vitest-pool-workers`, D1 SQLite, Durable Objects.

## Global Constraints

- **Never** commit absolute paths.
- TypeScript strict mode; no `as any`, no `@ts-ignore`.
- Empty `catch` blocks are forbidden.
- Do not delete failing tests to pass.
- Use environment variables (`$HOME`, `$PWD`) or relative paths.
- Do not create new agent config files.
- All tests must pass via `npm test` before claiming done.
- Do not run git commands inside a devcontainer.
- Keep D1 migrations additive and backwards-compatible for local/remote deployments.
- Client policy fields default to the most restrictive value (`REJECT`).

---

## File Map

| File | Responsibility | Action |
|------|----------------|--------|
| `db/migrations/0004_add_tools_mode.sql` | Add `tools_mode` column to `client_policies` with default `'REJECT'`. | Create |
| `apps/gateway-worker/src/policy.ts` | Extend `ClientPolicy` and `loadPolicy()` to read `tools_mode`. | Modify |
| `apps/gateway-worker/src/admin.ts` | Extend `ClientPolicyInput` parsing, `effectiveClientPolicy()`, and the PUT/GET policy handlers. | Modify |
| `apps/gateway-worker/src/proxy.ts` | Replace unconditional `isToolUse` rejection with `policy.toolsMode === "ALLOW"` check. | Modify |
| `scripts/seed-client.mjs` | Seed new clients with `tools_mode: 'REJECT'`. | Modify |
| `apps/gateway-worker/test/seed.ts` | Extend `seedPolicy()` helper to accept `toolsMode`. | Modify |
| `apps/gateway-worker/test/policy.test.ts` | Verify `loadPolicy` returns `toolsMode: "REJECT"` by default and `"ALLOW"` when seeded. | Modify |
| `apps/gateway-worker/test/admin-api.test.ts` | Verify admin policy round-trip for `tools_mode`. | Modify |
| `apps/gateway-worker/test/proxy.test.ts` | Replace the existing tool-use rejection test with two tests: default reject and allow-with-policy. | Modify |

---

## Task 1: Add `tools_mode` Migration

**Files:**
- Create: `db/migrations/0004_add_tools_mode.sql`

**Interfaces:**
- Consumes: existing `client_policies` table from `0001_init.sql`.
- Produces: `client_policies.tools_mode` column available to reads/writes.

- [ ] **Step 1: Write the migration file**

```sql
-- Add per-client tool-use policy. Default REJECT preserves MVP behavior.
ALTER TABLE client_policies ADD COLUMN tools_mode TEXT NOT NULL DEFAULT 'REJECT' CHECK (tools_mode IN ('REJECT', 'ALLOW'));
```

- [ ] **Step 2: Verify migration file exists and follows project conventions**

Run:

```bash
ls -la db/migrations/0004_add_tools_mode.sql
```

Expected: file is listed and readable.

- [ ] **Step 3: Apply migration locally**

Run:

```bash
npx wrangler d1 migrations apply octg --local --config apps/gateway-worker/wrangler.jsonc
```

Expected: command succeeds, local D1 now has `tools_mode` column.

- [ ] **Step 4: Commit**

```bash
git add db/migrations/0004_add_tools_mode.sql
git commit -m "feat(db): client_policies に tools_mode カラムを追加"
```

---

## Task 2: Extend `ClientPolicy` and `loadPolicy()`

**Files:**
- Modify: `apps/gateway-worker/src/policy.ts:5-17`
- Modify: `apps/gateway-worker/src/policy.ts:37-62`
- Test: `apps/gateway-worker/test/policy.test.ts`

**Interfaces:**
- Consumes: D1 row field `tools_mode` (`'REJECT' | 'ALLOW'`).
- Produces: `ClientPolicy.toolsMode: "REJECT" | "ALLOW"` loaded by `proxy.ts` and `admin.ts`.

- [ ] **Step 1: Add `toolsMode` to `ClientPolicy` and default policy**

In `apps/gateway-worker/src/policy.ts`, change:

```ts
export interface ClientPolicy {
  overflowMode: "REJECT" | "PAID_SHARED";
  outputLimitMode: "REJECT" | "CLAMP";
  maxPaidUsdDay: number;
  cacheEnabled: boolean;
  toolsMode: "REJECT" | "ALLOW";
}

export const DEFAULT_CLIENT_POLICY: ClientPolicy = {
  overflowMode: "REJECT",
  outputLimitMode: "REJECT",
  maxPaidUsdDay: 0,
  cacheEnabled: false,
  toolsMode: "REJECT",
};
```

- [ ] **Step 2: Extend the `PolicyRow` interface and `loadPolicy` query**

Change:

```ts
interface PolicyRow {
  overflow_mode: string;
  output_limit_mode: string;
  max_paid_usd_day: number;
  cache_enabled: number;
  tools_mode: string;
}
```

Change the query in `loadPolicy` to:

```ts
"SELECT overflow_mode, output_limit_mode, max_paid_usd_day, cache_enabled, tools_mode FROM client_policies WHERE client_id = ?"
```

Change the row mapping in `loadPolicy` to:

```ts
const policy: ClientPolicy = row
  ? {
      overflowMode: row.overflow_mode === "PAID_SHARED" ? "PAID_SHARED" : "REJECT",
      outputLimitMode: row.output_limit_mode === "CLAMP" ? "CLAMP" : "REJECT",
      maxPaidUsdDay: row.max_paid_usd_day,
      cacheEnabled: row.cache_enabled === 1,
      toolsMode: row.tools_mode === "ALLOW" ? "ALLOW" : "REJECT",
    }
  : DEFAULT_CLIENT_POLICY;
```

- [ ] **Step 3: Add tests for `toolsMode` loading**

In `apps/gateway-worker/test/policy.test.ts`, replace the existing default/CLAMP test body (lines 30-40) with:

```ts
  it("returns the default policy and loads CLAMP policy", async () => {
    await expect(loadPolicy(env, TEST_CLIENT_ID)).resolves.toEqual(DEFAULT_CLIENT_POLICY);
    await seedPolicy(TEST_CLIENT_ID, { outputLimitMode: "CLAMP", maxPaidUsdDay: 12.5 });
    invalidateConfigCaches();
    await expect(loadPolicy(env, TEST_CLIENT_ID)).resolves.toMatchObject({
      outputLimitMode: "CLAMP",
      overflowMode: "REJECT",
      maxPaidUsdDay: 12.5,
      cacheEnabled: false,
      toolsMode: "REJECT",
    });
  });

  it("loads toolsMode ALLOW when seeded", async () => {
    await seedPolicy(TEST_CLIENT_ID, { toolsMode: "ALLOW" });
    invalidateConfigCaches();
    await expect(loadPolicy(env, TEST_CLIENT_ID)).resolves.toMatchObject({ toolsMode: "ALLOW" });
  });
```

- [ ] **Step 4: Extend `seedPolicy()` helper**

In `apps/gateway-worker/test/seed.ts`, change the function signature and bind for `seedPolicy`:

```ts
export async function seedPolicy(
  clientId: string,
  policy: {
    overflowMode?: string;
    outputLimitMode?: string;
    maxPaidUsdDay?: number;
    cacheEnabled?: boolean;
    toolsMode?: string;
  },
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO client_policies (client_id, overflow_mode, output_limit_mode, max_paid_usd_day, cache_enabled, tools_mode) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(client_id) DO UPDATE SET overflow_mode=excluded.overflow_mode, output_limit_mode=excluded.output_limit_mode, max_paid_usd_day=excluded.max_paid_usd_day, cache_enabled=excluded.cache_enabled, tools_mode=excluded.tools_mode",
  )
    .bind(
      clientId,
      policy.overflowMode ?? "REJECT",
      policy.outputLimitMode ?? "REJECT",
      policy.maxPaidUsdDay ?? 0,
      policy.cacheEnabled ? 1 : 0,
      policy.toolsMode ?? "REJECT",
    )
    .run();
}
```

- [ ] **Step 5: Run the policy tests**

Run:

```bash
cd apps/gateway-worker
npx vitest run test/policy.test.ts
```

Expected: all policy tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway-worker/src/policy.ts apps/gateway-worker/test/policy.test.ts apps/gateway-worker/test/seed.ts
git commit -m "feat(policy): client policy に toolsMode を追加"
```

---

## Task 3: Update Admin API Policy Handling

**Files:**
- Modify: `apps/gateway-worker/src/admin.ts:12-15`
- Modify: `apps/gateway-worker/src/admin.ts:17-25`
- Modify: `apps/gateway-worker/src/admin.ts:36-39`
- Modify: `apps/gateway-worker/src/admin.ts:59-70`
- Test: `apps/gateway-worker/test/admin-api.test.ts`

**Interfaces:**
- Consumes: `ClientPolicy.toolsMode` from `policy.ts`.
- Produces: JSON shape `{ overflow_mode, output_limit_mode, max_paid_usd_day, cache_enabled, tools_mode }` accepted by PUT `/admin/clients/:id/policy` and returned by GET `/admin/clients`.

- [ ] **Step 1: Update `ClientPolicyInput` and default constants**

Change:

```ts
type ClientPolicyInput = { overflow_mode: "REJECT" | "PAID_SHARED"; output_limit_mode: "REJECT" | "CLAMP"; max_paid_usd_day: number; cache_enabled: boolean; tools_mode: "REJECT" | "ALLOW" };
const DEFAULT_CLIENT_POLICY = { overflow_mode: "REJECT", output_limit_mode: "REJECT", max_paid_usd_day: 0, cache_enabled: false, tools_mode: "REJECT" } as const;
```

- [ ] **Step 2: Extend `effectiveClientPolicy()` to normalize `tools_mode`**

Change:

```ts
function effectiveClientPolicy(row: { overflow_mode: string | null; output_limit_mode: string | null; max_paid_usd_day: number | null; cache_enabled: number | null; tools_mode: string | null }): { overflow_mode: "REJECT" | "PAID_SHARED"; output_limit_mode: "REJECT" | "CLAMP"; max_paid_usd_day: number; cache_enabled: boolean; tools_mode: "REJECT" | "ALLOW" } {
  const overflow_mode = row.overflow_mode === "PAID_SHARED" ? "PAID_SHARED" : "REJECT";
  const output_limit_mode = row.output_limit_mode === "CLAMP" ? "CLAMP" : "REJECT";
  const max_paid_usd_day = typeof row.max_paid_usd_day === "number" && Number.isFinite(row.max_paid_usd_day) && row.max_paid_usd_day >= 0 ? row.max_paid_usd_day : 0;
  let cache_enabled: boolean = DEFAULT_CLIENT_POLICY.cache_enabled;
  if (row.cache_enabled === 1) cache_enabled = true;
  else if (row.cache_enabled === 0) cache_enabled = false;
  const tools_mode = row.tools_mode === "ALLOW" ? "ALLOW" : "REJECT";
  return { overflow_mode, output_limit_mode, max_paid_usd_day, cache_enabled, tools_mode };
}
```

Update the `ClientListRow` type to include `tools_mode: string | null`.

- [ ] **Step 3: Extend `parseClientPolicy()` validation**

Change:

```ts
function parseClientPolicy(value: Record<string, unknown> | undefined): ClientPolicyInput | undefined {
  if (!value) return undefined;
  if (value.overflow_mode !== "REJECT" && value.overflow_mode !== "PAID_SHARED") return undefined;
  if (value.output_limit_mode !== "REJECT" && value.output_limit_mode !== "CLAMP") return undefined;
  if (typeof value.max_paid_usd_day !== "number" || !Number.isFinite(value.max_paid_usd_day) || value.max_paid_usd_day < 0) return undefined;
  if (typeof value.cache_enabled !== "boolean") return undefined;
  if (value.tools_mode !== "REJECT" && value.tools_mode !== "ALLOW") return undefined;
  return {
    overflow_mode: value.overflow_mode,
    output_limit_mode: value.output_limit_mode,
    max_paid_usd_day: value.max_paid_usd_day,
    cache_enabled: value.cache_enabled,
    tools_mode: value.tools_mode,
  };
}
```

- [ ] **Step 4: Update the clients list SQL and the PUT handler bind parameters**

Change the GET `/admin/clients` SQL to select `p.tools_mode`:

```ts
"SELECT c.id, c.name, c.enabled, c.created_at, p.overflow_mode, p.output_limit_mode, p.max_paid_usd_day, p.cache_enabled, p.tools_mode FROM clients c LEFT JOIN client_policies p ON c.id = p.client_id ORDER BY c.id"
```

Change the PUT handler upsert SQL to include `tools_mode`:

```ts
"INSERT INTO client_policies (client_id, overflow_mode, output_limit_mode, max_paid_usd_day, cache_enabled, tools_mode) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(client_id) DO UPDATE SET overflow_mode=excluded.overflow_mode, output_limit_mode=excluded.output_limit_mode, max_paid_usd_day=excluded.max_paid_usd_day, cache_enabled=excluded.cache_enabled, tools_mode=excluded.tools_mode"
```

And bind `body.tools_mode` in the `.bind()` call after `body.cache_enabled ? 1 : 0`.

- [ ] **Step 5: Add admin API tests for `tools_mode`**

In `apps/gateway-worker/test/admin-api.test.ts`, add after the existing round-trip test:

```ts
  it("round-trips tools_mode from admin write through read-normalize", async () => {
    await admin(`/admin/clients/${TEST_CLIENT_ID}/policy`, { method: "PUT", body: JSON.stringify({ overflow_mode: "REJECT", output_limit_mode: "REJECT", max_paid_usd_day: 0, cache_enabled: false, tools_mode: "ALLOW" }) }, "jwt");
    const list = await admin("/admin/clients", undefined, "jwt");
    const body = await list.json<{ clients: Array<{ id: string; tools_mode: string }> }>();
    expect(body.clients.find((c) => c.id === TEST_CLIENT_ID)?.tools_mode).toBe("ALLOW");
  });

  it("rejects invalid tools_mode values", async () => {
    const response = await admin(`/admin/clients/${TEST_CLIENT_ID}/policy`, { method: "PUT", body: JSON.stringify({ overflow_mode: "REJECT", output_limit_mode: "REJECT", max_paid_usd_day: 0, cache_enabled: false, tools_mode: "MAYBE" }) }, "jwt");
    expect(response.status).toBe(400);
  });
```

- [ ] **Step 6: Run the admin API tests**

Run:

```bash
cd apps/gateway-worker
npx vitest run test/admin-api.test.ts
```

Expected: all admin tests pass.

- [ ] **Step 7: Commit**

```bash
git add apps/gateway-worker/src/admin.ts apps/gateway-worker/test/admin-api.test.ts
git commit -m "feat(admin): tools_mode のポリシー読み書きを追加"
```

---

## Task 4: Remove Unconditional Tool-Use Rejection in Proxy

**Files:**
- Modify: `apps/gateway-worker/src/proxy.ts:95-99`
- Test: `apps/gateway-worker/test/proxy.test.ts:194-201`

**Interfaces:**
- Consumes: `ClientPolicy.toolsMode` from `policy.ts`.
- Produces: HTTP 403 `model_not_allowed` only when `toolsMode === "REJECT"`; otherwise tool-use requests continue through reservation/upstream flow.

- [ ] **Step 1: Replace the unconditional rejection with policy check**

In `apps/gateway-worker/src/proxy.ts`, change:

```ts
if (requestData.isToolUse) {
  return errorResponse(errModelNotAllowed(requestId, snapshotOf(await stub.getState())));
}
```

to:

```ts
if (requestData.isToolUse && policy.toolsMode !== "ALLOW") {
  return errorResponse(errModelNotAllowed(requestId, snapshotOf(await stub.getState())));
}
```

- [ ] **Step 2: Update proxy tests for tool-use behavior**

In `apps/gateway-worker/test/proxy.test.ts`, replace the existing tool-use rejection test block (lines 194-201) with:

```ts
  it("rejects tool requests by default before reservation", async () => {
    const unknown = await authed({ model: "gpt-99", messages: [{ role: "user", content: "hi" }] });
    expect(unknown.status).toBe(403);
    expect((await unknown.json()) as { error: { code: string } }).toMatchObject({ error: { code: "model_requires_paid" } });
    const tools = await authed({ model: "gpt-5", messages: [{ role: "user", content: "hi" }], tools: [] });
    expect(tools.status).toBe(403);
    expect((await tools.json()) as { error: { code: string } }).toMatchObject({ error: { code: "model_not_allowed" } });
  });

  it("allows tool requests when client policy toolsMode is ALLOW", async () => {
    await seedPolicy(TEST_CLIENT_ID, { toolsMode: "ALLOW" });
    invalidateConfigCaches();
    const stateBefore = await todayStub().getState();
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({
      id: "chatcmpl-tool",
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const response = await authed({ model: "gpt-5", messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "test" } }] });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-OCTG-Pool")).toBe("standard");
    expect(response.headers.get("X-OCTG-Route")).toBe("free_shared");
    const state = await todayStub().getState();
    expect(state.confirmedTokens - stateBefore.confirmedTokens).toBe(15);
    expect(state.reservedTokens).toBe(stateBefore.reservedTokens);
  });
```

- [ ] **Step 3: Run the proxy tests**

Run:

```bash
cd apps/gateway-worker
npx vitest run test/proxy.test.ts
```

Expected: all proxy tests pass.

- [ ] **Step 4: Commit**

```bash
git add apps/gateway-worker/src/proxy.ts apps/gateway-worker/test/proxy.test.ts
git commit -m "feat(proxy): クライアントポリシーに基づく tool-use 許可を実装"
```

---

## Task 5: Update Seed Script

**Files:**
- Modify: `scripts/seed-client.mjs`

**Interfaces:**
- Consumes: CLI arguments unchanged.
- Produces: `client_policies` INSERT now includes `tools_mode` default `'REJECT'`.

- [ ] **Step 1: Add `tools_mode` to the seed output**

Change:

```js
console.log(
  `INSERT INTO client_policies (client_id, overflow_mode, output_limit_mode, max_paid_usd_day, cache_enabled, tools_mode) VALUES ('${esc(id)}', 'REJECT', 'REJECT', 0, 0, 'REJECT') ` +
    "ON CONFLICT(client_id) DO NOTHING;"
);
```

- [ ] **Step 2: Verify the script still runs**

Run:

```bash
OCTG_KEY_PEPPER=dev-pepper node scripts/seed-client.mjs client_plan_test "Plan Test" octg_sk_plan_test | head -5
```

Expected: output contains `tools_mode` column.

- [ ] **Step 3: Commit**

```bash
git add scripts/seed-client.mjs
git commit -m "chore(seed): 新規クライアントの seed に tools_mode を追加"
```

---

## Task 6: Update SPEC.md and Run Full Verification

**Files:**
- Modify: `SPEC.md`
- Run: `npm test`, `npm run typecheck`

**Interfaces:**
- Consumes: all prior task changes.
- Produces: documentation reflects new behavior; CI passes.

- [ ] **Step 1: Update SPEC.md §5.3**

Change the existing paragraph:

```markdown
### 5.3 Tool-use 判定

`tools` / `tool_choice` / built-in tool 設定が存在するリクエストは、クライアントポリシーの `tools_mode` に基づいて制御される。`tools_mode` は `"REJECT"`（MVP デフォルト）または `"ALLOW"`。

- `"REJECT"`: 無料枠 reservation を行わず、`model_not_allowed` で拒否（要件第 17 章、エラー契約は 5.7）。
- `"ALLOW"`: 既存の quota reservation / settlement フローへ進み、実 usage で精算する。

Admin API (`PUT /admin/clients/:id/policy`) で `tools_mode` を変更できる。PUT リクエストの `tools_mode` が未設定または `"REJECT"` / `"ALLOW"` 以外の無効な値の場合、HTTP 400 (`invalid_request`) で拒否する。DB から読み出したポリシーの `tools_mode` が未設定または無効な値の場合、実行時ポリシーは `"REJECT"` にフォールバックする。
```

- [ ] **Step 2: Update SPEC.md §6 schema bullet**

Change:

```markdown
- `client_policies` — client_id, overflow_mode, output_limit_mode, max_paid_usd_day, cache_enabled, tools_mode
```

- [ ] **Step 3: Run the full test suite**

Run:

```bash
npm test
```

Expected: all workspace tests pass.

- [ ] **Step 4: Run type checking**

Run:

```bash
npm run typecheck
```

Expected: zero type errors.

- [ ] **Step 5: Run lint/format checks if configured**

Run:

```bash
npm run lint --if-present
```

Or check project scripts in `package.json`. Fix any issues.

- [ ] **Step 6: Commit**

```bash
git add SPEC.md
git commit -m "docs: tool-use 判定を client policy ベースに更新"
```

---

## Task 7: Final Verification and Handoff Summary

- [ ] **Step 1: Confirm all tests pass**

Run:

```bash
npm test && npm run typecheck
```

Expected: both exit 0.

- [ ] **Step 2: Review the diff**

Run:

```bash
git diff --stat
```

Expected: changes are limited to the files in the plan.

- [ ] **Step 3: Report completion**

Summarize in prose:

- Added `tools_mode` column to `client_policies` with default `"REJECT"`.
- Extended `ClientPolicy`, `loadPolicy`, Admin API parser/handlers, and seed script to read/write `tools_mode`.
- Changed `proxy.ts` so tool-use requests are rejected only when `policy.toolsMode !== "ALLOW"`.
- Added tests for default rejection, explicit allowance, admin round-trip, and policy loading.
- Updated `SPEC.md` §5.3 and §6 to document the new behavior.

Do not push or create a PR unless explicitly requested by the user.

---

## Self-Review Checklist

1. **Spec coverage:**
   - §5.3 tool-use policy → Task 4 implementation, Task 6 docs.
   - §5.7 `model_not_allowed` error → Task 4 preserves it for REJECT mode.
   - §6 `client_policies` schema → Task 1 migration, Task 6 docs.
   - §7 Admin API policy endpoint → Task 3.

2. **Placeholder scan:**
   - No `TBD`, `TODO`, or vague "add validation" steps.
   - Every test step shows concrete code.
   - Every modify step references exact file/line range.

3. **Type consistency:**
   - `toolsMode` is `"REJECT" | "ALLOW"` everywhere.
   - DB column name `tools_mode` matches in SQL, TypeScript row types, and admin JSON.
   - Default policy values are identical across `policy.ts`, `admin.ts`, and `seed-client.mjs`.

4. **Backwards compatibility:**
   - Migration uses `DEFAULT 'REJECT'`, so existing rows keep current behavior.
   - `seedPolicy()` default keeps tests without explicit `toolsMode` on REJECT.

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-08-13-allow-tool-use-per-client-policy.md`.**

Two execution options:

1. **Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration. Required sub-skill: `superpowers:subagent-driven-development`.
2. **Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Which approach would you like?
