# OCTG as Cloudflare AI Gateway Custom Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Document how to register the existing OCTG Worker as a Cloudflare AI Gateway "custom provider" so clients reach OCTG through Gateway A while OCTG still calls OpenAI through Gateway B, with zero changes to quota logic unless verification proves it necessary.

**Architecture:** Keep the current worker unchanged because it already speaks OpenAI-compatible `/v1/chat/completions` and `/v1/responses`. Add a dedicated runbook, update the main README with an inbound-via-AI-Gateway path, and append a short note to the template deploy guide. Use curl examples from the design spec as executable verification commands.

**Tech Stack:** TypeScript / Cloudflare Workers / Cloudflare AI Gateway / Cloudflare D1 / Durable Objects.

## Global Constraints

- **No code changes to quota logic.** The authoritative quota controller stays untouched.
- **No new credentials in code.** All tokens are configured through Cloudflare Secrets or Gateway Provider Keys.
- **Gateway A (custom-octg) and Gateway B (openai) must be separate gateway instances** to avoid routing loops and to keep inbound/outbound operational boundaries clear.
- **Run tokens are account-wide.** Never share Gateway A and Gateway B Run tokens; rotate them separately.
- **OCTG client keys (`octg_sk_*`) remain client-facing credentials.** They are placed in Gateway A Provider Keys, not in `Authorization` sent to Gateway B.
- **Gateway B outbound uses `cf-aig-authorization: Bearer <Gateway B Run token>`** per SPEC.md §7.1. Confirmed by `apps/gateway-worker/src/upstream.ts` and `apps/gateway-worker/test/proxy.test.ts`.
- **Log payloads are off by default.** Use `cf-aig-collect-log-payload: false` unless explicitly approved.
- **Response cache on Gateway A is disabled or bypassed** (`cf-aig-skip-cache: true`) for verification.
- **All files paths are relative to the repository root.** Never commit absolute paths.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `docs/cloudflare-ai-gateway-custom-provider.md` | New runbook: architecture, setup, curl verification, troubleshooting, rotation, log policy. |
| `README.md` | Add a short section that links to the new runbook and shows the two client usage modes (direct Worker URL vs AI Gateway custom provider). |
| `docs/DEPLOY_FROM_TEMPLATE.md` | Append a note that Gateway A/B split applies when exposing the new instance through AI Gateway custom provider. |

---

### Task 1: Create the custom-provider runbook

**Files:**
- Create: `docs/cloudflare-ai-gateway-custom-provider.md`

**Interfaces:**
- Consumes: `docs/superpowers/specs/2026-08-12-octg-ai-gateway-custom-provider-design.md`
- Produces: A standalone operational document. No code interfaces.

- [ ] **Step 1: Write the runbook header and architecture diagram**

Use four-backtick fenced code blocks for the outer examples so the inner Markdown fences remain properly scoped and MD040 is resolved.

````markdown
# OCTG as a Cloudflare AI Gateway Custom Provider

This runbook registers an already-deployed OCTG Worker as a Cloudflare AI Gateway **Custom Provider**, so clients can call OCTG through Gateway A while OCTG still reaches OpenAI through Gateway B.

## Architecture

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
````

- [ ] **Step 2: Document prerequisites**

Add the following list verbatim:

````markdown
## Prerequisites

- OCTG Worker is already deployed.
- Gateway B (OCTG → OpenAI) exists and `OCTG_UPSTREAM_BASE_URL` ends with `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_b_id}/openai`.
- Gateway B has OpenAI Project A (Data Sharing ON) API key registered as BYOK.
- At least one OCTG client key (`octg_sk_*`) exists and its `key_hash` is in D1.
- You understand that Gateway A and Gateway B Run tokens are account-wide; keep them separate and rotate them separately.
````

- [ ] **Step 3: Document Gateway A setup**

Add the setup steps:

````markdown
## Setting up Gateway A

1. Cloudflare Dashboard → AI Gateway → **Create Gateway**.
2. Name it (e.g. `octg-ingress`).
3. **Custom Providers** → **Add Custom Provider**:
   - **Provider Name**: `OCTG`
   - **Provider Slug**: `octg`
   - **Base URL**: `https://octg-gateway.<subdomain>.workers.dev` (no `/v1` suffix)
   - **Enable**: checked
4. **Save**.
5. Open Gateway A **Settings** and enable **Authenticated Gateway**.
6. **Create authentication token** for Gateway A, grant **Run** permission, and store it separately from OCTG client keys.
7. **Provider Keys** → **Add API Key**:
   - Provider: `octg`
   - Alias: `default`
   - API Key: an existing `octg_sk_*` client key
````

- [ ] **Step 4: Document OCTG-side checks**

Add:

````markdown
## OCTG-side checks

- `OCTG_UPSTREAM_BASE_URL` points to Gateway B and ends with `/openai`.
- `OCTG_UPSTREAM_API_TOKEN` is Gateway B's **AI Gateway Run token**.
- `OCTG_UPSTREAM_API_TOKEN` is sent as `cf-aig-authorization: Bearer <token>` to Gateway B.
- OpenAI provider key on Gateway B is BYOK; the Worker does **not** send an OpenAI key.
- Client keys exist in D1 as `key_hash`.
````

- [ ] **Step 5: Add non-streaming and streaming curl examples**

Add:

````markdown
## Verification

### Non-streaming

```bash
curl https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_a_id}/custom-octg/v1/chat/completions \
  -H "Authorization: Bearer <OCTG client key>" \
  -H "cf-aig-authorization: Bearer <Gateway A Run token>" \
  -H "cf-aig-collect-log-payload: false" \
  -H "cf-aig-skip-cache: true" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.6-luna",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### Streaming

```bash
curl -N https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_a_id}/custom-octg/v1/chat/completions \
  -H "Authorization: Bearer <OCTG client key>" \
  -H "cf-aig-authorization: Bearer <Gateway A Run token>" \
  -H "cf-aig-collect-log-payload: false" \
  -H "cf-aig-skip-cache: true" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.6-luna",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

### Checkpoints

- Request appears in Gateway A logs (metadata only).
- `/quota` on OCTG shows quota consumed for the relevant pool.
- Gateway B logs show the outbound OpenAI call.
- OpenAI-compatible response reaches the client.
- Gateway A response cache is disabled or bypassed (`cf-aig-skip-cache: true`); verify `cf-aig-cache-status` is not `HIT`.
````

- [ ] **Step 6: Add troubleshooting section**

Add:

````markdown
## Troubleshooting

### `Invalid provider` from Gateway A

- Base URL must be `https://octg-gateway.<subdomain>.workers.dev` without `/v1/chat/completions`.
- Provider slug must be `octg`; request path must contain `/custom-octg/`.

### `Invalid provider` from OCTG → Gateway B

- `OCTG_UPSTREAM_BASE_URL` must end with `/openai`, e.g. `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_b_id}/openai`.

### 401 Unauthorized from OCTG

- The Provider Key value in Gateway A must exactly match the `octg_sk_*` whose hash is in D1.
- `OCTG_KEY_PEPPER` on the Worker must match the pepper used to hash that client key.

### Routing loop

- `OCTG_UPSTREAM_BASE_URL` must not point back to Gateway A's `custom-octg` endpoint or to the OCTG Worker itself.
- Always use separate Gateway A and Gateway B instances.

### No response / timeout

- Check remaining quota via `/quota`.
- Check Gateway A timeout settings.
- Check the `requests` table in D1 for request arrival.
- Disable or limit Gateway A retries to 1 to avoid duplicate reservations; OCTG generates a fresh `req_${ulid()}` per delivery.

### Streaming does not work

- Confirm non-streaming works first.
- Include `"stream": true` in the body.
- For `/chat/completions` OCTG adds `stream_options: { include_usage: true }` automatically when streaming.
- For `/responses`, rely on `response.completed` `response.usage` for settlement.
````

- [ ] **Step 7: Add token rotation and log policy notes**

Add:

````markdown
## Token rotation

For **leaked tokens**: revoke immediately, issue a new least-privilege Run token, update the relevant Secret, deploy, then verify Gateway B connectivity. Do not wait for the old token to stop working before revoking.

For **planned rotation**: issue a new least-privilege Run token, update the Secret, deploy, verify Gateway B connectivity, then revoke the old token.

Keep Gateway A and Gateway B Run tokens separate. In multi-account setups, do not mix tokens or BYOK credentials across accounts.

## Logging policy

Default to metadata-only logging (`cf-aig-collect-log-payload: false`) on both gateways. The Worker enforces this on outbound Gateway B requests. Verify in the Cloudflare AI Gateway dashboard that the "Log payload" column is empty/`false` for both gateways. If payload logging is required, obtain prior approval covering: target gateway, request/response side, log count cap, access controls, deletion procedure, and any external encrypted storage destination.
````

- [ ] **Step 8: Validate the new Markdown file**

Run:

```bash
npx markdownlint-cli2 docs/cloudflare-ai-gateway-custom-provider.md
```

Expected: zero errors. If the tool is not installed, install it at repo root with `npm install -D markdownlint-cli2` first or run via `npx`.

- [ ] **Step 9: Commit**

```bash
git add docs/cloudflare-ai-gateway-custom-provider.md
git commit -m "docs: OCTG as Cloudflare AI Gateway Custom Provider runbook"
```

---

### Task 2: Update README.md with the AI Gateway usage mode

**Files:**
- Modify: `README.md` (find the "クイックスタート（利用するだけ）" section)

**Interfaces:**
- Consumes: `docs/cloudflare-ai-gateway-custom-provider.md` created in Task 1.
- Produces: README links to the runbook and shows two client base URL options.

- [ ] **Step 1: Add a sub-section under quick start for AI Gateway access**

Locate the end of the `## クイックスタート（利用するだけ）` section. Insert before `## セットアップ（開発する場合）`:

````markdown
### Cloudflare AI Gateway 経由で利用する

管理者が OCTG を Cloudflare AI Gateway の **Custom Provider** として登録している場合、クライアントは Gateway A のエンドポイントを向けます。

```text
base URL: https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_a_id}/custom-octg/v1
API Key:  <発行された octg_sk_xxx>
追加ヘッダー: cf-aig-authorization: Bearer <Gateway A Run token>
```

詳細なセットアップ手順とトラブルシューティングは [docs/cloudflare-ai-gateway-custom-provider.md](./docs/cloudflare-ai-gateway-custom-provider.md) を参照してください。
````

- [ ] **Step 2: Validate README links**

Run:

```bash
npx markdownlint-cli2 README.md
```

Expected: zero errors (or only pre-existing errors; do not introduce new ones).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README links to AI Gateway Custom Provider runbook"
```

---

### Task 3: Append Custom Provider note to deploy template guide

**Files:**
- Modify: `docs/DEPLOY_FROM_TEMPLATE.md` (append near the end, before "Template repository 利用時の留意点")

**Interfaces:**
- Consumes: `docs/cloudflare-ai-gateway-custom-provider.md` created in Task 1.
- Produces: A note telling deployers how to expose the new instance through AI Gateway.

- [ ] **Step 1: Insert the note**

Locate the line starting with `## Template repository 利用時の留意点`. Insert before it:

```markdown
## Custom Provider として AI Gateway 経由で公開する

初回デプロイ後、OCTG を Cloudflare AI Gateway の Custom Provider として登録して利用者に配布できます。
この場合は **Gateway A（受信側）と Gateway B（OpenAI 送信側）を別の AI Gateway インスタンスにすること** が必須です。同一 Gateway ID に Gateway A の `custom-octg` エンドポイントと Gateway B の `/openai` エンドポイントを混在させると、OCTG Worker が Gateway A へ outbound した際にルーティングループするリスクがあります。

詳細は [docs/cloudflare-ai-gateway-custom-provider.md](../docs/cloudflare-ai-gateway-custom-provider.md) を参照してください。
```

- [ ] **Step 2: Validate the deploy guide**

Run:

```bash
npx markdownlint-cli2 docs/DEPLOY_FROM_TEMPLATE.md
```

Expected: zero errors (or only pre-existing errors).

- [ ] **Step 3: Commit**

```bash
git add docs/DEPLOY_FROM_TEMPLATE.md
git commit -m "docs: add AI Gateway Custom Provider note to deploy guide"
```

---

### Task 4: Verify no unintended code drift

**Files:**
- Read: `apps/gateway-worker/src/upstream.ts`
- Run: `npm run typecheck`

**Interfaces:**
- Consumes: Existing worker code.
- Produces: Confirmation that the documentation-only plan does not break the build.

- [ ] **Step 1: Re-read the outbound header logic**

Confirm `apps/gateway-worker/src/upstream.ts` uses:

```typescript
"cf-aig-authorization": `Bearer ${env.OCTG_UPSTREAM_API_TOKEN}`,
```

- [ ] **Step 2: Remove the obsolete header caveat in the runbook**

The `cf-aig-authorization` header is already implemented. Delete any note in `docs/cloudflare-ai-gateway-custom-provider.md` that says the Worker still uses `Authorization` or needs a future switch.

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: exits 0.

- [ ] **Step 4: Run tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add docs/cloudflare-ai-gateway-custom-provider.md
git commit -m "docs: note outbound header caveat for Gateway B"
```

---

## Self-Review

**1. Spec coverage:**

- Background / purpose → runbook introduction covers why.
- Approach 2 (docs + curl + troubleshooting) → Tasks 1 and 2.
- Prerequisites → Task 1 Step 2.
- Architecture diagram and Gateway A/B split rationale → Task 1 Step 1 and Task 3.
- Communication contract (client → Gateway A, Gateway A → Worker, Worker → Gateway B) → Task 1 Steps 3–5 and caveat.
- Setup procedure → Task 1 Step 3.
- OCTG-side checks → Task 1 Step 4.
- Verification (non-streaming, streaming, checkpoints) → Task 1 Step 5.
- Troubleshooting → Task 1 Step 6.
- Token rotation / leak handling → Task 1 Step 7.
- Log policy → Task 1 Step 7.
- Out-of-scope items listed at §9 are not implemented, only documented as future changes.

**2. Placeholder scan:**

- No "TBD", "TODO", "implement later" placeholders.
- Every code/command step contains exact file paths, exact command lines, and expected outputs.
- "Similar to Task N" does not appear.

**3. Type consistency:**

- No new TypeScript types or functions are introduced. Documentation only.
- File paths are consistent across tasks.

**Confirmed:** The design spec §5.3 requirement is satisfied. `apps/gateway-worker/src/upstream.ts` sends `cf-aig-authorization: Bearer <Gateway B Run token>`, and `apps/gateway-worker/test/proxy.test.ts` asserts it. No code change is needed.
