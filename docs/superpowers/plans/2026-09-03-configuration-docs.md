# Secrets and Variables Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Make `docs/CONFIGURATION.md` the clear single source of truth for
Secrets and Variables used by first-time OCTG deployers.

**Architecture:** Keep the complete catalog and first-deploy flow in
`docs/CONFIGURATION.md`. Reduce `README.md`, `docs/DEPLOY_FROM_TEMPLATE.md`,
and `docs/deno-tokenizer.md` to their document-specific procedures and links
to the catalog. Preserve all Production/Preview and runtime/deployment-secret
boundaries.

**Tech Stack:** Markdown, `markdownlint-cli2`, repository-local link checks.

## Global Constraints

- The primary reader is a first-time deploy operator.
- `docs/CONFIGURATION.md` is the only complete Secrets/Variables catalog.
- `DENO_DEPLOY_TOKEN` is Deno Deploy management authentication, not tokenizer
  HTTP authentication.
- `DENO_TOKENIZER_AUTH_TOKEN` and `OCTG_TOKENIZER_AUTH_TOKEN` use the same
  value but different services and names.
- Production and Preview use separate Accounts, Workers, D1 databases,
  Gateways, peppers, client keys, and Deno applications.
- Never include real Secret values, raw client keys, or personal account
  identifiers in documentation.
- Do not stage `deno.env` or the pre-existing untracked `deno.lock`.

---

### Task 1: Rewrite the canonical configuration catalog

**Files:**

- Modify: `docs/CONFIGURATION.md:155-303`

**Interfaces:**

- Consumes: Existing local, Production, Preview, Deno Deploy, and canary
  variable definitions.
- Produces: One catalog with `Name`, `Kind`, `Consumer`, `Set in`,
  `Obtain or decide`, and `Apply` information.

- [ ] **Step 1: Replace the fragmented catalog sections**

Keep the existing local and Preview-specific values, but introduce a short
opening rule block and use one consistent table shape. Group entries under
these scopes in this order:

1. Local development
2. Production Cloudflare deploy authentication
3. Production Worker runtime
4. Production Deno integration
5. Deno Deploy CI
6. Production canary
7. Preview

For the Deno integration group, state exactly:

```text
DENO_TOKENIZER_ENDPOINT                 Worker Variable
DENO_TOKENIZER_THRESHOLD_BYTES          Worker Variable
DENO_TOKENIZER_TIMEOUT_MS               Worker Variable
DENO_TOKENIZER_AUTH_TOKEN               Worker Secret
OCTG_TOKENIZER_AUTH_TOKEN               Deno Deploy runtime Secret
```

Explain immediately below the group that the two auth names contain the same
value, while `DENO_DEPLOY_TOKEN` is a separate CI management Secret.

- [ ] **Step 2: Add the linear first-deploy procedure**

Place a Quick start before the detailed catalog. Use this exact operational
order: prepare Cloudflare credentials, register Worker runtime Secrets,
configure Deno Deploy CI values, configure the Deno runtime Secret, configure
Worker Deno vars and matching Secret, deploy the Worker, seed a client with
the existing Production pepper, then run the canary.

State that a `wrangler secret put` operation alone can create a version without
the vars from `wrangler.jsonc`; after changing runtime Secrets, run
`wrangler deploy --config apps/gateway-worker/wrangler.jsonc` so the active
version contains both vars and Secret bindings.

- [ ] **Step 3: Consolidate rotation and troubleshooting links**

Keep complete rotation rules in this document and link to service-specific
details. Include checks for missing variables, mismatched Deno auth values,
missing active-version bindings, and Production/Preview mixing.

### Task 2: Reduce README configuration duplication

**Files:**

- Modify: `README.md:1-11, 245-510, 580-700`

**Interfaces:**

- Consumes: The canonical catalog and first-deploy flow from `docs/CONFIGURATION.md`.
- Produces: A short README setup entry point with no duplicate complete catalog.

- [ ] **Step 1: Keep the README as an entry point**

Retain the short links near the beginning and add one explicit sentence:
`Secrets/Variablesの完全な一覧と設定順序は docs/CONFIGURATION.md を参照してください。`

- [ ] **Step 2: Remove duplicate full tables and conflicting commands**

Replace repeated Production, Preview, Deno, and canary catalog tables with
links and document-specific prerequisites. Keep only the minimum command
needed to start the linked procedure, without real values or raw keys.

- [ ] **Step 3: Preserve security-critical warnings**

Retain warnings about never committing Secrets, raw `octg_sk_*` keys, or
OpenAI keys, and retain the Production/Preview separation rule.

### Task 3: Simplify template deployment and Deno-specific documentation

**Files:**

- Modify: `docs/DEPLOY_FROM_TEMPLATE.md:1-220, 290-335`
- Modify: `docs/deno-tokenizer.md:1-190, 210-270`

**Interfaces:**

- Consumes: The canonical catalog in `docs/CONFIGURATION.md`.
- Produces: Focused procedures with no duplicated complete Secret/Variable lists.

- [ ] **Step 1: Refocus template deployment documentation**

Keep template-specific resource creation and deployment order. Replace the
large repeated Secret table with a link to `CONFIGURATION.md` and a concise
statement that Cloudflare Worker Secrets are configured there. Keep the safe
0600 client-key handoff procedure because it is specific to template setup.

- [ ] **Step 2: Refocus Deno tokenizer documentation**

Keep the Deno runtime contract, health check, endpoint behavior, and failure
semantics. Replace the common setup catalog with a link to
`CONFIGURATION.md`; retain only the Deno-specific distinction between the
runtime Secret and the GitHub Actions deployment Secret.

- [ ] **Step 3: Check cross-document terminology**

Use `Worker Secret`, `Deno Deploy runtime Secret`, `GitHub Environment
Secret`, and `Variable` consistently. Do not call `DENO_DEPLOY_TOKEN` a
runtime token.

### Task 4: Validate reader-facing documentation

**Files:**

- Test: `docs/CONFIGURATION.md`
- Test: `README.md`
- Test: `docs/DEPLOY_FROM_TEMPLATE.md`
- Test: `docs/deno-tokenizer.md`

**Interfaces:**

- Consumes: The four edited documents and their relative links.
- Produces: Lint-clean, internally consistent documentation.

- [ ] **Step 1: Run Markdown validation**

Run:

```bash
npx markdownlint-cli2 README.md docs/CONFIGURATION.md \
  docs/DEPLOY_FROM_TEMPLATE.md docs/deno-tokenizer.md
```

Expected: zero errors and zero warnings.

- [ ] **Step 2: Search for duplicated or ambiguous names**

Run:

```bash
rg -n \
  -e 'DENO_DEPLOY_TOKEN' \
  -e 'DENO_TOKENIZER_AUTH_TOKEN' \
  -e 'OCTG_TOKENIZER_AUTH_TOKEN' \
  -e 'OCTG_KEY_PEPPER' \
  README.md docs/CONFIGURATION.md docs/DEPLOY_FROM_TEMPLATE.md docs/deno-tokenizer.md
```

Review every hit and remove complete duplicate tables or statements that
contradict the canonical catalog. Repeated links and service-specific
explanations are allowed.

- [ ] **Step 3: Verify links and placeholders**

Check every relative link in the four documents resolves to an existing file,
and confirm no real Secret, raw client key, personal account identifier, or
`TODO`/`TBD` placeholder appears.

### Task 5: Commit and publish the documentation change

**Files:**

- Modify: `docs/CONFIGURATION.md`
- Modify: `README.md`
- Modify: `docs/DEPLOY_FROM_TEMPLATE.md`
- Modify: `docs/deno-tokenizer.md`

**Interfaces:**

- Consumes: Validated documentation changes from Tasks 1-4.
- Produces: A commit pushed to `feature/deno-tokenizer-canary`.

- [ ] **Step 1: Inspect the final diff**

Run `GIT_MASTER=1 git status`, `GIT_MASTER=1 git diff --check`, and
`GIT_MASTER=1 git diff --stat`. Stage only the four documentation files.
Do not stage `deno.env` or `deno.lock`.

- [ ] **Step 2: Commit the documentation change**

Use:

```bash
GIT_MASTER=1 git commit -m "docs: SecretsとVariablesの設定手順を整理"
```

- [ ] **Step 3: Push and verify tracking**

Use:

```bash
GIT_MASTER=1 git push
GIT_MASTER=1 git status --short --branch
```

Expected: the feature branch tracks its origin branch and no intended
documentation changes remain unstaged.
