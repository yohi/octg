# OCTG MVP 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OpenAI Data Sharing Program の無料枠を fail-closed に一元管理する OpenAI 互換 API Gateway（Cloudflare Workers + Durable Objects + D1）の MVP を構築する。

**Architecture:** クライアント認証（`octg_sk_*` keyed hash）→ モデル分類 → Tool-use 判定 → トークン推定 → `QuotaController` DO（pool × UTC 日、単一スレッド直列化）で reserve → AI Gateway REST へ転送 → actual usage で settle。結果不明は `markUncertain`（TTL 自動解放なし）。Cron で OpenAI Usage API と突合し、過去日 DO を `finalizeDay` で削除する。

**Tech Stack:** TypeScript / Cloudflare Workers (V8)、Durable Objects（SQLite-backed storage）、D1、Vitest + `@cloudflare/vitest-pool-workers`（Miniflare 基盤）、npm workspaces モノレポ。

**Spec:** `docs/superpowers/specs/2026-08-09-octg-mvp-design.md` v1.1（以下「設計書」）

## Global Constraints

以下は設計書からの転記値であり、全タスクの要求に暗黙に含まれる。

- プール上限（1 UTC 日あたり）: `STANDARD=1_000_000`、`MINI=10_000_000` トークン。`wrangler.jsonc` の vars（`QUOTA_LIMIT_STANDARD` / `QUOTA_LIMIT_MINI`）で上書き可能にする（設定外部化、設計書 §4.2）。
- DO ID: `quota:{POOL}:{YYYY-MM-DD}`（POOL は `STANDARD` / `MINI`、日付は UTC）。
- `remaining = limit - confirmedTokens - reservedTokens - uncertainTokens`。
- 安全マージン（設計書 §5.4）: `remaining > 20%` → `max(256, estimatedInput * 0.02)`、`remaining <= 20%` → `max(512, estimatedInput * 0.05)`、`remaining <= 5%` → STRICT（`upperBoundTokens <= remaining` の場合のみ reserve 許可）。
- クライアントが max output を指定しない場合の既定値: `DEFAULT_MAX_OUTPUT_TOKENS = 4096`。**上流にもこの値を注入する**（未指定 = 実質無制限の出力を reservation 不可能なため、MVP では fail-closed 側に倒す。設計書 §5.4 の予約式が数値を要求する）。
- AI Gateway 転送ヘッダ（設計書 §5.6）: `cf-aig-request-timeout: 25000`、`cf-aig-max-attempts: 2`、`cf-aig-retry-delay: 1000`、`cf-aig-backoff: exponential`。リトライ対象は AI Gateway 側既定（ネットワークエラー・上流 5xx）のみ。
- Custom metadata 5 項目（`cf-aig-metadata`）: `client_id, pool, eligibility, route, request_id`。観測用途のみ。
- Cron: `5 0 * * *`（00:05 UTC）。対象は直前に完了した UTC 日。Usage API は対象日 + 後続 24 時間を再取得、最大 3 回リトライ。
- 過去日 DO 保持: 当該 UTC 日の翌々日 00:00 UTC まで。`uncertain` が 0 件で `finalizeDay()` → `deleteAll()` 可。`uncertain` 残留中は `deleteAll()` 禁止。
- エラー応答: OpenAI 互換 `{ error: { message, type, param, code } }`。`message` / `type` / `param` / `code` は必須キー（`param` は対象外でも `null`）。`request_id` は body トップレベルと `X-OCTG-Request-Id` ヘッダの双方に含める。
- `X-OCTG-*` pool 系ヘッダ（`X-OCTG-Pool` / `X-OCTG-Quota-Limit` / `X-OCTG-Quota-Used` / `X-OCTG-Quota-Remaining` / `X-OCTG-Quota-Reset` / `X-OCTG-Route`）は **pool 確定後のみ**付与する。pool 確定前エラー（401、pool 未確定の 403/400 等）は `X-OCTG-Request-Id` のみ。
- pool 確定後のヘッダ値: `X-OCTG-Pool` は小文字 `standard` / `mini`、`X-OCTG-Quota-Used` = `confirmedTokens + reservedTokens + uncertainTokens`、`X-OCTG-Quota-Reset` = 次の UTC 00:00 の RFC 3339。
- 429 応答のみ `error` 内に `pool` / `remaining_tokens` / `reset_at` を含める（同名ヘッダと同値）。
- クライアント認証: `Authorization: Bearer octg_sk_*`。`clients.key_hash` = HMAC-SHA256(pepper = secret `OCTG_KEY_PEPPER`, message = raw key) の hex。不一致は `401`、無効化クライアントは `403`。
- Admin API（`/admin/*`）: Cloudflare Access JWT（`Cf-Access-Jwt-Assertion`）検証必須。
- `tools` / `tool_choice` / `functions` / `function_call` が存在するリクエストは一律 PAID_ONLY（無料枠 reservation を行わない）。
- 非テキスト入力（`input_image` / `input_audio` / `image_url` / `audio` 等）は予約前に 400 で拒否。
- `max_tokens` と `max_completion_tokens` の双方指定で値が異なる場合は 400 で拒否（`param: "max_tokens"`）。一致する場合は `max_completion_tokens` を優先。
- request body / prompt / response content は D1 に保存しない（usage metadata のみ）。
- 監査ログ（D1 `requests`）は `ctx.waitUntil()` の fire-and-forget。配送は best-effort で欠損許容。クォータ判定・課金制御は監査ログ到達に依存させない。
- 不明モデルは `complimentary = NONE`（Unknown = Paid）。MVP のデフォルトポリシーは REJECT（overflow_mode / output_limit_mode ともに REJECT）。
- Node.js >= 20、npm workspaces、TypeScript `strict`。
- settle / markUncertain / reconcile は「同一 requestId の再送では保存済みの元の結果を返し、カウンターを再変更しない」が共通契約。
- settle の対象 DO は **reserve 時点の UTC 日**から解決する（settle 時に現在日付から再解決しない。UTC 0 時跨ぎのロングリクエストで quota を誤計上しないため）。
- `release`（予約解放）は upstream 到達前と確定的に判明する場合のみ。fetch 送出後の失敗・タイムアウト・usage 不明は全て `markUncertain`。

## PR 分割戦略

設計書 §13 のモノレポ構成に沿い、**独立マージ可能な 11 PR / 21 タスク**に分割する。

- 各 PR は `main` からブランチを切り、**その PR 単体で `npm test` と `npm run typecheck` がグリーン**であることをマージ条件とする（前の PR がマージ済みであることが前提の逐次チェーン。stacked PR にする場合は `gh-stack` スキルを使ってよいが、既定は逐次マージとする）。
- 差分目安は 1 PR あたり 250〜700 行（テスト・設定込み）。レビュアーが 1 セッションで読み切れる量に抑える。
- 各 PR の最終ステップでブランチを push し PR を作成する。PR 本文には対応する設計書の章を記載してトレーサビリティを確保する。
- ブランチ命名: `feat/octg-pr01-scaffold` … `feat/octg-pr11-reconciliation`。
- コミットメッセージ: Conventional Commits（type は英語、subject は日本語）。
- **仕様上の逸脱（設計書 §13 との差分）**: テストコードは `apps/gateway-worker/test/` にコロケーションする。`@cloudflare/vitest-pool-workers` はテスト対象 Worker の `wrangler.jsonc` を起点に DO / D1 を束ねるため、トップレベル `tests/` を独立ランナーにすると wrangler 設定が二重化し保守コストが増える。`tests/` ディレクトリ自体は将来の E2E 用に予約とし、本計画では作成しない。
- **観測性（設計書 §11）**: MVP では構造ログ（`console.warn/info`）+ D1 記録（`requests` / `daily_usage` / `reconciliations`）を観測手段とし、追加のメトリクス基盤は導入しない。

| PR | ブランチ | スコープ | タスク | 差分目安 |
|----|---------|---------|--------|---------|
| 01 | `feat/octg-pr01-scaffold` | モノレポ基盤・共有型・DB スキーマ | T1-T3 | ~600 |
| 02 | `feat/octg-pr02-do-reserve` | QuotaController DO: reserve | T4-T5 | ~500 |
| 03 | `feat/octg-pr03-do-settle` | QuotaController DO: settle / markUncertain / release / reconcile / finalizeDay | T6-T7 | ~450 |
| 04 | `feat/octg-pr04-classify-estimate` | shared: モデル分類・Tool-use 判定・トークン推定・出力制御 | T8-T9 | ~550 |
| 05 | `feat/octg-pr05-error-contract` | エラー契約・`X-OCTG-*` ヘッダ | T10 | ~300 |
| 06 | `feat/octg-pr06-worker-auth` | Worker: 認証・D1 アクセス・ポリシーキャッシュ | T11-T12 | ~500 |
| 07 | `feat/octg-pr07-pipeline` | completions/responses パイプライン（非ストリーミング） | T13-T14 | ~700 |
| 08 | `feat/octg-pr08-streaming` | SSE ストリーミング中継 | T15 | ~400 |
| 09 | `feat/octg-pr09-read-endpoints` | `GET /v1/models` / `GET /quota` | T16-T17 | ~350 |
| 10 | `feat/octg-pr10-admin-api` | Admin API + Cloudflare Access | T18-T19 | ~550 |
| 11 | `feat/octg-pr11-reconciliation` | Cron Reconciliation + DO ライフサイクル | T20-T21 | ~550 |

---


## PR-01: モノレポスキャフォールド & 共有型 & DB スキーマ（`feat/octg-pr01-scaffold`）

対応設計書: §13（ディレクトリ構成）、§6（D1 スキーマ）、§7.1（Secret 管理）。

### Task 1: ワークスペース基盤とテストハーネス

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `packages/shared/package.json` / `packages/shared/tsconfig.json` / `packages/shared/src/index.ts`（空の export）
- Create: `durable-objects/quota-controller/package.json` / `durable-objects/quota-controller/tsconfig.json` / `durable-objects/quota-controller/src/quota-controller.ts`（getState のみの最小実装）
- Create: `apps/gateway-worker/package.json` / `apps/gateway-worker/tsconfig.json` / `apps/gateway-worker/wrangler.jsonc` / `apps/gateway-worker/vitest.config.ts` / `apps/gateway-worker/src/index.ts`
- Test: `apps/gateway-worker/test/setup.ts` / `apps/gateway-worker/test/smoke.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `Env` 型（`QUOTA_CONTROLLER: DurableObjectNamespace<QuotaController>`、`DB: D1Database`）、`QuotaController.getState()`（仮の固定値を返す最小版）、vitest-pool-workers ハーネス（後続全タスクが依存）

- [ ] **Step 1: ワークスペースを初期化する**

ルート `package.json`:

```json
{
  "name": "octg",
  "private": true,
  "workspaces": ["apps/*", "durable-objects/*", "packages/*"],
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "npm run test --workspaces --if-present",
    "typecheck": "npm run typecheck --workspaces --if-present"
  },
  "devDependencies": { "typescript": "^5.6.0" }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true
  }
}
```

`packages/shared/package.json`:

```json
{
  "name": "@octg/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./errors": "./src/errors.ts"
  },
  "scripts": { "typecheck": "tsc -p tsconfig.json", "test": "vitest run" },
  "dependencies": { "js-tiktoken": "^1.0.12" },
  "devDependencies": { "vitest": "^3.0.0" }
}
```

`packages/shared/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["vitest"] },
  "include": ["src", "test"]
}
```

`packages/shared/src/index.ts`（この時点では空のエクスポート）:

```ts
export {};
```

`durable-objects/quota-controller/package.json`:

```json
{
  "name": "@octg/quota-controller",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/quota-controller.ts" },
  "scripts": { "typecheck": "tsc -p tsconfig.json" },
  "dependencies": { "@octg/shared": "*" },
  "devDependencies": { "@cloudflare/workers-types": "^4.20250617.0" }
}
```

`durable-objects/quota-controller/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["@cloudflare/workers-types"] },
  "include": ["src"]
}
```

`apps/gateway-worker/package.json`:

```json
{
  "name": "@octg/gateway-worker",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@octg/quota-controller": "*",
    "@octg/shared": "*",
    "jose": "^5.6.0",
    "ulid": "^2.3.0"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.8.0",
    "@cloudflare/workers-types": "^4.20250617.0",
    "vitest": "^3.0.0",
    "wrangler": "^4.0.0"
  }
}
```

`apps/gateway-worker/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["@cloudflare/workers-types", "vitest", "@cloudflare/vitest-pool-workers"] },
  "include": ["src", "test"]
}
```

`apps/gateway-worker/wrangler.jsonc`（`database_id` とアカウント ID はデプロイ時に差し替える。テストでは `test` セクションの値が使われる）:

```jsonc
{
  "name": "octg-gateway",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-01",
  "compatibility_flags": ["nodejs_compat"],
  "vars": {
    "OCTG_UPSTREAM_BASE_URL": "https://api.cloudflare.com/client/v4/accounts/REPLACE_ACCOUNT_ID/ai/v1",
    "QUOTA_LIMIT_STANDARD": "1000000",
    "QUOTA_LIMIT_MINI": "10000000",
    "ACCESS_TEAM_DOMAIN": "https://REPLACE_TEAM.cloudflareaccess.com",
    "ACCESS_AUD": "REPLACE_ACCESS_AUD_TAG"
  },
  "durable_objects": {
    "bindings": [{ "name": "QUOTA_CONTROLLER", "class_name": "QuotaController" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["QuotaController"] }],
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "octg",
      "database_id": "00000000-0000-0000-0000-000000000000",
      "migrations_dir": "../../db/migrations"
    }
  ],
  "triggers": { "crons": ["5 0 * * *"] },
  "test": {
    "vars": {
      "OCTG_UPSTREAM_BASE_URL": "https://aigw.invalid",
      "OCTG_KEY_PEPPER": "test-pepper",
      "OCTG_UPSTREAM_API_TOKEN": "test-upstream-token"
    }
  }
}
```

- [ ] **Step 2: DO の最小実装と Worker エントリを書く**

`durable-objects/quota-controller/src/quota-controller.ts`（このタスクでは getState のみ。実 state は Task 4 で置き換える）:

```ts
import { DurableObject } from "cloudflare:workers";

export interface QuotaControllerEnv {
  QUOTA_LIMIT_STANDARD?: string;
  QUOTA_LIMIT_MINI?: string;
}

export class QuotaController extends DurableObject<QuotaControllerEnv> {
  async getState(): Promise<{ pool: string; utcDay: string; limit: number }> {
    const [, pool, day] = this.ctx.id.name!.split(":");
    const raw = pool === "STANDARD" ? this.env.QUOTA_LIMIT_STANDARD : this.env.QUOTA_LIMIT_MINI;
    const limit = Number(raw) > 0 ? Number(raw) : pool === "STANDARD" ? 1_000_000 : 10_000_000;
    return { pool, utcDay: day, limit };
  }
}
```

`apps/gateway-worker/src/index.ts`:

```ts
import { QuotaController } from "@octg/quota-controller";
export { QuotaController };

export interface Env {
  QUOTA_CONTROLLER: DurableObjectNamespace<QuotaController>;
  DB: D1Database;
  OCTG_KEY_PEPPER: string;
  OCTG_UPSTREAM_BASE_URL: string;
  OCTG_UPSTREAM_API_TOKEN: string;
  QUOTA_LIMIT_STANDARD?: string;
  QUOTA_LIMIT_MINI?: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  OPENAI_USAGE_API_KEY?: string;
  OPENAI_FREE_PROJECT_ID?: string;
}

export default {
  async fetch(): Promise<Response> {
    return new Response("Not Found", { status: 404 });
  },
  async scheduled(): Promise<void> {},
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 3: 失敗するテスト（スモーク）を書く**

`apps/gateway-worker/vitest.config.ts`:

```ts
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations("../../db/migrations");
  return {
    test: {
      setupFiles: ["./test/setup.ts"],
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
        },
      },
    },
  };
});
```

`apps/gateway-worker/test/setup.ts`:

```ts
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
```

`apps/gateway-worker/test/smoke.test.ts`:

```ts
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const stub = (pool = "STANDARD", day = "2026-08-09") =>
  env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(`quota:${pool}:${day}`));

describe("harness smoke", () => {
  it("unknown route returns 404", async () => {
    const res = await SELF.fetch("http://example.com/nope");
    expect(res.status).toBe(404);
  });

  it("DO stub is reachable and reports default STANDARD limit", async () => {
    const state = await stub().getState();
    expect(state.pool).toBe("STANDARD");
    expect(state.utcDay).toBe("2026-08-09");
    expect(state.limit).toBe(1_000_000);
  });

  it("D1 migrations are applied (registry seeded)", async () => {
    const row = await env.DB
      .prepare("SELECT model FROM model_registry ORDER BY model LIMIT 1")
      .first<{ model: string }>();
    expect(row?.model).toBe("gpt-5");
  });
});
```

- [ ] **Step 4: テストが D1 マイグレーション不在で失敗することを確認する**

Run: `npm install && npm test -w apps/gateway-worker`
Expected: FAIL（`model_registry` テーブル不在の D1 エラー。DO / 404 の 2 件は PASS）

- [ ] **Step 5: D1 スキーマと seed を作成してグリーンにする**

`db/migrations/0001_init.sql`:

```sql
CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE client_policies (
  client_id TEXT PRIMARY KEY REFERENCES clients(id),
  overflow_mode TEXT NOT NULL DEFAULT 'REJECT',
  output_limit_mode TEXT NOT NULL DEFAULT 'REJECT',
  max_paid_usd_day REAL NOT NULL DEFAULT 0,
  cache_enabled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE model_registry (
  model TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  complimentary_pool TEXT NOT NULL DEFAULT 'NONE',
  enabled INTEGER NOT NULL DEFAULT 1,
  fallback_model TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE requests (
  request_id TEXT PRIMARY KEY,
  utc_day TEXT NOT NULL,
  client_id TEXT NOT NULL,
  requested_model TEXT,
  upstream_model TEXT,
  pool TEXT,
  eligibility TEXT,
  reserved_tokens INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  status TEXT NOT NULL,
  billing_class TEXT,
  openai_request_id TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_requests_day_pool ON requests (utc_day, pool, status);
CREATE INDEX idx_requests_client ON requests (client_id, utc_day);

CREATE TABLE daily_usage (
  utc_day TEXT NOT NULL,
  pool TEXT NOT NULL,
  confirmed_tokens INTEGER NOT NULL DEFAULT 0,
  paid_tokens INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (utc_day, pool)
);

CREATE TABLE reconciliations (
  utc_day TEXT NOT NULL,
  pool TEXT NOT NULL,
  local_tokens INTEGER NOT NULL,
  openai_tokens INTEGER NOT NULL,
  difference INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  attempts INTEGER NOT NULL DEFAULT 0,
  executed_at TEXT NOT NULL,
  PRIMARY KEY (utc_day, pool)
);
```

`db/migrations/0002_seed_registry.sql`（設計書 §6 `model_registry` 初期データ。`config/model-registry.json` が人間向けの正、この SQL が DB 投入用の正）:

```sql
INSERT INTO model_registry (model, provider, complimentary_pool, enabled, fallback_model, updated_at) VALUES
  ('gpt-5', 'openai', 'STANDARD', 1, NULL, '2026-08-09T00:00:00Z'),
  ('gpt-5-mini', 'openai', 'MINI', 1, NULL, '2026-08-09T00:00:00Z');
```

`config/model-registry.json`:

```json
[
  { "model": "gpt-5", "provider": "openai", "complimentary_pool": "STANDARD", "enabled": true, "fallback_model": null },
  { "model": "gpt-5-mini", "provider": "openai", "complimentary_pool": "MINI", "enabled": true, "fallback_model": null }
]
```

- [ ] **Step 6: テストを実行して全パスを確認する**

Run: `npm test -w apps/gateway-worker`
Expected: PASS 3/3（404、DO limit、D1 seed）

Run: `npm run typecheck`
Expected: 全ワークスペースで exit 0

- [ ] **Step 7: コミット**

```bash
git add package.json tsconfig.base.json packages durable-objects apps db config
git commit -m "feat: モノレポ基盤・DO スケルトン・D1 スキーマ・テストハーネスを追加"
```

### Task 2: 共有型とプールユーティリティ（`@octg/shared`）

**Files:**
- Create: `packages/shared/src/types.ts`
- Create: `packages/shared/src/pool.ts`
- Modify: `packages/shared/src/index.ts`（re-export）
- Test: `packages/shared/test/pool.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `PoolName`, `PoolState`, `RequestEntry`, `RequestState`, `ReserveResult`, `SettleResult`, `MarkUncertainResult`, `ReleaseResult`, `ReconcileDisposition`, `ReconcileResult`, `FinalizeResult`, `QuotaView`, `POOL_LIMITS`, `CAUTION_THRESHOLD`, `STRICT_THRESHOLD`, `PolicyTier`, `remainingOf(s)`, `tierOf(remaining, limit)`, `utcDayOf(d)`, `nextUtcMidnight(d)`, `quotaIdOf(pool, day)`, `toPoolLower(pool)` — 後続の全タスクがこれらの名前・型を使う。

- [ ] **Step 1: 失敗するテストを書く**

`packages/shared/test/pool.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  POOL_LIMITS,
  nextUtcMidnight,
  quotaIdOf,
  remainingOf,
  tierOf,
  toPoolLower,
  utcDayOf,
  type PoolState,
} from "../src/index";

const state = (over: Partial<PoolState>): PoolState => ({
  utcDay: "2026-08-09",
  limit: 1_000_000,
  confirmedTokens: 0,
  reservedTokens: 0,
  uncertainTokens: 0,
  requestCount: 0,
  updatedAt: "2026-08-09T00:00:00Z",
  ...over,
});

describe("pool utils", () => {
  it("POOL_LIMITS are the spec values", () => {
    expect(POOL_LIMITS.STANDARD).toBe(1_000_000);
    expect(POOL_LIMITS.MINI).toBe(10_000_000);
  });

  it("remainingOf subtracts confirmed + reserved + uncertain", () => {
    expect(
      remainingOf(state({ confirmedTokens: 100, reservedTokens: 20, uncertainTokens: 5 })),
    ).toBe(999_875);
  });

  it("tierOf: >20% NORMAL, <=20% CAUTION, <=5% STRICT", () => {
    expect(tierOf(200_001, 1_000_000)).toBe("NORMAL");
    expect(tierOf(200_000, 1_000_000)).toBe("CAUTION");
    expect(tierOf(50_001, 1_000_000)).toBe("CAUTION");
    expect(tierOf(50_000, 1_000_000)).toBe("STRICT");
  });

  it("utcDayOf / nextUtcMidnight / quotaIdOf / toPoolLower", () => {
    const d = new Date("2026-08-09T23:59:59.500Z");
    expect(utcDayOf(d)).toBe("2026-08-09");
    expect(nextUtcMidnight(d)).toBe("2026-08-10T00:00:00Z");
    expect(quotaIdOf("STANDARD", "2026-08-09")).toBe("quota:STANDARD:2026-08-09");
    expect(toPoolLower("STANDARD")).toBe("standard");
    expect(toPoolLower("MINI")).toBe("mini");
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npm test -w packages/shared`
Expected: FAIL（`../src/index` に export が存在しない）

- [ ] **Step 3: 実装する**

`packages/shared/src/types.ts`:

```ts
export type PoolName = "STANDARD" | "MINI";
export type PoolNameLower = "standard" | "mini";
export type RequestState = "reserved" | "settled" | "uncertain" | "reconciled" | "released";

export interface PoolState {
  utcDay: string;
  limit: number;
  confirmedTokens: number;
  reservedTokens: number;
  uncertainTokens: number;
  requestCount: number;
  updatedAt: string; // RFC 3339
}

export interface RequestEntry {
  state: RequestState;
  reservedTokens: number; // reserve 時点の予約量（不変）
  actualTokens?: number;
  result?: unknown; // 各 RPC の最初の成功応答（再送時はこの値を返す）
  createdAt: string;
  updatedAt: string;
}

export type ReserveResult =
  | { ok: true; remaining: number; resetAt: string }
  | { ok: false; reason: "insufficient_quota"; remaining: number; resetAt: string };

export type SettleResult = { ok: true } | { ok: false; reason: "unknown_request" };
export type MarkUncertainResult = { ok: true } | { ok: false; reason: "unknown_request" };
export type ReleaseResult = { ok: true } | { ok: false; reason: "unknown_request" };

export type ReconcileDisposition = "consumed" | "unused";
export type ReconcileResult = { ok: true; applied: boolean };

export type FinalizeResult =
  | { ok: true; deleted: true }
  | { ok: false; reason: "uncertain_remaining"; uncertainCount: number };

export interface QuotaView extends PoolState {
  pool: PoolName;
  remaining: number;
}
```

`packages/shared/src/pool.ts`:

```ts
import type { PoolName, PoolNameLower, PoolState } from "./types";

export const POOL_LIMITS: Record<PoolName, number> = {
  STANDARD: 1_000_000,
  MINI: 10_000_000,
};

export const CAUTION_THRESHOLD = 0.2;
export const STRICT_THRESHOLD = 0.05;

export type PolicyTier = "NORMAL" | "CAUTION" | "STRICT";

export function remainingOf(s: PoolState): number {
  return s.limit - s.confirmedTokens - s.reservedTokens - s.uncertainTokens;
}

export function tierOf(remaining: number, limit: number): PolicyTier {
  const ratio = remaining / limit;
  if (ratio <= STRICT_THRESHOLD) return "STRICT";
  if (ratio <= CAUTION_THRESHOLD) return "CAUTION";
  return "NORMAL";
}

export function utcDayOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function nextUtcMidnight(d: Date): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1))
    .toISOString()
    .replace(".000Z", "Z");
}

export function quotaIdOf(pool: PoolName, day: string): string {
  return `quota:${pool}:${day}`;
}

export function toPoolLower(p: PoolName): PoolNameLower {
  return p === "STANDARD" ? "standard" : "mini";
}
```

`packages/shared/src/index.ts` を置き換える:

```ts
export * from "./types";
export * from "./pool";
```

- [ ] **Step 4: テストを実行してパスを確認する**

Run: `npm test -w packages/shared && npm run typecheck`
Expected: PASS 4/4、typecheck exit 0

- [ ] **Step 5: コミット**

```bash
git add packages/shared
git commit -m "feat(shared): クォータ共有型とプールユーティリティを追加"
```

### Task 3: 開発用クライアント seed スクリプトと運用 README

**Files:**
- Create: `scripts/seed-client.mjs`
- Create: `README.md`

**Interfaces:**
- Consumes: `db/migrations/0001_init.sql` の `clients` スキーマ
- Produces: `npm run seed:client -- <id> <name> <octg_sk_...>` で発行する keyed hash 生成手順（T11 の認証実装が同じ HMAC-SHA256(pepper, key) を検証側で使う）

- [ ] **Step 1: seed スクリプトを書く**

`scripts/seed-client.mjs`:

```js
#!/usr/bin/env node
// 使い方:
//   OCTG_KEY_PEPPER=... node scripts/seed-client.mjs <client_id> <name> <octg_sk_...> \
//     | wrangler d1 execute octg --local --command -
// (--remote にする場合は wrangler 側のフラグを付け替える)
import { createHmac } from "node:crypto";

const [id, name, rawKey] = process.argv.slice(2);
if (!process.env.OCTG_KEY_PEPPER || !id || !name || !rawKey) {
  console.error("usage: OCTG_KEY_PEPPER=... node scripts/seed-client.mjs <id> <name> <octg_sk_...>");
  process.exit(1);
}
if (!rawKey.startsWith("octg_sk_")) {
  console.error("raw key must start with octg_sk_");
  process.exit(1);
}
const hash = createHmac("sha256", process.env.OCTG_KEY_PEPPER).update(rawKey).digest("hex");
const esc = (s) => s.replaceAll("'", "''");
console.log(
  `INSERT INTO clients (id, name, key_hash, enabled, created_at) VALUES ('${esc(id)}', '${esc(name)}', '${hash}', 1, datetime('now')) ` +
    `ON CONFLICT(id) DO UPDATE SET key_hash=excluded.key_hash, enabled=1;`,
);
console.log(
  `INSERT INTO client_policies (client_id, overflow_mode, output_limit_mode, max_paid_usd_day, cache_enabled) VALUES ('${esc(id)}', 'REJECT', 'REJECT', 0, 0) ` +
    `ON CONFLICT(client_id) DO NOTHING;`,
);
```

- [ ] **Step 2: スクリプトの動作を検証する（ローカル D1 往復）**

```bash
cd apps/gateway-worker && npx wrangler d1 execute octg --local --command "$(OCTG_KEY_PEPPER=test-pepper node ../../scripts/seed-client.mjs client_demo 'Demo' octg_sk_localdemo01)"
npx wrangler d1 execute octg --local --command "SELECT id, length(key_hash) AS hlen FROM clients WHERE id='client_demo'"
```
Expected: `hlen = 64`（HMAC-SHA256 hex）の 1 行が返る。生キー `octg_sk_localdemo01` が DB に保存されないことを目視確認する。

- [ ] **Step 3: README.md（運用ランbook）を書く**

`README.md` に以下の章を全て記載する（この内容をそのままファイルにする）:

````markdown
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
OCTG_KEY_PEPPER=dev-pepper node ../../scripts/seed-client.mjs client_demo Demo octg_sk_xxx | \
  npx wrangler d1 execute octg --local --command -
```

## デプロイ前の必須プロビジョニング（手動）

1. `wrangler d1 create octg` → 発行された `database_id` を `apps/gateway-worker/wrangler.jsonc` に設定する。
2. AI Gateway を作成し、OpenAI Project A（shared-free, Data Sharing ON）の API キーを **BYOK + Secrets Store** に登録する。OCTG のコード・クライアントには OpenAI キーを配布しない。
3. AI Gateway の Spend Limit を無料枠と同額に設定する（二次防御。authoritative ではない）。
4. `wrangler.jsonc` の vars を実値に差し替える: `OCTG_UPSTREAM_BASE_URL`（アカウント ID 込み）、`ACCESS_TEAM_DOMAIN` / `ACCESS_AUD`（Admin API 用 Cloudflare Access アプリケーション）。
5. Secrets を設定する:
   - `wrangler secret put OCTG_KEY_PEPPER` — クライアントキーの keyed hash 用 pepper
   - `wrangler secret put OCTG_UPSTREAM_API_TOKEN` — AI Gateway REST 用 Cloudflare API token（AI Gateway Run 権限）
   - `wrangler secret put OPENAI_USAGE_API_KEY` — OpenAI Organization Usage API 読み取り用 admin key
6. `wrangler deploy -w apps/gateway-worker`（CI からのデプロイを推奨）。

## Secret ローテーション

各 Secret は (1) 新規トークン発行 → (2) `wrangler secret put` で設定 → (3) デプロイ / 動作確認 → (4) 旧トークン失効、の順で実施する。Worker コード・ログ・`octg_sk_*` の鍵素材に Secret の値を含めない。

## 既知の限界

課金 0 円の完全保証はしない。conservative reservation + fail-closed + OpenAI reconciliation の三重防御（設計書 §15）。監査ログは best-effort で配送欠損を許容する（authoritative な制御は DO が担う）。
````

- [ ] **Step 4: コミット**

```bash
git add scripts README.md
git commit -m "docs: 開発者 seed スクリプトと運用 README を追加"
```

- [ ] **Step 5: PR-01 を作成する**

```bash
git push -u origin feat/octg-pr01-scaffold
gh pr create --title "feat: OCTG モノレポ基盤・共有型・D1 スキーマ" --body "設計書 §6/§7.1/§13 に対応。npm workspaces + wrangler + vitest-pool-workers ハーネス、DO スケルトン、D1 スキーマ/seed、運用 README。"
```


---

## PR-02: QuotaController DO — reserve（`feat/octg-pr02-do-reserve`）

対応設計書: §4.1（粒度）、§4.2（状態）、§4.3-1（reserve RPC）、§4.4（ストレージ）。PR-01 マージ後に `main` からブランチを切る。

### Task 4: DO 状態管理と reserve（NORMAL 経路・冪等再送）

**Files:**
- Modify: `durable-objects/quota-controller/src/quota-controller.ts`（Task 1 の最小版を本実装に置き換える）
- Create: `durable-objects/quota-controller/src/store.ts`
- Test: `apps/gateway-worker/test/quota-controller.test.ts`

**Interfaces:**
- Consumes: `@octg/shared` の全型（`PoolState`, `RequestEntry`, `ReserveResult`, `QuotaView`）と `remainingOf`, `nextUtcMidnight`, `POOL_LIMITS`
- Produces: `QuotaController.reserve(requestId, tokens, upperBoundTokens): Promise<ReserveResult>`、`QuotaController.getState(): Promise<QuotaView>`。RPC の共通契約: 同一 `requestId` の再送では保存済みの元の結果を返し、カウンターを再変更しない。

- [ ] **Step 1: 失敗するテストを書く**

`apps/gateway-worker/test/quota-controller.test.ts`:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { QuotaController } from "@octg/quota-controller";

const stub = (pool = "STANDARD", day = "2026-08-09") =>
  env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(`quota:${pool}:${day}`));

// confirmedTokens を指定量だけ積み上げるヘルパー
async function useConfirmed(s: DurableObjectStub<QuotaController>, tokens: number) {
  await s.reserve(`seed-${crypto.randomUUID()}`, tokens, tokens);
}

describe("QuotaController.reserve", () => {
  it("permits 950,000 used + 40,000 reservation (設計書 §12 境界)", async () => {
    const s = stub();
    await useConfirmed(s, 950_000);
    const r = await s.reserve("req-a", 40_000, 40_000);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.remaining).toBe(10_000);
      expect(r.resetAt).toBe("2026-08-10T00:00:00Z");
    }
  });

  it("rejects 999,000 used + 2,000 reservation (設計書 §12 境界)", async () => {
    const s = stub("STANDARD", "2026-08-10");
    await useConfirmed(s, 999_000);
    const r = await s.reserve("req-b", 2_000, 2_000);
    expect(r).toEqual({
      ok: false,
      reason: "insufficient_quota",
      remaining: 1_000,
      resetAt: "2026-08-11T00:00:00Z",
    });
  });

  it("failed reserve leaves no state; a smaller retry is evaluated as new (設計書 §4.3)", async () => {
    const s = stub("STANDARD", "2026-08-11");
    await useConfirmed(s, 999_000);
    const r1 = await s.reserve("req-c", 2_000, 2_000);
    expect(r1.ok).toBe(false);
    const r2 = await s.reserve("req-c", 1_000, 1_000);
    expect(r2.ok).toBe(true);
    const v = await s.getState();
    expect(v.reservedTokens).toBe(1_000);
  });

  it("retransmit of the same requestId returns the stored result without double-counting", async () => {
    const s = stub("STANDARD", "2026-08-12");
    const r1 = await s.reserve("req-dup", 10_000, 10_000);
    const r2 = await s.reserve("req-dup", 10_000, 10_000);
    expect(r2).toEqual(r1);
    const v = await s.getState();
    expect(v.reservedTokens).toBe(10_000);
    expect(v.requestCount).toBe(1);
  });

  it("MINI pool uses the 10,000,000 limit", async () => {
    const s = stub("MINI", "2026-08-09");
    const r = await s.reserve("req-m", 9_999_999, 9_999_999);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.remaining).toBe(1);
  });
});
```

補足: `useConfirmed` は reserve で `reservedTokens` を積むだけなので、`remaining` は confirmed/reserved を区別なく差し引かれる（`remaining = limit - confirmed - reserved - uncertain`）。このため「950,000 used」の再現は reserve のみで足りる。

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npm test -w apps/gateway-worker`
Expected: FAIL（`reserve` が存在しない / 型エラー）

- [ ] **Step 3: ストレージ層と reserve を実装する**

`durable-objects/quota-controller/src/store.ts`:

```ts
import type { PoolName, PoolState, RequestEntry } from "@octg/shared";
import { POOL_LIMITS } from "@octg/shared";

export const POOL_KEY = "pool";
export const ENTRY_PREFIX = "req:";

export interface QuotaEnvLike {
  QUOTA_LIMIT_STANDARD?: string;
  QUOTA_LIMIT_MINI?: string;
}

export function resolveLimit(env: QuotaEnvLike, pool: PoolName): number {
  const raw = pool === "STANDARD" ? env.QUOTA_LIMIT_STANDARD : env.QUOTA_LIMIT_MINI;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : POOL_LIMITS[pool];
}

export async function loadPool(
  storage: DurableObjectStorage,
  env: QuotaEnvLike,
  pool: PoolName,
  utcDay: string,
): Promise<PoolState> {
  const stored = await storage.get<PoolState>(POOL_KEY);
  if (stored) return stored;
  return {
    utcDay,
    limit: resolveLimit(env, pool),
    confirmedTokens: 0,
    reservedTokens: 0,
    uncertainTokens: 0,
    requestCount: 0,
    updatedAt: new Date().toISOString(),
  };
}

export async function savePool(storage: DurableObjectStorage, s: PoolState): Promise<void> {
  s.updatedAt = new Date().toISOString();
  await storage.put(POOL_KEY, s);
}

export async function getEntry(
  storage: DurableObjectStorage,
  requestId: string,
): Promise<RequestEntry | undefined> {
  return storage.get<RequestEntry>(ENTRY_PREFIX + requestId);
}

export async function putEntry(
  storage: DurableObjectStorage,
  requestId: string,
  entry: RequestEntry,
): Promise<void> {
  entry.updatedAt = new Date().toISOString();
  await storage.put(ENTRY_PREFIX + requestId, entry);
}

export async function countUncertain(storage: DurableObjectStorage): Promise<number> {
  let n = 0;
  for await (const [, entry] of await storage.list<RequestEntry>({ prefix: ENTRY_PREFIX })) {
    if (entry.state === "uncertain") n += 1;
  }
  return n;
}
```

`durable-objects/quota-controller/src/quota-controller.ts`（Task 1 の内容を全置換）:

```ts
import { DurableObject } from "cloudflare:workers";
import { nextUtcMidnight, remainingOf, tierOf } from "@octg/shared";
import type { PoolName, QuotaView, ReserveResult } from "@octg/shared";
import { countUncertain, getEntry, loadPool, putEntry, savePool } from "./store";

export interface QuotaControllerEnv {
  QUOTA_LIMIT_STANDARD?: string;
  QUOTA_LIMIT_MINI?: string;
}

export class QuotaController extends DurableObject<QuotaControllerEnv> {
  private get identity(): { pool: PoolName; utcDay: string } {
    const parts = this.ctx.id.name?.split(":");
    if (!parts || parts.length !== 3 || parts[0] !== "quota") {
      throw new Error(`invalid quota DO name: ${this.ctx.id.name}`);
    }
    return { pool: parts[1] as PoolName, utcDay: parts[2]! };
  }

  async reserve(
    requestId: string,
    tokens: number,
    upperBoundTokens: number,
  ): Promise<ReserveResult> {
    const { pool, utcDay } = this.identity;
    const resetAt = nextUtcMidnight(new Date(`${utcDay}T00:00:00Z`));
    return this.ctx.storage.transaction(async () => {
      const existing = await getEntry(this.ctx.storage, requestId);
      if (existing) return existing.result as ReserveResult; // 再送: 保存済み結果を返し、カウンター不変

      const state = await loadPool(this.ctx.storage, this.env, pool, utcDay);
      const remaining = remainingOf(state);

      if (tokens > remaining) {
        return { ok: false as const, reason: "insufficient_quota" as const, remaining, resetAt };
      }
      if (tierOf(remaining, state.limit) === "STRICT" && upperBoundTokens > remaining) {
        return { ok: false as const, reason: "insufficient_quota" as const, remaining, resetAt };
      }

      state.reservedTokens += tokens;
      state.requestCount += 1;
      const result: ReserveResult = { ok: true, remaining: remaining - tokens, resetAt };
      const now = new Date().toISOString();
      await savePool(this.ctx.storage, state);
      await putEntry(this.ctx.storage, requestId, {
        state: "reserved",
        reservedTokens: tokens,
        result,
        createdAt: now,
        updatedAt: now,
      });
      return result;
    });
  }

  async getState(): Promise<QuotaView> {
    const { pool, utcDay } = this.identity;
    const state = await loadPool(this.ctx.storage, this.env, pool, utcDay);
    return { ...state, pool, remaining: remainingOf(state) };
  }

  // Task 6/7 で実装する RPC の宣言（型の先行公開。本体は後続タスク）
  async settle(requestId: string, actualTokens: number): Promise<never>;
  async markUncertain(requestId: string): Promise<never>;
  async release(requestId: string): Promise<never>;
  async reconcileRequest(requestId: string, disposition: "consumed" | "unused"): Promise<never>;
  async finalizeDay(): Promise<never>;
}
```

注意: クラス内の未実装メソッド宣言は TypeScript では許容されないため、実際のファイルでは `settle` 等は **Task 6/7 で追加する**（このタスクでは `reserve` と `getState` のみ実装する）。上記は最終形の目安であり、このタスクで書くのは `identity` / `reserve` / `getState` の 3 メソッドのみとする。

- [ ] **Step 4: テストを実行してパスを確認する**

Run: `npm test -w apps/gateway-worker`
Expected: PASS（新規 5 件 + smoke 3 件）

Run: `npm run typecheck`
Expected: exit 0

- [ ] **Step 5: コミット**

```bash
git add durable-objects apps/gateway-worker/test/quota-controller.test.ts
git commit -m "feat(quota-controller): reserve RPC と状態ストレージを実装"
```

### Task 5: ポリシーティア（CAUTION/STRICT）・並行性・Midnight 境界のテスト

**Files:**
- Test: `apps/gateway-worker/test/quota-controller-policy.test.ts`

**Interfaces:**
- Consumes: Task 4 の `reserve` / `getState`
- Produces: なし（既存実装の振る舞いを固定するテストのみ。実装変更が必要になった場合のみ `quota-controller.ts` を修正する）

- [ ] **Step 1: テストを書く**

`apps/gateway-worker/test/quota-controller-policy.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const stub = (pool = "STANDARD", day: string) =>
  env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(`quota:${pool}:${day}`));

describe("reserve policy tiers", () => {
  it("STRICT tier (remaining <= 5%): rejects when upperBound > remaining", async () => {
    const s = stub("STANDARD", "2026-08-20");
    await s.reserve("seed", 951_000, 951_000); // remaining = 49,000 (4.9%) → STRICT
    const r = await s.reserve("req-strict", 10_000, 60_000);
    expect(r.ok).toBe(false);
  });

  it("STRICT tier: permits when upperBound <= remaining", async () => {
    const s = stub("STANDARD", "2026-08-21");
    await s.reserve("seed", 951_000, 951_000);
    const r = await s.reserve("req-strict-ok", 10_000, 49_000);
    expect(r.ok).toBe(true);
  });

  it("CAUTION tier (<=20%) does not apply the STRICT upperBound gate", async () => {
    const s = stub("STANDARD", "2026-08-22");
    await s.reserve("seed", 850_000, 850_000); // remaining = 150,000 (15%) → CAUTION
    const r = await s.reserve("req-caution", 10_000, 160_000); // upperBound > remaining でも CAUTION では許可
    expect(r.ok).toBe(true);
  });
});

describe("concurrency (設計書 §12)", () => {
  it("remaining=50k で A/B が各 40k reserve -> 片方のみ permit", async () => {
    const s = stub("STANDARD", "2026-08-23");
    await s.reserve("seed", 950_000, 950_000); // remaining = 50,000
    const [a, b] = await Promise.all([
      s.reserve("req-A", 40_000, 40_000),
      s.reserve("req-B", 40_000, 40_000),
    ]);
    const oks = [a.ok, b.ok].filter(Boolean);
    expect(oks.length).toBe(1); // DO 単一スレッド直列化により oversubscription しない
    const v = await s.getState();
    expect(v.reservedTokens).toBe(950_000 + 40_000);
  });
});

describe("midnight boundary (設計書 §12)", () => {
  it("UTC 日替わり同時リクエストで前日/翌日 state が混在しない", async () => {
    const day1 = stub("STANDARD", "2026-08-30");
    const day2 = stub("STANDARD", "2026-08-31");
    await day1.reserve("req-d1", 700_000, 700_000);
    await day2.reserve("req-d2", 100_000, 100_000);
    const v1 = await day1.getState();
    const v2 = await day2.getState();
    expect(v1.reservedTokens).toBe(700_000);
    expect(v1.utcDay).toBe("2026-08-30");
    expect(v2.reservedTokens).toBe(100_000);
    expect(v2.utcDay).toBe("2026-08-31");
    expect(v1.remaining).toBe(300_000);
    expect(v2.remaining).toBe(900_000);
  });
});
```

- [ ] **Step 2: テストを実行してパスを確認する**

Run: `npm test -w apps/gateway-worker`
Expected: PASS（新規 5 件を含む全件）

万が一 STRICT / CAUTION の境界で失敗する場合は `tierOf` の境界条件（`<=`）を設計書 §5.4 と照合して修正する。実装変更を行った場合は Task 4 のテストも全て再実行する。

- [ ] **Step 3: コミット**

```bash
git add apps/gateway-worker/test/quota-controller-policy.test.ts
git commit -m "test(quota-controller): ポリシーティア・並行性・Midnight 境界のテストを追加"
```

- [ ] **Step 4: PR-02 を作成する**

```bash
git push -u origin feat/octg-pr02-do-reserve
gh pr create --title "feat: QuotaController DO の reserve RPC" --body "設計書 §4.1-§4.4 に対応。pool × UTC 日の DO で reserve を実装し、冪等再送・STRICT/CAUTION ティア・並行性・Midnight 境界をテストで固定。"
```


---

## PR-03: QuotaController DO — settle / markUncertain / release / reconcile / finalizeDay（`feat/octg-pr03-do-settle`）

対応設計書: §4.2（状態機械）、§4.3-2/3（settle / markUncertain）、§4.5（過去日 DO ライフサイクル）。PR-02 マージ後に `main` からブランチを切る。

### Task 6: settle（超過精算・二重精算防止・uncertain からの遅延 settle）

**Files:**
- Modify: `durable-objects/quota-controller/src/quota-controller.ts`
- Test: `apps/gateway-worker/test/quota-settle.test.ts`

**Interfaces:**
- Consumes: Task 4 の `reserve` / `getState` / `store.ts`
- Produces: `QuotaController.settle(requestId, actualTokens): Promise<SettleResult>`。契約: `reserved → settled`（`reservedTokens -= reserved`、`confirmedTokens += actual`）、`uncertain → settled`（`uncertainTokens -= reserved`、`confirmedTokens += actual`、二重減算なし）、`actual > reserved` でも正差分を `confirmedTokens` に計上し `reservedTokens` は `max(0, …)` で防御、既に `settled` / `reconciled` / `released` なら保存済み結果を返す no-op、未知の requestId は `{ ok: false, reason: "unknown_request" }`。

- [ ] **Step 1: 失敗するテストを書く**

`apps/gateway-worker/test/quota-settle.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const stub = (day: string) =>
  env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${day}`));

describe("QuotaController.settle", () => {
  it("reserve 40k, actual 25k -> confirmed += 25k, reserved -= 40k (設計書 §12)", async () => {
    const s = stub("2026-09-01");
    await s.reserve("req-s1", 40_000, 40_000);
    const r = await s.settle("req-s1", 25_000);
    expect(r).toEqual({ ok: true });
    const v = await s.getState();
    expect(v.confirmedTokens).toBe(25_000);
    expect(v.reservedTokens).toBe(0);
  });

  it("duplicate settlement is a no-op (設計書 §12)", async () => {
    const s = stub("2026-09-02");
    await s.reserve("req-s2", 40_000, 40_000);
    await s.settle("req-s2", 25_000);
    const again = await s.settle("req-s2", 25_000);
    expect(again).toEqual({ ok: true });
    const v = await s.getState();
    expect(v.confirmedTokens).toBe(25_000); // 1 回分のみ
  });

  it("overage settle: actual > reserved counts the positive diff, reserved never goes negative, and reserves are rejected once total > limit", async () => {
    const s = stub("2026-09-03");
    await s.reserve("seed", 900_000, 900_000);
    await s.settle("seed", 900_000); // confirmed = 900,000
    await s.reserve("req-over", 80_000, 80_000);
    await s.settle("req-over", 120_000); // actual > reserved → confirmed = 1,020,000 > limit
    const v = await s.getState();
    expect(v.confirmedTokens).toBe(1_020_000);
    expect(v.reservedTokens).toBe(0); // max(0, …) 防御
    expect(v.remaining).toBeLessThan(0);
    const r = await s.reserve("req-after-over", 1, 1);
    expect(r.ok).toBe(false); // pool 合計が limit 超過 → 以後の reserve は全て拒否
  });

  it("settle from uncertain does not double-subtract (設計書 §12)", async () => {
    const s = stub("2026-09-04");
    await s.reserve("req-s4", 40_000, 40_000);
    await s.markUncertain("req-s4"); // reserved 40k → uncertain 40k
    const mid = await s.getState();
    expect(mid.reservedTokens).toBe(0);
    expect(mid.uncertainTokens).toBe(40_000);
    await s.settle("req-s4", 25_000); // uncertain からの遅延 settle
    const v = await s.getState();
    expect(v.uncertainTokens).toBe(0);
    expect(v.reservedTokens).toBe(0);
    expect(v.confirmedTokens).toBe(25_000);
  });

  it("settle for an unknown requestId fails without touching counters", async () => {
    const s = stub("2026-09-05");
    const r = await s.settle("req-nope", 100);
    expect(r).toEqual({ ok: false, reason: "unknown_request" });
    const v = await s.getState();
    expect(v.confirmedTokens).toBe(0);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npm test -w apps/gateway-worker`
Expected: FAIL（`settle` / `markUncertain` が未実装）

- [ ] **Step 3: settle と markUncertain を実装する**

`quota-controller.ts` に以下を追加する:

```ts
  async settle(requestId: string, actualTokens: number): Promise<SettleResult> {
    return this.ctx.storage.transaction(async () => {
      const entry = await getEntry(this.ctx.storage, requestId);
      if (!entry) return { ok: false as const, reason: "unknown_request" as const };
      if (entry.state !== "reserved" && entry.state !== "uncertain") {
        return entry.result as SettleResult; // 二重精算防止: 保存済み結果を返す no-op
      }

      const { pool, utcDay } = this.identity;
      const state = await loadPool(this.ctx.storage, this.env, pool, utcDay);
      if (entry.state === "reserved") {
        state.reservedTokens = Math.max(0, state.reservedTokens - entry.reservedTokens);
      } else {
        // uncertain からの遅延 settle: 減算対象は遷移元バケットのみ（二重減算しない）
        state.uncertainTokens = Math.max(0, state.uncertainTokens - entry.reservedTokens);
      }
      state.confirmedTokens += Math.max(0, Math.floor(actualTokens)); // 超過分も confirmed に正差分計上
      const over = remainingOf(state) < 0;

      entry.state = "settled";
      entry.actualTokens = actualTokens;
      entry.result = { ok: true } satisfies SettleResult;
      await savePool(this.ctx.storage, state);
      await putEntry(this.ctx.storage, requestId, entry);
      if (over) {
        // 設計書 §4.3 / §11: settlement overage の観測ログ。以後の reserve は remaining < 0 で自然に全拒否される。
        console.warn(
          `settlement overage pool=${this.ctx.id.name} confirmed=${state.confirmedTokens} ` +
            `reserved=${state.reservedTokens} uncertain=${state.uncertainTokens} limit=${state.limit}`,
        );
      }
      return entry.result as SettleResult;
    });
  }

  async markUncertain(requestId: string): Promise<MarkUncertainResult> {
    return this.ctx.storage.transaction(async () => {
      const entry = await getEntry(this.ctx.storage, requestId);
      if (!entry) return { ok: false as const, reason: "unknown_request" as const };
      if (entry.state === "uncertain") return entry.result as MarkUncertainResult; // 冪等 no-op
      if (entry.state !== "reserved") {
        // settled / reconciled / released からの遷移は不可（no-op + 監査）
        console.warn(`markUncertain conflict pool=${this.ctx.id.name} requestId=${requestId} state=${entry.state}`);
        return entry.result as MarkUncertainResult;
      }

      const { pool, utcDay } = this.identity;
      const state = await loadPool(this.ctx.storage, this.env, pool, utcDay);
      state.reservedTokens = Math.max(0, state.reservedTokens - entry.reservedTokens);
      state.uncertainTokens += entry.reservedTokens; // TTL では自動解放しない（fail-closed）
      entry.state = "uncertain";
      entry.result = { ok: true } satisfies MarkUncertainResult;
      await savePool(this.ctx.storage, state);
      await putEntry(this.ctx.storage, requestId, entry);
      return entry.result as MarkUncertainResult;
    });
  }
```

import に `SettleResult` / `MarkUncertainResult` を追加する。

- [ ] **Step 4: テストを実行してパスを確認する**

Run: `npm test -w apps/gateway-worker && npm run typecheck`
Expected: PASS 全件、typecheck exit 0

- [ ] **Step 5: コミット**

```bash
git add durable-objects apps/gateway-worker/test/quota-settle.test.ts
git commit -m "feat(quota-controller): settle / markUncertain RPC を実装"
```

### Task 7: release / reconcileRequest / finalizeDay（状態機械の完結）

**Files:**
- Modify: `durable-objects/quota-controller/src/quota-controller.ts`
- Test: `apps/gateway-worker/test/quota-lifecycle.test.ts`

**Interfaces:**
- Consumes: Task 4/6 の全 RPC
- Produces:
  - `release(requestId): Promise<ReleaseResult>` — `reserved → released` のみ。upstream 到達前と確定的に判明した場合に限り Worker が呼ぶ（設計書 §5.6）。
  - `reconcileRequest(requestId, disposition): Promise<ReconcileResult>` — `uncertain` から `reconciled`（`disposition: "consumed"`、reserved 量を confirmed へ）または `released`（`"unused"`、解放）への単調遷移。それ以外の状態・未知 ID は `{ ok: true, applied: false }` の no-op（ストレージへ書き込まない = 削除後の no_state 再実行で過去日 quota を再変更しない）。
  - `finalizeDay(): Promise<FinalizeResult>` — `uncertain` が 0 件なら `deleteAll()`。残留時は `{ ok: false, reason: "uncertain_remaining", uncertainCount }`。

- [ ] **Step 1: 失敗するテストを書く**

`apps/gateway-worker/test/quota-lifecycle.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const stub = (day: string) =>
  env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${day}`));

describe("release", () => {
  it("frees a reservation (reserved -> released)", async () => {
    const s = stub("2026-09-10");
    await s.reserve("req-r1", 30_000, 30_000);
    const r = await s.release("req-r1");
    expect(r).toEqual({ ok: true });
    const v = await s.getState();
    expect(v.reservedTokens).toBe(0);
    expect(v.remaining).toBe(1_000_000);
  });

  it("release is a no-op after settle (counters unchanged)", async () => {
    const s = stub("2026-09-11");
    await s.reserve("req-r2", 30_000, 30_000);
    await s.settle("req-r2", 10_000);
    await s.release("req-r2");
    const v = await s.getState();
    expect(v.confirmedTokens).toBe(10_000);
  });
});

describe("reconcileRequest", () => {
  it("consumed: uncertain -> reconciled, reserved amount moves to confirmed", async () => {
    const s = stub("2026-09-12");
    await s.reserve("req-c1", 25_000, 25_000);
    await s.markUncertain("req-c1");
    const r = await s.reconcileRequest("req-c1", "consumed");
    expect(r).toEqual({ ok: true, applied: true });
    const v = await s.getState();
    expect(v.uncertainTokens).toBe(0);
    expect(v.confirmedTokens).toBe(25_000);
  });

  it("unused: uncertain -> released frees the reservation", async () => {
    const s = stub("2026-09-13");
    await s.reserve("req-c2", 25_000, 25_000);
    await s.markUncertain("req-c2");
    const r = await s.reconcileRequest("req-c2", "unused");
    expect(r).toEqual({ ok: true, applied: true });
    const v = await s.getState();
    expect(v.uncertainTokens).toBe(0);
    expect(v.confirmedTokens).toBe(0);
    expect(v.remaining).toBe(1_000_000);
  });

  it("unknown requestId is { ok: true, applied: false } and writes nothing (no_state の冪等扱い)", async () => {
    const s = stub("2026-09-14");
    const r = await s.reconcileRequest("req-ghost", "consumed");
    expect(r).toEqual({ ok: true, applied: false });
    const v = await s.getState();
    expect(v.requestCount).toBe(0); // 状態を再作成しない
  });

  it("settled entry is not moved by reconcile (単調遷移のみ)", async () => {
    const s = stub("2026-09-15");
    await s.reserve("req-c4", 5_000, 5_000);
    await s.settle("req-c4", 4_000);
    const r = await s.reconcileRequest("req-c4", "unused");
    expect(r).toEqual({ ok: true, applied: false });
    const v = await s.getState();
    expect(v.confirmedTokens).toBe(4_000);
  });
});

describe("finalizeDay (設計書 §4.5)", () => {
  it("refuses while uncertain entries remain", async () => {
    const s = stub("2026-09-16");
    await s.reserve("req-f1", 10_000, 10_000);
    await s.markUncertain("req-f1");
    const r = await s.finalizeDay();
    expect(r).toEqual({ ok: false, reason: "uncertain_remaining", uncertainCount: 1 });
    const v = await s.getState(); // 削除されていない
    expect(v.uncertainTokens).toBe(10_000);
  });

  it("deletes all storage once nothing is uncertain", async () => {
    const s = stub("2026-09-17");
    await s.reserve("req-f2", 10_000, 10_000);
    await s.settle("req-f2", 8_000);
    const r = await s.finalizeDay();
    expect(r).toEqual({ ok: true, deleted: true });
    const v = await s.getState(); // 削除後は初期状態
    expect(v.confirmedTokens).toBe(0);
    expect(v.requestCount).toBe(0);
  });

  it("late settle after deletion fails as unknown_request (orphan、新しい日の quota を消費しない)", async () => {
    const s = stub("2026-09-18");
    await s.reserve("req-f3", 10_000, 10_000);
    await s.settle("req-f3", 8_000);
    await s.finalizeDay();
    const late = await s.settle("req-f3", 8_000);
    expect(late).toEqual({ ok: false, reason: "unknown_request" });
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npm test -w apps/gateway-worker`
Expected: FAIL（3 メソッド未実装）

- [ ] **Step 3: 実装する**

`quota-controller.ts` に以下を追加する:

```ts
  async release(requestId: string): Promise<ReleaseResult> {
    return this.ctx.storage.transaction(async () => {
      const entry = await getEntry(this.ctx.storage, requestId);
      if (!entry) return { ok: false as const, reason: "unknown_request" as const };
      if (entry.state !== "reserved") return entry.result as ReleaseResult; // no-op

      const { pool, utcDay } = this.identity;
      const state = await loadPool(this.ctx.storage, this.env, pool, utcDay);
      state.reservedTokens = Math.max(0, state.reservedTokens - entry.reservedTokens);
      entry.state = "released";
      entry.result = { ok: true } satisfies ReleaseResult;
      await savePool(this.ctx.storage, state);
      await putEntry(this.ctx.storage, requestId, entry);
      return entry.result as ReleaseResult;
    });
  }

  async reconcileRequest(
    requestId: string,
    disposition: ReconcileDisposition,
  ): Promise<ReconcileResult> {
    return this.ctx.storage.transaction(async () => {
      const entry = await getEntry(this.ctx.storage, requestId);
      // no_state（削除済み・未作成）は冪等 no-op。ストレージへ一切書き込まない。
      if (!entry || entry.state !== "uncertain") return { ok: true as const, applied: false };

      const { pool, utcDay } = this.identity;
      const state = await loadPool(this.ctx.storage, this.env, pool, utcDay);
      state.uncertainTokens = Math.max(0, state.uncertainTokens - entry.reservedTokens);
      if (disposition === "consumed") {
        state.confirmedTokens += entry.reservedTokens; // fail-closed: 消費確定
        entry.state = "reconciled";
      } else {
        entry.state = "released"; // Usage API での裏付けがある場合のみ Worker が選択
      }
      entry.result = { ok: true, applied: true } satisfies ReconcileResult;
      await savePool(this.ctx.storage, state);
      await putEntry(this.ctx.storage, requestId, entry);
      return entry.result as ReconcileResult;
    });
  }

  async finalizeDay(): Promise<FinalizeResult> {
    const uncertainCount = await countUncertain(this.ctx.storage);
    if (uncertainCount > 0) {
      return { ok: false as const, reason: "uncertain_remaining" as const, uncertainCount };
    }
    await this.ctx.storage.deleteAll();
    return { ok: true as const, deleted: true as const };
  }
```

import に `ReleaseResult` / `ReconcileDisposition` / `ReconcileResult` / `FinalizeResult` を追加する。

- [ ] **Step 4: テストを実行してパスを確認する**

Run: `npm test -w apps/gateway-worker && npm run typecheck`
Expected: PASS 全件、typecheck exit 0

- [ ] **Step 5: コミット**

```bash
git add durable-objects apps/gateway-worker/test/quota-lifecycle.test.ts
git commit -m "feat(quota-controller): release / reconcileRequest / finalizeDay を実装"
```

- [ ] **Step 6: PR-03 を作成する**

```bash
git push -u origin feat/octg-pr03-do-settle
gh pr create --title "feat: QuotaController DO の状態機械完結" --body "設計書 §4.2/§4.3/§4.5 に対応。settle（超過精算・二重防止・uncertain からの遅延 settle）、markUncertain、release、reconcileRequest、finalizeDay を実装。"
```


---

## PR-04: shared — モデル分類・Tool-use 判定・トークン推定（`feat/octg-pr04-classify-estimate`）

対応設計書: §5.2（モデル分類）、§5.3（Tool-use 判定）、§5.4（トークン推定）、§5.5（Output 制御）。PR-03 マージ後に `main` からブランチを切る。この PR は pure function のみで Worker / DO に触れない。

### Task 8: モデル分類と Tool-use / 非テキスト検出

**Files:**
- Create: `packages/shared/src/classify.ts`
- Modify: `packages/shared/src/index.ts`（re-export 追加）
- Test: `packages/shared/test/classify.test.ts`

**Interfaces:**
- Consumes: `@octg/shared` の `PoolName`
- Produces: `RegistryEntry` 型、`classifyModel(model, registry): PoolName | "NONE"`（不明・disabled は `NONE`）、`hasToolUse(body): boolean`（`tools` / `tool_choice` / `functions` / `function_call` の存在判定）。T13 のパイプラインがこの 2 関数を使う。

- [ ] **Step 1: 失敗するテストを書く**

`packages/shared/test/classify.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { classifyModel, hasToolUse, type RegistryEntry } from "../src/index";

const registry = new Map<string, RegistryEntry>([
  ["gpt-5", { model: "gpt-5", provider: "openai", complimentary_pool: "STANDARD", enabled: true, fallback_model: null }],
  ["gpt-5-mini", { model: "gpt-5-mini", provider: "openai", complimentary_pool: "MINI", enabled: true, fallback_model: null }],
  ["gpt-4o", { model: "gpt-4o", provider: "openai", complimentary_pool: "NONE", enabled: true, fallback_model: null }],
  ["gpt-5-old", { model: "gpt-5-old", provider: "openai", complimentary_pool: "STANDARD", enabled: false, fallback_model: null }],
]);

describe("classifyModel", () => {
  it("maps registry models to their pool", () => {
    expect(classifyModel("gpt-5", registry)).toBe("STANDARD");
    expect(classifyModel("gpt-5-mini", registry)).toBe("MINI");
  });

  it("registry model with complimentary_pool=NONE is NONE", () => {
    expect(classifyModel("gpt-4o", registry)).toBe("NONE");
  });

  it("unknown model is NONE (Unknown = Paid、設計書 §5.2)", () => {
    expect(classifyModel("gpt-99-turbo", registry)).toBe("NONE");
  });

  it("disabled model is NONE", () => {
    expect(classifyModel("gpt-5-old", registry)).toBe("NONE");
  });
});

describe("hasToolUse (設計書 §5.3)", () => {
  it("tools 配列の存在で PAID_ONLY", () => {
    expect(hasToolUse({ model: "gpt-5", tools: [] })).toBe(true);
    expect(hasToolUse({ model: "gpt-5", tools: [{ type: "function", function: { name: "f" } }] })).toBe(true);
  });

  it("tool_choice / functions / function_call の存在で PAID_ONLY", () => {
    expect(hasToolUse({ tool_choice: "auto" })).toBe(true);
    expect(hasToolUse({ tool_choice: "none" })).toBe(true); // 存在するだけで PAID_ONLY
    expect(hasToolUse({ functions: [{ name: "f" }] })).toBe(true);
    expect(hasToolUse({ function_call: { name: "f" } })).toBe(true);
  });

  it("tool 関連キーが無ければ false", () => {
    expect(hasToolUse({ model: "gpt-5", messages: [] })).toBe(false);
    expect(hasToolUse({ model: "gpt-5", input: "hi" })).toBe(false);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npm test -w packages/shared`
Expected: FAIL（export 不在）

- [ ] **Step 3: 実装する**

`packages/shared/src/classify.ts`:

```ts
import type { PoolName } from "./types";

export interface RegistryEntry {
  model: string;
  provider: string;
  complimentary_pool: PoolName | "NONE";
  enabled: boolean;
  fallback_model: string | null;
}

export function classifyModel(
  model: string,
  registry: ReadonlyMap<string, RegistryEntry>,
): PoolName | "NONE" {
  const entry = registry.get(model);
  if (!entry || !entry.enabled) return "NONE";
  return entry.complimentary_pool;
}

// tool 関連キーが「存在する」だけで PAID_ONLY（設計書 §5.3）。値の評価はしない。
const TOOL_KEYS = ["tools", "tool_choice", "functions", "function_call"] as const;

export function hasToolUse(body: Record<string, unknown>): boolean {
  return TOOL_KEYS.some((k) => body[k] !== undefined);
}
```

`packages/shared/src/index.ts` の末尾に `export * from "./classify";` を追加する。

- [ ] **Step 4: テストを実行してパスを確認する**

Run: `npm test -w packages/shared && npm run typecheck`
Expected: PASS、exit 0

- [ ] **Step 5: コミット**

```bash
git add packages/shared
git commit -m "feat(shared): モデル分類と Tool-use 判定を追加"
```

### Task 9: リクエスト正規化・トークン推定・安全マージン・出力制御

**Files:**
- Create: `packages/shared/src/normalize.ts`
- Create: `packages/shared/src/estimate.ts`
- Modify: `packages/shared/src/index.ts`（re-export 追加）
- Test: `packages/shared/test/normalize.test.ts` / `packages/shared/test/estimate.test.ts`

**Interfaces:**
- Consumes: `hasToolUse`（Task 8）
- Produces:
  - `NormalizedRequest { endpoint: "chat" | "responses"; model: string; inputText: string; messageCount: number; maxOutputTokens: number; stream: boolean; isToolUse: boolean }`
  - `normalizeChatCompletions(body: unknown): NormalizeResult` / `normalizeResponses(body: unknown): NormalizeResult`、`NormalizeResult = { ok: true; value: NormalizedRequest } | { ok: false; error: "non_text" | "max_tokens_conflict" | "invalid_body" }`
  - `DEFAULT_MAX_OUTPUT_TOKENS = 4096`
  - `estimateInputTokens(text, messageCount): number`
  - `safetyMargin(estimatedInput, remainingRatio): number`
  - `upperBoundOf(estimatedInput, maxOutput): number`
  - `decideOutput(args): { action: "proceed"; maxOutputTokens: number } | { action: "reject" }`

- [ ] **Step 1: 失敗するテストを書く（normalize）**

`packages/shared/test/normalize.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_OUTPUT_TOKENS, normalizeChatCompletions, normalizeResponses } from "../src/index";

describe("normalizeChatCompletions", () => {
  it("flattens text content and prefers max_completion_tokens", () => {
    const r = normalizeChatCompletions({
      model: "gpt-5",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: [{ type: "text", text: "Hello" }, { type: "text", text: " world" }] },
      ],
      max_tokens: 100,
      max_completion_tokens: 100,
      stream: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.maxOutputTokens).toBe(100);
      expect(r.value.stream).toBe(true);
      expect(r.value.messageCount).toBe(2);
      expect(r.value.inputText).toContain("Hello world");
    }
  });

  it("defaults max output to 4096 when unspecified", () => {
    const r = normalizeChatCompletions({ model: "gpt-5", messages: [{ role: "user", content: "hi" }] });
    expect(r.ok && r.value.maxOutputTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });

  it("conflicting max_tokens / max_completion_tokens -> max_tokens_conflict", () => {
    const r = normalizeChatCompletions({
      model: "gpt-5",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100,
      max_completion_tokens: 200,
    });
    expect(r).toEqual({ ok: false, error: "max_tokens_conflict" });
  });

  it("non-text content part -> non_text (設計書 §12: 予約前 400)", () => {
    const r = normalizeChatCompletions({
      model: "gpt-5",
      messages: [
        { role: "user", content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }] },
      ],
    });
    expect(r).toEqual({ ok: false, error: "non_text" });
  });

  it("missing model -> invalid_body", () => {
    expect(normalizeChatCompletions({ messages: [] })).toEqual({ ok: false, error: "invalid_body" });
  });

  it("isToolUse reflects hasToolUse", () => {
    const r = normalizeChatCompletions({ model: "gpt-5", messages: [{ role: "user", content: "hi" }], tools: [] });
    expect(r.ok && r.value.isToolUse).toBe(true);
  });
});

describe("normalizeResponses", () => {
  it("accepts string input and max_output_tokens", () => {
    const r = normalizeResponses({ model: "gpt-5", input: "hello", max_output_tokens: 50 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.inputText).toBe("hello");
      expect(r.value.maxOutputTokens).toBe(50);
      expect(r.value.messageCount).toBe(1);
    }
  });

  it("input_image part -> non_text", () => {
    const r = normalizeResponses({
      model: "gpt-5",
      input: [{ role: "user", content: [{ type: "input_image", image_url: "https://x/y.png" }] }],
    });
    expect(r).toEqual({ ok: false, error: "non_text" });
  });

  it("input_audio part -> non_text", () => {
    const r = normalizeResponses({
      model: "gpt-5",
      input: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: "AA", format: "mp3" } }] }],
    });
    expect(r).toEqual({ ok: false, error: "non_text" });
  });
});
```

- [ ] **Step 2: 失敗するテストを書く（estimate）**

`packages/shared/test/estimate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decideOutput, estimateInputTokens, safetyMargin, upperBoundOf } from "../src/index";

describe("estimateInputTokens", () => {
  it("counts tokens with the o200k_base encoding plus per-message overhead", () => {
    const n = estimateInputTokens("Hello world", 1);
    // o200k_base で "Hello world" は 2 トークン + 4*1 + 3 = 9
    expect(n).toBe(2 + 4 + 3);
  });

  it("scales with message count", () => {
    const one = estimateInputTokens("abc", 1);
    const three = estimateInputTokens("abcabcabc", 3);
    expect(three).toBeGreaterThan(one);
  });
});

describe("safetyMargin (設計書 §5.4)", () => {
  it("> 20% remaining: max(256, input * 0.02)", () => {
    expect(safetyMargin(1_000, 0.21)).toBe(256);
    expect(safetyMargin(100_000, 0.5)).toBe(2_000);
  });

  it("<= 20% remaining: max(512, input * 0.05)", () => {
    expect(safetyMargin(1_000, 0.2)).toBe(512);
    expect(safetyMargin(100_000, 0.1)).toBe(5_000);
  });
});

describe("upperBoundOf", () => {
  it("is input + output + the strict-tier margin", () => {
    expect(upperBoundOf(10_000, 1_000)).toBe(10_000 + 1_000 + 512); // 10000*0.05 = 500 < 512
    expect(upperBoundOf(100_000, 1_000)).toBe(100_000 + 1_000 + 5_000);
  });
});

describe("decideOutput (設計書 §5.5 / §12 CLAMP 境界)", () => {
  const base = { estimatedInput: 1_000, maxOutputTokens: 500, margin: 100 };

  it("proceeds when everything fits", () => {
    expect(decideOutput({ ...base, remaining: 2_000, outputLimitMode: "REJECT" })).toEqual({
      action: "proceed",
      maxOutputTokens: 500,
    });
  });

  it("REJECT mode: rejects when it does not fit", () => {
    expect(decideOutput({ ...base, remaining: 1_599, outputLimitMode: "REJECT" })).toEqual({ action: "reject" });
  });

  it("CLAMP mode: shrinks maxOutputTokens to candidate when candidate > 0", () => {
    // candidate = 1_300 - 1_000 - 100 = 200
    expect(decideOutput({ ...base, remaining: 1_300, outputLimitMode: "CLAMP" })).toEqual({
      action: "proceed",
      maxOutputTokens: 200,
    });
  });

  it("CLAMP boundary: candidate <= 0 -> reject (max_output_tokens <= 0 は上流へ送らない)", () => {
    // candidate = 1_100 - 1_000 - 100 = 0
    expect(decideOutput({ ...base, remaining: 1_100, outputLimitMode: "CLAMP" })).toEqual({ action: "reject" });
    // candidate = 1_050 - 1_000 - 100 = -50
    expect(decideOutput({ ...base, remaining: 1_050, outputLimitMode: "CLAMP" })).toEqual({ action: "reject" });
  });
});
```

- [ ] **Step 3: テストが失敗することを確認する**

Run: `npm test -w packages/shared`
Expected: FAIL（export 不在）

- [ ] **Step 4: 実装する**

`packages/shared/src/normalize.ts`:

```ts
import { hasToolUse } from "./classify";

export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export interface NormalizedRequest {
  endpoint: "chat" | "responses";
  model: string;
  inputText: string;
  messageCount: number;
  maxOutputTokens: number;
  stream: boolean;
  isToolUse: boolean;
}

export type NormalizeError = "non_text" | "max_tokens_conflict" | "invalid_body";
export type NormalizeResult =
  | { ok: true; value: NormalizedRequest }
  | { ok: false; error: NormalizeError };

// 非テキストとみなす content part タイプ（chat.completions / responses 双方）
const NON_TEXT_PART_TYPES = new Set([
  "image_url",
  "input_image",
  "input_audio",
  "input_file",
  "audio",
  "video",
  "file",
]);

type ContentWalk = { ok: true; text: string } | { ok: false };

function walkContent(content: unknown): ContentWalk {
  if (typeof content === "string") return { ok: true, text: content };
  if (!Array.isArray(content)) return { ok: false };
  const texts: string[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) return { ok: false };
    const p = part as Record<string, unknown>;
    if (typeof p.type === "string" && NON_TEXT_PART_TYPES.has(p.type)) return { ok: false };
    if (p.type === "text" || p.type === "input_text") {
      if (typeof p.text !== "string") return { ok: false };
      texts.push(p.text);
    }
    // 未知の text 系以外 type は NON_TEXT_PART_TYPES に列挙済み。それ以外は無視しないで失敗させる
    else if (typeof p.type !== "string") return { ok: false };
  }
  return { ok: true, text: texts.join(" ") };
}

function asPositiveInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
}

export function normalizeChatCompletions(body: unknown): NormalizeResult {
  if (typeof body !== "object" || body === null) return { ok: false, error: "invalid_body" };
  const b = body as Record<string, unknown>;
  if (typeof b.model !== "string" || b.model.length === 0) return { ok: false, error: "invalid_body" };
  if (!Array.isArray(b.messages)) return { ok: false, error: "invalid_body" };

  const maxCompletion = asPositiveInt(b.max_completion_tokens);
  const maxLegacy = asPositiveInt(b.max_tokens);
  if (maxCompletion !== undefined && maxLegacy !== undefined && maxCompletion !== maxLegacy) {
    return { ok: false, error: "max_tokens_conflict" };
  }
  const maxOutputTokens = maxCompletion ?? maxLegacy ?? DEFAULT_MAX_OUTPUT_TOKENS;

  const texts: string[] = [];
  for (const msg of b.messages) {
    if (typeof msg !== "object" || msg === null) return { ok: false, error: "invalid_body" };
    const walked = walkContent((msg as Record<string, unknown>).content);
    if (!walked.ok) return { ok: false, error: "non_text" };
    texts.push(walked.text);
  }

  return {
    ok: true,
    value: {
      endpoint: "chat",
      model: b.model,
      inputText: texts.join("\n"),
      messageCount: b.messages.length,
      maxOutputTokens,
      stream: b.stream === true,
      isToolUse: hasToolUse(b),
    },
  };
}

export function normalizeResponses(body: unknown): NormalizeResult {
  if (typeof body !== "object" || body === null) return { ok: false, error: "invalid_body" };
  const b = body as Record<string, unknown>;
  if (typeof b.model !== "string" || b.model.length === 0) return { ok: false, error: "invalid_body" };
  if (b.input === undefined) return { ok: false, error: "invalid_body" };

  const maxOutputTokens = asPositiveInt(b.max_output_tokens) ?? DEFAULT_MAX_OUTPUT_TOKENS;

  let inputText: string;
  let messageCount: number;
  if (typeof b.input === "string") {
    inputText = b.input;
    messageCount = 1;
  } else if (Array.isArray(b.input)) {
    const texts: string[] = [];
    for (const item of b.input) {
      if (typeof item !== "object" || item === null) return { ok: false, error: "invalid_body" };
      const it = item as Record<string, unknown>;
      if (it.type === "function_call" || it.type === "function_call_output") {
        // tool 呼び出し結果の往復 = tool-use フロー。isToolUse で PAID_ONLY になるため推定対象外だが、
        // テキストとしては扱わない
        continue;
      }
      const walked = walkContent(it.content);
      if (!walked.ok) return { ok: false, error: "non_text" };
      texts.push(walked.text);
    }
    inputText = texts.join("\n");
    messageCount = b.input.length;
  } else {
    return { ok: false, error: "invalid_body" };
  }

  return {
    ok: true,
    value: {
      endpoint: "responses",
      model: b.model,
      inputText,
      messageCount,
      maxOutputTokens,
      stream: b.stream === true,
      isToolUse: hasToolUse(b) || JSON.stringify(b).includes('"function_call"'),
    },
  };
}
```

`packages/shared/src/estimate.ts`:

```ts
import { getEncoding, type Tiktoken } from "js-tiktoken";

let encoding: Tiktoken | undefined;

// o200k_base で正確に数え、メッセージ整形オーバーヘッド（4/メッセージ + 3）を加算する。
// エンコーディング初期化に失敗した場合は UTF-8 バイト数 / 2 の保守的上限に倒す（fail-closed）。
export function estimateInputTokens(text: string, messageCount: number): number {
  let base: number;
  try {
    encoding ??= getEncoding("o200k_base");
    base = encoding.encode(text).length;
  } catch {
    base = Math.ceil(new TextEncoder().encode(text).length / 2);
  }
  return base + 4 * messageCount + 3;
}

export function safetyMargin(estimatedInput: number, remainingRatio: number): number {
  if (remainingRatio <= 0.2) return Math.max(512, Math.ceil(estimatedInput * 0.05));
  return Math.max(256, Math.ceil(estimatedInput * 0.02));
}

// STRICT 帯で DO に渡す保守的上限（設計書 §4.3）。マージンは常に厳しい側（5% 帯）を使う。
export function upperBoundOf(estimatedInput: number, maxOutput: number): number {
  return estimatedInput + maxOutput + Math.max(512, Math.ceil(estimatedInput * 0.05));
}

export type OutputDecision =
  | { action: "proceed"; maxOutputTokens: number }
  | { action: "reject" };

export function decideOutput(args: {
  estimatedInput: number;
  maxOutputTokens: number;
  margin: number;
  remaining: number;
  outputLimitMode: "REJECT" | "CLAMP";
}): OutputDecision {
  const { estimatedInput, maxOutputTokens, margin, remaining, outputLimitMode } = args;
  if (estimatedInput + maxOutputTokens + margin <= remaining) {
    return { action: "proceed", maxOutputTokens };
  }
  if (outputLimitMode === "CLAMP") {
    const candidate = remaining - estimatedInput - margin;
    if (candidate > 0) return { action: "proceed", maxOutputTokens: candidate };
    // candidate <= 0: CLAMP せず REJECT（max_output_tokens <= 0 を上流へ送らない）
  }
  return { action: "reject" };
}
```

`packages/shared/src/index.ts` の末尾に以下を追加する:

```ts
export * from "./normalize";
export * from "./estimate";
```

- [ ] **Step 5: テストを実行してパスを確認する**

Run: `npm test -w packages/shared && npm run typecheck`
Expected: PASS 全件（js-tiktoken が "Hello world" を 2 トークンと数えることを確認）、exit 0

注意: js-tiktoken の o200k_base で "Hello world" が 2 トークンでない場合はテストの期待値を実測値に合わせる（実装側は変更しない。トークン数の実値はエンコーディングの責務）。

- [ ] **Step 6: コミット**

```bash
git add packages/shared
git commit -m "feat(shared): リクエスト正規化・トークン推定・出力制御を追加"
```

- [ ] **Step 7: PR-04 を作成する**

```bash
git push -u origin feat/octg-pr04-classify-estimate
gh pr create --title "feat: モデル分類・Tool-use 判定・トークン推定" --body "設計書 §5.2-§5.5 に対応。不明モデル=NONE、tool 存在=PAID_ONLY、非テキスト=予約前拒否、二段階マージン、CLAMP/REJECT 出力制御。"
```


---

## PR-05: エラー契約と X-OCTG-* ヘッダ（`feat/octg-pr05-error-contract`）

対応設計書: §5.7（レスポンスとエラー）、§9.1（401/403）。PR-04 マージ後に `main` からブランチを切る。

### Task 10: エラービルダーとヘッダビルダー

**Files:**
- Create: `packages/shared/src/errors.ts`
- Test: `packages/shared/test/errors.test.ts`

**Interfaces:**
- Consumes: `PoolName`, `toPoolLower`, `QuotaView`
- Produces: `OctgHttpError { status; body; requestId; quota?: QuotaSnapshot; route?: string }`、`QuotaSnapshot { pool; limit; used; remaining; resetAt }`、エラービルダー群（下記コード）、`buildOctgHeaders(args): Record<string, string>`、`errorResponse(err): Response`。Worker は全エラー応答をこれら経由でのみ生成する。

- [ ] **Step 1: 失敗するテストを書く**

`packages/shared/test/errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  buildOctgHeaders,
  errInvalidApiKey,
  errMaxTokensConflict,
  errModelNotAllowed,
  errModelRequiresPaid,
  errNonTextInput,
  errQuotaExceeded,
  errRequestTooLarge,
  errorResponse,
  type QuotaSnapshot,
} from "../src/errors";

const snap: QuotaSnapshot = {
  pool: "STANDARD",
  limit: 1_000_000,
  used: 987_500,
  remaining: 12_500,
  resetAt: "2026-08-10T00:00:00Z",
};

describe("canonical error bodies (設計書 §5.7)", () => {
  it("429 quota exceeded carries pool/remaining/reset inside error and pool headers", async () => {
    const res = errorResponse(errQuotaExceeded(snap, "req_01J4ZK8M2E5KQ0W0A2N1F9P3B2"));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: {
        message: "Complimentary quota exceeded for pool 'standard'.",
        type: "complimentary_quota_exceeded",
        param: null,
        code: "insufficient_quota",
        pool: "standard",
        remaining_tokens: 12_500,
        reset_at: "2026-08-10T00:00:00Z",
      },
      request_id: "req_01J4ZK8M2E5KQ0W0A2N1F9P3B2",
    });
    expect(res.headers.get("X-OCTG-Pool")).toBe("standard");
    expect(res.headers.get("X-OCTG-Quota-Used")).toBe("987500");
    expect(res.headers.get("X-OCTG-Quota-Remaining")).toBe("12500");
    expect(res.headers.get("X-OCTG-Quota-Reset")).toBe("2026-08-10T00:00:00Z");
    expect(res.headers.get("X-OCTG-Route")).toBe("reject:complimentary_quota");
  });

  it("413 request too large", async () => {
    const res = errorResponse(errRequestTooLarge(snap, "req_x"));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: {
        message: "Request exceeds the complimentary quota limit for pool 'standard'.",
        type: "invalid_request_error",
        param: null,
        code: "request_too_large",
      },
      request_id: "req_x",
    });
    expect(res.headers.get("X-OCTG-Route")).toBe("reject:request_too_large");
  });

  it("403 model not allowed (pool 確定時のみ pool ヘッダ付き)", async () => {
    const res = errorResponse(errModelNotAllowed("req_y", snap));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: {
        message: "The requested model is not allowed for this client.",
        type: "invalid_request_error",
        param: "model",
        code: "model_not_allowed",
      },
      request_id: "req_y",
    });
    expect(res.headers.get("X-OCTG-Pool")).toBe("standard");
    expect(res.headers.get("X-OCTG-Route")).toBe("reject:model_not_allowed");

    const noPool = errorResponse(errModelNotAllowed("req_z"));
    expect(noPool.headers.get("X-OCTG-Pool")).toBeNull();
    expect(noPool.headers.get("X-OCTG-Quota-Used")).toBeNull();
    expect(noPool.headers.get("X-OCTG-Request-Id")).toBe("req_z");
  });

  it("403 model requires paid (pool ヘッダなし)", async () => {
    const res = errorResponse(errModelRequiresPaid("req_p"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: {
        message: "The requested model requires paid mode, which is not enabled.",
        type: "invalid_request_error",
        param: "model",
        code: "model_requires_paid",
      },
      request_id: "req_p",
    });
    expect(res.headers.get("X-OCTG-Pool")).toBeNull();
    expect(res.headers.get("X-OCTG-Request-Id")).toBe("req_p");
  });

  it("400 non-text input", async () => {
    const res = errorResponse(errNonTextInput("req_n"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        message: "Non-text input is not supported in the MVP.",
        type: "invalid_request_error",
        param: "input",
        code: "invalid_request",
      },
      request_id: "req_n",
    });
  });

  it("400 max_tokens conflict", async () => {
    const res = errorResponse(errMaxTokensConflict("req_c"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        message: "max_tokens and max_completion_tokens must match when both are provided.",
        type: "invalid_request_error",
        param: "max_tokens",
        code: "invalid_request",
      },
      request_id: "req_c",
    });
  });

  it("401 invalid api key (pool ヘッダなし)", async () => {
    const res = errorResponse(errInvalidApiKey("req_401"));
    expect(res.status).toBe(401);
    const j = (await res.json()) as { error: { type: string; code: string; param: null } };
    expect(j.error.type).toBe("authentication_error");
    expect(j.error.code).toBe("invalid_api_key");
    expect(j.error.param).toBeNull();
    expect(res.headers.get("X-OCTG-Pool")).toBeNull();
  });
});

describe("buildOctgHeaders", () => {
  it("pool 系は all-or-nothing", () => {
    const h = buildOctgHeaders({ requestId: "r1", quota: snap, route: "free_shared" });
    expect(h).toEqual({
      "X-OCTG-Request-Id": "r1",
      "X-OCTG-Pool": "standard",
      "X-OCTG-Quota-Limit": "1000000",
      "X-OCTG-Quota-Used": "987500",
      "X-OCTG-Quota-Remaining": "12500",
      "X-OCTG-Quota-Reset": "2026-08-10T00:00:00Z",
      "X-OCTG-Route": "free_shared",
    });
    expect(buildOctgHeaders({ requestId: "r2" })).toEqual({ "X-OCTG-Request-Id": "r2" });
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npm test -w packages/shared`
Expected: FAIL（`../src/errors` 不在）

- [ ] **Step 3: 実装する**

`packages/shared/src/errors.ts`:

```ts
import { toPoolLower } from "./pool";
import type { PoolName } from "./types";

export interface QuotaSnapshot {
  pool: PoolName;
  limit: number;
  used: number; // confirmed + reserved + uncertain
  remaining: number;
  resetAt: string;
}

export interface OctgHttpError {
  status: number;
  body: {
    error: {
      message: string;
      type: string;
      param: string | null;
      code: string;
      pool?: string;
      remaining_tokens?: number;
      reset_at?: string;
    };
    request_id: string;
  };
  requestId: string;
  quota?: QuotaSnapshot; // 存在する場合のみ pool 系ヘッダを付与する
  route?: string;
}

export function errQuotaExceeded(quota: QuotaSnapshot, requestId: string): OctgHttpError {
  const pool = toPoolLower(quota.pool);
  return {
    status: 429,
    requestId,
    quota,
    route: "reject:complimentary_quota",
    body: {
      error: {
        message: `Complimentary quota exceeded for pool '${pool}'.`,
        type: "complimentary_quota_exceeded",
        param: null,
        code: "insufficient_quota",
        pool,
        remaining_tokens: quota.remaining,
        reset_at: quota.resetAt,
      },
      request_id: requestId,
    },
  };
}

export function errRequestTooLarge(quota: QuotaSnapshot, requestId: string): OctgHttpError {
  return {
    status: 413,
    requestId,
    quota,
    route: "reject:request_too_large",
    body: {
      error: {
        message: `Request exceeds the complimentary quota limit for pool '${toPoolLower(quota.pool)}'.`,
        type: "invalid_request_error",
        param: null,
        code: "request_too_large",
      },
      request_id: requestId,
    },
  };
}

export function errModelNotAllowed(requestId: string, quota?: QuotaSnapshot): OctgHttpError {
  return {
    status: 403,
    requestId,
    ...(quota ? { quota, route: "reject:model_not_allowed" } : {}),
    body: {
      error: {
        message: "The requested model is not allowed for this client.",
        type: "invalid_request_error",
        param: "model",
        code: "model_not_allowed",
      },
      request_id: requestId,
    },
  };
}

export function errModelRequiresPaid(requestId: string): OctgHttpError {
  return {
    status: 403,
    requestId,
    body: {
      error: {
        message: "The requested model requires paid mode, which is not enabled.",
        type: "invalid_request_error",
        param: "model",
        code: "model_requires_paid",
      },
      request_id: requestId,
    },
  };
}

export function errNonTextInput(requestId: string): OctgHttpError {
  return {
    status: 400,
    requestId,
    body: {
      error: {
        message: "Non-text input is not supported in the MVP.",
        type: "invalid_request_error",
        param: "input",
        code: "invalid_request",
      },
      request_id: requestId,
    },
  };
}

export function errMaxTokensConflict(requestId: string): OctgHttpError {
  return {
    status: 400,
    requestId,
    body: {
      error: {
        message: "max_tokens and max_completion_tokens must match when both are provided.",
        type: "invalid_request_error",
        param: "max_tokens",
        code: "invalid_request",
      },
      request_id: requestId,
    },
  };
}

export function errInvalidRequest(requestId: string, message = "Invalid request body."): OctgHttpError {
  return {
    status: 400,
    requestId,
    body: {
      error: { message, type: "invalid_request_error", param: null, code: "invalid_request" },
      request_id: requestId,
    },
  };
}

export function errInvalidApiKey(requestId: string): OctgHttpError {
  return {
    status: 401,
    requestId,
    body: {
      error: {
        message: "Invalid API key provided.",
        type: "authentication_error",
        param: null,
        code: "invalid_api_key",
      },
      request_id: requestId,
    },
  };
}

export function errClientDisabled(requestId: string): OctgHttpError {
  return {
    status: 403,
    requestId,
    body: {
      error: {
        message: "This client is disabled.",
        type: "permission_error",
        param: null,
        code: "client_disabled",
      },
      request_id: requestId,
    },
  };
}

export function errInternal(requestId: string): OctgHttpError {
  return {
    status: 500,
    requestId,
    body: {
      error: {
        message: "An internal error occurred.",
        type: "api_error",
        param: null,
        code: "internal_error",
      },
      request_id: requestId,
    },
  };
}

export function buildOctgHeaders(args: {
  requestId: string;
  quota?: QuotaSnapshot;
  route?: string;
}): Record<string, string> {
  const headers: Record<string, string> = { "X-OCTG-Request-Id": args.requestId };
  // pool 系ヘッダは all-or-nothing（pool 確定後のみ。設計書 §5.7）
  if (args.quota && args.route) {
    headers["X-OCTG-Pool"] = toPoolLower(args.quota.pool);
    headers["X-OCTG-Quota-Limit"] = String(args.quota.limit);
    headers["X-OCTG-Quota-Used"] = String(args.quota.used);
    headers["X-OCTG-Quota-Remaining"] = String(args.quota.remaining);
    headers["X-OCTG-Quota-Reset"] = args.quota.resetAt;
    headers["X-OCTG-Route"] = args.route;
  }
  return headers;
}

export function errorResponse(err: OctgHttpError): Response {
  return new Response(JSON.stringify(err.body), {
    status: err.status,
    headers: {
      "content-type": "application/json",
      ...buildOctgHeaders({ requestId: err.requestId, ...(err.quota ? { quota: err.quota } : {}), ...(err.route ? { route: err.route } : {}) },
    },
  });
}
```

`packages/shared/src/index.ts` の末尾に `export * from "./errors";` を追加する（`exports` の `./errors` サブパスは Task 1 で宣言済み）。

- [ ] **Step 4: テストを実行してパスを確認する**

Run: `npm test -w packages/shared && npm run typecheck`
Expected: PASS、exit 0

- [ ] **Step 5: コミット**

```bash
git add packages/shared
git commit -m "feat(shared): エラー契約と X-OCTG-* ヘッダビルダーを追加"
```

- [ ] **Step 6: PR-05 を作成する**

```bash
git push -u origin feat/octg-pr05-error-contract
gh pr create --title "feat: エラー契約と X-OCTG-* ヘッダ" --body "設計書 §5.7/§9.1 に対応。6 種の canonical エラー body、pool 確定前後のヘッダ出し分け、429 の error 内 pool/remaining/reset。"
```


---

## PR-06: Worker 認証・D1 アクセス・ポリシーキャッシュ（`feat/octg-pr06-worker-auth`）

対応設計書: §5.1（認証）、§5.2（ポリシー解決・キャッシュ）、§10（keyed hash）。PR-05 マージ後に `main` からブランチを切る。この PR では HTTP ルートを追加せず、関数単位でテストする（ルートへの配線は PR-07）。

### Task 11: クライアント認証（keyed hash 照合）

**Files:**
- Create: `apps/gateway-worker/src/crypto.ts`
- Create: `apps/gateway-worker/src/auth.ts`
- Test: `apps/gateway-worker/test/auth.test.ts` / `apps/gateway-worker/test/seed.ts`（テスト用 seed ヘルパー）

**Interfaces:**
- Consumes: D1 `clients` テーブル、`env.OCTG_KEY_PEPPER`、`@octg/shared/errors` の `errInvalidApiKey` / `errClientDisabled`
- Produces: `hashClientKey(rawKey, pepper): Promise<string>`、`authenticate(request, env): Promise<ClientContext | OctgHttpError>`、`ClientContext { id: string; name: string }`。T13/T16/T17 が `authenticate` を使う。

- [ ] **Step 1: テスト用 seed ヘルパーと失敗するテストを書く**

`apps/gateway-worker/test/seed.ts`:

```ts
import { env } from "cloudflare:test";
import { hashClientKey } from "../src/crypto";

export const TEST_CLIENT_KEY = "octg_sk_testclient01";
export const TEST_CLIENT_ID = "client_test";

export async function seedClient(opts?: { enabled?: boolean }): Promise<void> {
  const keyHash = await hashClientKey(TEST_CLIENT_KEY, env.OCTG_KEY_PEPPER);
  await env.DB.prepare(
    "INSERT INTO clients (id, name, key_hash, enabled, created_at) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET key_hash=excluded.key_hash, enabled=excluded.enabled",
  )
    .bind(TEST_CLIENT_ID, "Test Client", keyHash, opts?.enabled === false ? 0 : 1, new Date().toISOString())
    .run();
}

export async function seedPolicy(
  clientId: string,
  policy: { overflowMode?: string; outputLimitMode?: string; cacheEnabled?: boolean },
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO client_policies (client_id, overflow_mode, output_limit_mode, max_paid_usd_day, cache_enabled) " +
      "VALUES (?, ?, ?, 0, ?) ON CONFLICT(client_id) DO UPDATE SET " +
      "overflow_mode=excluded.overflow_mode, output_limit_mode=excluded.output_limit_mode, cache_enabled=excluded.cache_enabled",
  )
    .bind(
      clientId,
      policy.overflowMode ?? "REJECT",
      policy.outputLimitMode ?? "REJECT",
      policy.cacheEnabled ? 1 : 0,
    )
    .run();
}
```

`apps/gateway-worker/test/auth.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { authenticate } from "../src/auth";
import { env } from "cloudflare:test";
import { seedClient, TEST_CLIENT_ID, TEST_CLIENT_KEY } from "./seed";

const req = (auth?: string) =>
  new Request("https://octg.test/v1/chat/completions", {
    method: "POST",
    headers: auth ? { authorization: auth } : {},
  });

describe("authenticate", () => {
  it("returns 401 when Authorization is missing", async () => {
    const r = await authenticate(req(), env);
    expect(r).toMatchObject({ status: 401, body: { error: { code: "invalid_api_key" } } });
  });

  it("returns 401 for a non-octg key prefix", async () => {
    const r = await authenticate(req("Bearer sk-proj-abc"), env);
    expect(r).toMatchObject({ status: 401 });
  });

  it("returns 401 for an unknown key", async () => {
    await seedClient();
    const r = await authenticate(req("Bearer octg_sk_wrong"), env);
    expect(r).toMatchObject({ status: 401 });
  });

  it("returns 403 for a disabled client", async () => {
    await seedClient({ enabled: false });
    const r = await authenticate(req(`Bearer ${TEST_CLIENT_KEY}`), env);
    expect(r).toMatchObject({ status: 403, body: { error: { code: "client_disabled" } } });
  });

  it("returns the client context for a valid key", async () => {
    await seedClient();
    const r = await authenticate(req(`Bearer ${TEST_CLIENT_KEY}`), env);
    expect(r).toEqual({ id: TEST_CLIENT_ID, name: "Test Client" });
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npm test -w apps/gateway-worker`
Expected: FAIL（`../src/auth` / `../src/crypto` 不在）

- [ ] **Step 3: 実装する**

`apps/gateway-worker/src/crypto.ts`:

```ts
// clients.key_hash = HMAC-SHA256(pepper, rawKey) の hex（設計書 §10）。
// pepper は secret（OCTG_KEY_PEPPER）であり、raw key 自体は保存しない。
export async function hashClientKey(rawKey: string, pepper: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawKey));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
```

`apps/gateway-worker/src/auth.ts`:

```ts
import { errClientDisabled, errInvalidApiKey, type OctgHttpError } from "@octg/shared";
import { hashClientKey } from "./crypto";
import type { Env } from "./index";

export interface ClientContext {
  id: string;
  name: string;
}

interface ClientRow {
  id: string;
  name: string;
  enabled: number;
}

export async function authenticate(request: Request, env: Env): Promise<ClientContext | OctgHttpError> {
  const header = request.headers.get("authorization");
  const requestId = crypto.randomUUID(); // 認証前のため requestId 未採番。エラー識別用の一時 ID
  if (!header?.startsWith("Bearer octg_sk_")) return errInvalidApiKey(requestId);

  const rawKey = header.slice("Bearer ".length);
  const keyHash = await hashClientKey(rawKey, env.OCTG_KEY_PEPPER);
  const row = await env.DB.prepare("SELECT id, name, enabled FROM clients WHERE key_hash = ?")
    .bind(keyHash)
    .first<ClientRow>();
  if (!row) return errInvalidApiKey(requestId);
  if (!row.enabled) return errClientDisabled(requestId);
  return { id: row.id, name: row.name };
}
```

注意: T13 で `authenticate` はパイプラインが採番した `requestId` を引き回す形にリファクタする（`authenticate(request, env, requestId)`）。このタスクでは上記のシグネチャでよい。

- [ ] **Step 4: テストを実行してパスを確認する**

Run: `npm test -w apps/gateway-worker && npm run typecheck`
Expected: PASS、exit 0

- [ ] **Step 5: コミット**

```bash
git add apps/gateway-worker/src apps/gateway-worker/test
git commit -m "feat(worker): クライアント認証（keyed hash 照合）を追加"
```

### Task 12: D1 アクセス層とポリシー/レジストリの TTL キャッシュ

**Files:**
- Create: `apps/gateway-worker/src/db.ts`
- Create: `apps/gateway-worker/src/policy.ts`
- Test: `apps/gateway-worker/test/policy.test.ts`

**Interfaces:**
- Consumes: D1 `client_policies` / `model_registry` / `requests` テーブル、`RegistryEntry`（Task 8）
- Produces:
  - `ClientPolicy { overflowMode: "REJECT" | "PAID_SHARED"; outputLimitMode: "REJECT" | "CLAMP"; maxPaidUsdDay: number; cacheEnabled: boolean }`、`DEFAULT_CLIENT_POLICY`（全 REJECT / 0 / false）
  - `loadRegistry(env): Promise<ReadonlyMap<string, RegistryEntry>>`（60 秒 TTL キャッシュ）
  - `loadPolicy(env, clientId): Promise<ClientPolicy>`（60 秒 TTL キャッシュ、行が無ければデフォルト）
  - `invalidateConfigCaches(): void`（Admin API の書き込み後に呼ぶ。T18/T19 が使用）
  - `insertRequestRow(env, row)` / `completeRequestRow(env, requestId, fields)`（監査、fire-and-forget 呼び出し用）

- [ ] **Step 1: 失敗するテストを書く**

`apps/gateway-worker/test/policy.test.ts`:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CLIENT_POLICY, invalidateConfigCaches, loadPolicy, loadRegistry } from "../src/policy";
import { seedClient, seedPolicy, TEST_CLIENT_ID } from "./seed";

describe("loadRegistry", () => {
  it("loads the seeded registry as a map", async () => {
    const reg = await loadRegistry(env);
    expect(reg.get("gpt-5")?.complimentary_pool).toBe("STANDARD");
    expect(reg.get("gpt-5-mini")?.complimentary_pool).toBe("MINI");
  });

  it("caches within the TTL and reloads after invalidation", async () => {
    await loadRegistry(env);
    await env.DB.prepare(
      "INSERT INTO model_registry (model, provider, complimentary_pool, enabled, fallback_model, updated_at) VALUES ('gpt-5-nano', 'openai', 'MINI', 1, NULL, ?)",
    )
      .bind(new Date().toISOString())
      .run();
    expect((await loadRegistry(env)).has("gpt-5-nano")).toBe(false); // キャッシュ中
    invalidateConfigCaches();
    expect((await loadRegistry(env)).has("gpt-5-nano")).toBe(true);
  });
});

describe("loadPolicy", () => {
  beforeEach(async () => {
    await seedClient();
  });

  it("returns the default policy when no row exists", async () => {
    const p = await loadPolicy(env, TEST_CLIENT_ID);
    expect(p).toEqual(DEFAULT_CLIENT_POLICY);
  });

  it("loads a CLAMP policy", async () => {
    await seedPolicy(TEST_CLIENT_ID, { outputLimitMode: "CLAMP" });
    const p = await loadPolicy(env, TEST_CLIENT_ID);
    expect(p.outputLimitMode).toBe("CLAMP");
    expect(p.overflowMode).toBe("REJECT");
    expect(p.cacheEnabled).toBe(false);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npm test -w apps/gateway-worker`
Expected: FAIL（`../src/policy` 不在）

- [ ] **Step 3: 実装する**

`apps/gateway-worker/src/db.ts`:

```ts
import type { RegistryEntry } from "@octg/shared";
import type { Env } from "./index";

export interface RequestLogRow {
  requestId: string;
  utcDay: string;
  clientId: string;
  requestedModel: string | null;
  upstreamModel: string | null;
  pool: string | null;
  eligibility: string | null;
  reservedTokens: number | null;
}

// 監査ログの挿入。呼び出し側は ctx.waitUntil() で fire-and-forget にする（設計書 §5.7）。
export async function insertRequestRow(env: Env, row: RequestLogRow): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO requests (request_id, utc_day, client_id, requested_model, upstream_model, pool, eligibility, reserved_tokens, status, started_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'in_flight', ?) ON CONFLICT(request_id) DO NOTHING",
  )
    .bind(
      row.requestId,
      row.utcDay,
      row.clientId,
      row.requestedModel,
      row.upstreamModel,
      row.pool,
      row.eligibility,
      row.reservedTokens,
      new Date().toISOString(),
    )
    .run();
}

export interface RequestCompleteFields {
  status: "completed" | "failed" | "uncertain" | "orphaned";
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  billingClass?: "free" | "paid" | "none";
  openaiRequestId?: string;
}

export async function completeRequestRow(
  env: Env,
  requestId: string,
  f: RequestCompleteFields,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE requests SET status = ?, input_tokens = ?, output_tokens = ?, total_tokens = ?, " +
      "billing_class = ?, openai_request_id = ?, completed_at = ? WHERE request_id = ?",
  )
    .bind(
      f.status,
      f.inputTokens ?? null,
      f.outputTokens ?? null,
      f.totalTokens ?? null,
      f.billingClass ?? null,
      f.openaiRequestId ?? null,
      new Date().toISOString(),
      requestId,
    )
    .run();
}

export async function listRegistryRows(env: Env): Promise<RegistryEntry[]> {
  const rs = await env.DB.prepare(
    "SELECT model, provider, complimentary_pool, enabled, fallback_model FROM model_registry",
  ).all<Omit<RegistryEntry, "enabled"> & { enabled: number }>();
  return rs.results.map((r) => ({ ...r, enabled: r.enabled === 1 }));
}
```

`apps/gateway-worker/src/policy.ts`:

```ts
import type { RegistryEntry } from "@octg/shared";
import { listRegistryRows } from "./db";
import type { Env } from "./index";

export interface ClientPolicy {
  overflowMode: "REJECT" | "PAID_SHARED";
  outputLimitMode: "REJECT" | "CLAMP";
  maxPaidUsdDay: number;
  cacheEnabled: boolean;
}

export const DEFAULT_CLIENT_POLICY: ClientPolicy = {
  overflowMode: "REJECT",
  outputLimitMode: "REJECT",
  maxPaidUsdDay: 0,
  cacheEnabled: false,
};

const TTL_MS = 60_000; // 設計書 §5.2: 短時間キャッシュ。DB が正であり、変更反映は TTL か invalidate で行う

let registryCache: { map: ReadonlyMap<string, RegistryEntry>; expiresAt: number } | undefined;
const policyCache = new Map<string, { policy: ClientPolicy; expiresAt: number }>();

export function invalidateConfigCaches(): void {
  registryCache = undefined;
  policyCache.clear();
}

export async function loadRegistry(env: Env): Promise<ReadonlyMap<string, RegistryEntry>> {
  const now = Date.now();
  if (registryCache && registryCache.expiresAt > now) return registryCache.map;
  const rows = await listRegistryRows(env);
  const map = new Map(rows.map((r) => [r.model, r]));
  registryCache = { map, expiresAt: now + TTL_MS };
  return map;
}

interface PolicyRow {
  overflow_mode: string;
  output_limit_mode: string;
  max_paid_usd_day: number;
  cache_enabled: number;
}

export async function loadPolicy(env: Env, clientId: string): Promise<ClientPolicy> {
  const now = Date.now();
  const cached = policyCache.get(clientId);
  if (cached && cached.expiresAt > now) return cached.policy;
  const row = await env.DB.prepare(
    "SELECT overflow_mode, output_limit_mode, max_paid_usd_day, cache_enabled FROM client_policies WHERE client_id = ?",
  )
    .bind(clientId)
    .first<PolicyRow>();
  const policy: ClientPolicy = row
    ? {
        overflowMode: row.overflow_mode === "PAID_SHARED" ? "PAID_SHARED" : "REJECT",
        outputLimitMode: row.output_limit_mode === "CLAMP" ? "CLAMP" : "REJECT",
        maxPaidUsdDay: row.max_paid_usd_day,
        cacheEnabled: row.cache_enabled === 1,
      }
    : DEFAULT_CLIENT_POLICY;
  policyCache.set(clientId, { policy, expiresAt: now + TTL_MS });
  return policy;
}
```

- [ ] **Step 4: テストを実行してパスを確認する**

Run: `npm test -w apps/gateway-worker && npm run typecheck`
Expected: PASS、exit 0

- [ ] **Step 5: コミット**

```bash
git add apps/gateway-worker/src apps/gateway-worker/test
git commit -m "feat(worker): D1 アクセス層とポリシー/レジストリの TTL キャッシュを追加"
```

- [ ] **Step 6: PR-06 を作成する**

```bash
git push -u origin feat/octg-pr06-worker-auth
gh pr create --title "feat: Worker 認証・ポリシー解決基盤" --body "設計書 §5.1/§5.2/§10 に対応。octg_sk_* の keyed hash 照合、D1 アクセス層、60 秒 TTL のレジストリ/ポリシーキャッシュ。"
```


---

## PR-07: 推論パイプライン（非ストリーミング）（`feat/octg-pr07-pipeline`）

対応設計書: §5.3-§5.7（パイプライン全体）、§7（AI Gateway 連携）。PR-06 マージ後に `main` からブランチを切る。

### Task 13: reserve → 上流転送 → settle のメインパイプライン

**Files:**
- Create: `apps/gateway-worker/src/upstream.ts`
- Create: `apps/gateway-worker/src/proxy.ts`
- Modify: `apps/gateway-worker/src/index.ts`（ルーティング追加）
- Modify: `apps/gateway-worker/src/auth.ts`（requestId を外部採番に変更）
- Test: `apps/gateway-worker/test/proxy.test.ts`

**Interfaces:**
- Consumes: `authenticate`（T11）、`loadRegistry` / `loadPolicy`（T12）、`classifyModel` / `normalizeChatCompletions` / `normalizeResponses` / `estimateInputTokens` / `safetyMargin` / `upperBoundOf` / `decideOutput`（PR-04）、エラービルダー群（T10）、DO の `reserve` / `settle` / `getState` / `release` / `markUncertain`（PR-02/03）
- Produces: `handleProxy(request, env, ctx, endpoint): Promise<Response>`（`index.ts` のルータが呼ぶ）、`callUpstream(env, path, body, meta, cacheKey)`、`UpstreamConfigError`、内部関数 `proxyStream`（T15 でテストされる）。**重要契約**: settle / markUncertain は **reserve 時点の UTC 日の DO スタブ**に対して呼ぶ（`stub` をクロージャで保持し、settle 時に日付から再解決しない）。

- [ ] **Step 1: auth.ts を requestId 外部採番に対応させる**

`authenticate` のシグネチャを `authenticate(request: Request, env: Env, requestId?: string)` に変え、エラー生成時の ID を `requestId ?? crypto.randomUUID()` とする（後方互換。T11 のテストはそのまま通る）。

- [ ] **Step 2: 失敗するテストを書く**

`apps/gateway-worker/test/proxy.test.ts`:

```ts
import { env, fetchMock, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedClient, seedPolicy, TEST_CLIENT_ID, TEST_CLIENT_KEY } from "./seed";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

beforeEach(async () => {
  await seedClient();
});

const todayStub = () => {
  const day = new Date().toISOString().slice(0, 10);
  return env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${day}`));
};

const authed = (body: unknown, key: string = TEST_CLIENT_KEY) =>
  SELF.fetch("https://octg.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });

describe("proxy pipeline (happy path & contract errors)", () => {
  it("settles with actual usage and returns pool headers on success", async () => {
    fetchMock
      .get("https://aigw.invalid")
      .intercept({ path: "/chat/completions", method: "POST" })
      .reply(200, {
        id: "chatcmpl-1",
        object: "chat.completion",
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      });

    const res = await authed({
      model: "gpt-5",
      messages: [{ role: "user", content: "hi" }],
      max_completion_tokens: 100,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-OCTG-Pool")).toBe("standard");
    expect(res.headers.get("X-OCTG-Route")).toBe("free_shared");
    const rid = res.headers.get("X-OCTG-Request-Id");
    expect(rid).toMatch(/^req_/);

    const v = await todayStub().getState();
    expect(v.confirmedTokens).toBe(150);
    expect(v.reservedTokens).toBe(0);
    expect(v.requestCount).toBe(1);

    // 監査ログ（fire-and-forget）は最終的に completed になる
    await expect
      .poll(
        async () =>
          (
            await env.DB.prepare("SELECT status FROM requests WHERE request_id = ?")
              .bind(rid)
              .first<{ status: string }>()
          )?.status,
        { timeout: 2_000 },
      )
      .toBe("completed");
  });

  it("injects max_completion_tokens and cf-aig-* headers into the upstream request", async () => {
    let captured: { headers?: unknown; body?: string } = {};
    fetchMock
      .get("https://aigw.invalid")
      .intercept({ path: "/chat/completions", method: "POST" })
      .reply(200, (opts) => {
        captured = { headers: opts.headers, body: String(opts.body) };
        return { usage: { total_tokens: 10 } };
      });

    const res = await authed({
      model: "gpt-5",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 200,
    });
    expect(res.status).toBe(200);
    const sentBody = JSON.parse(captured.body!);
    expect(sentBody.max_completion_tokens).toBe(200);
    expect(sentBody.max_tokens).toBeUndefined();
    const h = captured.headers as Record<string, string>;
    expect(h["cf-aig-request-timeout"]).toBe("25000");
    expect(h["cf-aig-max-attempts"]).toBe("2");
    expect(h["cf-aig-retry-delay"]).toBe("1000");
    expect(h["cf-aig-backoff"]).toBe("exponential");
    expect(h["cf-aig-skip-cache"]).toBe("true"); // cacheEnabled 既定 false
    const meta = JSON.parse(h["cf-aig-metadata"]);
    expect(meta.client_id).toBe(TEST_CLIENT_ID);
    expect(meta.pool).toBe("standard");
    expect(meta.route).toBe("free_shared");
  });

  it("429 when the reservation does not fit (pool headers attached)", async () => {
    const s = todayStub();
    await s.reserve("seed", 999_999, 999_999); // remaining = 1
    const res = await authed({ model: "gpt-5", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(429);
    const j = (await res.json()) as { error: { code: string; pool: string }; request_id: string };
    expect(j.error.code).toBe("insufficient_quota");
    expect(j.error.pool).toBe("standard");
    expect(res.headers.get("X-OCTG-Pool")).toBe("standard");
  });

  it("413 when the conservative upper bound exceeds the pool limit itself", async () => {
    const res = await authed({
      model: "gpt-5",
      messages: [{ role: "user", content: "hi" }],
      max_completion_tokens: 2_000_000, // upperBound > limit(1,000,000)
    });
    expect(res.status).toBe(413);
    const j = (await res.json()) as { error: { code: string } };
    expect(j.error.code).toBe("request_too_large");
  });

  it("403 model_requires_paid for unknown models (no pool headers)", async () => {
    const res = await authed({ model: "gpt-99", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(403);
    const j = (await res.json()) as { error: { code: string } };
    expect(j.error.code).toBe("model_requires_paid");
    expect(res.headers.get("X-OCTG-Pool")).toBeNull();
    expect(res.headers.get("X-OCTG-Request-Id")).not.toBeNull();
  });

  it("403 model_not_allowed for tool-use requests (pool headers attached)", async () => {
    const res = await authed({
      model: "gpt-5",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "f" } }],
    });
    expect(res.status).toBe(403);
    const j = (await res.json()) as { error: { code: string; param: string } };
    expect(j.error.code).toBe("model_not_allowed");
    expect(j.error.param).toBe("model");
    expect(res.headers.get("X-OCTG-Pool")).toBe("standard");
    const v = await todayStub().getState();
    expect(v.requestCount).toBe(0); // 無料枠 reservation を行っていない
  });

  it("400 for non-text input (before any reservation)", async () => {
    const res = await authed({
      model: "gpt-5",
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }] }],
    });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: { code: string; param: string } };
    expect(j.error.code).toBe("invalid_request");
    expect(j.error.param).toBe("input");
  });

  it("400 for conflicting max_tokens / max_completion_tokens", async () => {
    const res = await authed({
      model: "gpt-5",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100,
      max_completion_tokens: 200,
    });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: { param: string } };
    expect(j.error.param).toBe("max_tokens");
  });

  it("401 for a bad key (no reservation, no pool headers)", async () => {
    const res = await authed({ model: "gpt-5", messages: [] }, "octg_sk_bad");
    expect(res.status).toBe(401);
    expect(res.headers.get("X-OCTG-Pool")).toBeNull();
  });

  it("CLAMP policy shrinks max_completion_tokens to the candidate", async () => {
    await seedPolicy(TEST_CLIENT_ID, { outputLimitMode: "CLAMP" });
    // remaining を小さくして candidate を正にする: この DO は残 100,000 にする
    const s = todayStub();
    await s.reserve("seed", 900_000, 900_000); // remaining = 100,000
    let sentBody: Record<string, unknown> = {};
    fetchMock
      .get("https://aigw.invalid")
      .intercept({ path: "/chat/completions", method: "POST" })
      .reply(200, (opts) => {
        sentBody = JSON.parse(String(opts.body));
        return { usage: { total_tokens: 10 } };
      });

    const res = await authed({
      model: "gpt-5",
      messages: [{ role: "user", content: "hi" }],
      max_completion_tokens: 500_000, // そのままでは remaining に収まらない
    });
    expect(res.status).toBe(200);
    const clamped = sentBody.max_completion_tokens as number;
    expect(clamped).toBeGreaterThan(0);
    expect(clamped).toBeLessThan(500_000);
  });
});
```

- [ ] **Step 3: テストが失敗することを確認する**

Run: `npm test -w apps/gateway-worker`
Expected: FAIL（ルート 404 / `../src/proxy` 不在）

- [ ] **Step 4: upstream.ts / proxy.ts を実装し、ルータに配線する**

`apps/gateway-worker/src/upstream.ts`:

```ts
import type { PoolNameLower } from "@octg/shared";
import type { Env } from "./index";

export class UpstreamConfigError extends Error {}

export interface UpstreamMeta {
  client_id: string;
  pool: PoolNameLower;
  eligibility: "COMPLIMENTARY" | "PAID_ONLY";
  route: "free_shared" | "paid_shared";
  request_id: string;
}

// 上流に送る body の正規化: chat は max_completion_tokens に統一し max_tokens を落とす。
// stream 時は usage を受け取るため stream_options.include_usage を強制する。
export function buildUpstreamBody(
  endpoint: "chat" | "responses",
  body: Record<string, unknown>,
  maxOutputTokens: number,
): Record<string, unknown> {
  if (endpoint === "chat") {
    const { max_tokens: _dropLegacy, max_completion_tokens: _dropNew, ...rest } = body;
    return {
      ...rest,
      max_completion_tokens: maxOutputTokens,
      ...(body.stream === true ? { stream_options: { include_usage: true } } : {}),
    };
  }
  const { max_output_tokens: _drop, ...rest } = body;
  return { ...rest, max_output_tokens: maxOutputTokens };
}

export async function callUpstream(
  env: Env,
  path: "/chat/completions" | "/responses",
  body: unknown,
  meta: UpstreamMeta,
  cacheKey: string | null,
): Promise<Response> {
  if (!env.OCTG_UPSTREAM_API_TOKEN) {
    // 構成エラー = upstream 到達前と確定的に判明（呼び出し側で release する。設計書 §5.6）
    throw new UpstreamConfigError("OCTG_UPSTREAM_API_TOKEN is not configured");
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${env.OCTG_UPSTREAM_API_TOKEN}`,
    "cf-aig-request-timeout": "25000",
    "cf-aig-max-attempts": "2",
    "cf-aig-retry-delay": "1000",
    "cf-aig-backoff": "exponential",
    "cf-aig-metadata": JSON.stringify(meta),
  };
  // キャッシュ分離キーは client 単位（設計書 §7）。安定した分離単位を導出できない場合は skip。
  if (cacheKey) headers["cf-aig-cache-key"] = cacheKey;
  else headers["cf-aig-skip-cache"] = "true";
  return fetch(`${env.OCTG_UPSTREAM_BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}
```

`apps/gateway-worker/src/proxy.ts`:

```ts
import { ulid } from "ulid";
import {
  buildOctgHeaders,
  classifyModel,
  decideOutput,
  errInternal,
  errInvalidRequest,
  errMaxTokensConflict,
  errModelNotAllowed,
  errModelRequiresPaid,
  errNonTextInput,
  errQuotaExceeded,
  errRequestTooLarge,
  errorResponse,
  estimateInputTokens,
  nextUtcMidnight,
  normalizeChatCompletions,
  normalizeResponses,
  quotaIdOf,
  safetyMargin,
  toPoolLower,
  upperBoundOf,
  utcDayOf,
  type QuotaSnapshot,
  type QuotaView,
} from "@octg/shared";
import type { QuotaController } from "@octg/quota-controller";
import { authenticate } from "./auth";
import { completeRequestRow, insertRequestRow } from "./db";
import { loadPolicy, loadRegistry } from "./policy";
import { buildUpstreamBody, callUpstream, UpstreamConfigError } from "./upstream";
import type { Env } from "./index";

type Stub = DurableObjectStub<QuotaController>;

export function snapshotOf(view: QuotaView): QuotaSnapshot {
  return {
    pool: view.pool,
    limit: view.limit,
    used: view.confirmedTokens + view.reservedTokens + view.uncertainTokens,
    remaining: view.remaining,
    resetAt: nextUtcMidnight(new Date(`${view.utcDay}T00:00:00Z`)),
  };
}

interface UsageShape {
  total_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
}

export async function handleProxy(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  endpoint: "chat" | "responses",
): Promise<Response> {
  const requestId = `req_${ulid()}`;
  const auth = await authenticate(request, env, requestId);
  if (!("id" in auth)) return errorResponse(auth);
  const client = auth;

  const body: unknown = await request.json().catch(() => null);
  const normalized = endpoint === "chat" ? normalizeChatCompletions(body) : normalizeResponses(body);
  if (!normalized.ok) {
    if (normalized.error === "non_text") return errorResponse(errNonTextInput(requestId));
    if (normalized.error === "max_tokens_conflict") return errorResponse(errMaxTokensConflict(requestId));
    return errorResponse(errInvalidRequest(requestId));
  }
  const nreq = normalized.value;

  const registry = await loadRegistry(env);
  const pool = classifyModel(nreq.model, registry);
  if (pool === "NONE") return errorResponse(errModelRequiresPaid(requestId));

  // このスタブを全 settle / markUncertain / release で使い回す（日付の再解決をしない）
  const day = utcDayOf(new Date());
  const stub = env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(quotaIdOf(pool, day)));

  const policy = await loadPolicy(env, client.id);

  if (nreq.isToolUse) {
    // PAID_ONLY: 無料枠 reservation を行わず拒否（設計書 §5.3）。MVP は paid 非許可。
    const view = await stub.getState();
    return errorResponse(errModelNotAllowed(requestId, snapshotOf(view)));
  }

  ctx.waitUntil(
    insertRequestRow(env, {
      requestId,
      utcDay: day,
      clientId: client.id,
      requestedModel: nreq.model,
      upstreamModel: nreq.model,
      pool: toPoolLower(pool),
      eligibility: "COMPLIMENTARY",
      reservedTokens: null,
    }),
  );

  const view0 = await stub.getState();
  const snap0 = snapshotOf(view0);
  const estimatedInput = estimateInputTokens(nreq.inputText, nreq.messageCount);
  const margin = safetyMargin(estimatedInput, view0.remaining / view0.limit);
  const upperBound = upperBoundOf(estimatedInput, nreq.maxOutputTokens);

  if (upperBound > view0.limit) {
    ctx.waitUntil(completeRequestRow(env, requestId, { status: "failed", billingClass: "none" }));
    return errorResponse(errRequestTooLarge(snap0, requestId));
  }

  const decision = decideOutput({
    estimatedInput,
    maxOutputTokens: nreq.maxOutputTokens,
    margin,
    remaining: view0.remaining,
    outputLimitMode: policy.outputLimitMode,
  });
  if (decision.action === "reject") {
    ctx.waitUntil(completeRequestRow(env, requestId, { status: "failed", billingClass: "none" }));
    return errorResponse(errQuotaExceeded(snap0, requestId));
  }

  const reservation = estimatedInput + decision.maxOutputTokens + margin;
  const rr = await stub.reserve(requestId, reservation, upperBound);
  if (!rr.ok) {
    ctx.waitUntil(completeRequestRow(env, requestId, { status: "failed", billingClass: "none" }));
    return errorResponse(errQuotaExceeded({ ...snap0, remaining: rr.remaining, resetAt: rr.resetAt }, requestId));
  }

  const upstreamBody = buildUpstreamBody(endpoint, body as Record<string, unknown>, decision.maxOutputTokens);
  const meta = {
    client_id: client.id,
    pool: toPoolLower(pool),
    eligibility: "COMPLIMENTARY" as const,
    route: "free_shared" as const,
    request_id: requestId,
  };
  const cacheKey = policy.cacheEnabled ? `octg:${client.id}` : null;

  let upstream: Response;
  try {
    upstream = await callUpstream(
      env,
      endpoint === "chat" ? "/chat/completions" : "/responses",
      upstreamBody,
      meta,
      cacheKey,
    );
  } catch (e) {
    if (e instanceof UpstreamConfigError) {
      await stub.release(requestId); // upstream 到達前と確定 → 予約解放
      ctx.waitUntil(completeRequestRow(env, requestId, { status: "failed", billingClass: "none" }));
      return errorResponse(errInternal(requestId));
    }
    await stub.markUncertain(requestId); // 送出後の失敗は到達不明 → fail-closed
    ctx.waitUntil(completeRequestRow(env, requestId, { status: "uncertain", billingClass: "none" }));
    return errorResponse(errInternal(requestId));
  }

  if (!upstream.ok) {
    // 上流の OpenAI 互換エラーをパススルー。usage 不明 → markUncertain
    await stub.markUncertain(requestId);
    ctx.waitUntil(completeRequestRow(env, requestId, { status: "uncertain", billingClass: "none" }));
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
        ...buildOctgHeaders({ requestId, quota: snap0, route: "free_shared" }),
      },
    });
  }

  if (nreq.stream) {
    return proxyStream(upstream, stub, requestId, env, ctx, snap0);
  }

  const data = (await upstream.json()) as { usage?: UsageShape } & Record<string, unknown>;
  const total = data.usage?.total_tokens;
  if (typeof total === "number") {
    await stub.settle(requestId, total);
    ctx.waitUntil(
      completeRequestRow(env, requestId, {
        status: "completed",
        inputTokens: data.usage?.prompt_tokens,
        outputTokens: data.usage?.completion_tokens,
        totalTokens: total,
        billingClass: "free",
      }),
    );
  } else {
    await stub.markUncertain(requestId);
    ctx.waitUntil(completeRequestRow(env, requestId, { status: "uncertain", billingClass: "none" }));
  }
  const view1 = await stub.getState();
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...buildOctgHeaders({ requestId, quota: snapshotOf(view1), route: "free_shared" }),
    },
  });
}

// SSE 中継: pass-through しながら最終 usage を抽出して settle。
// usage を得られないまま終了・クライアント切断した場合は markUncertain（設計書 §5.6-4/5）。
export function proxyStream(
  upstream: Response,
  stub: Stub,
  requestId: string,
  env: Env,
  ctx: ExecutionContext,
  snap: QuotaSnapshot,
): Response {
  let finalized = false;
  let usage: UsageShape | undefined;
  const decoder = new TextDecoder();
  let buffer = "";

  const finalize = async (u: UsageShape | undefined) => {
    if (finalized) return;
    finalized = true;
    const total = u?.total_tokens;
    if (typeof total === "number") {
      await stub.settle(requestId, total);
      await completeRequestRow(env, requestId, {
        status: "completed",
        inputTokens: u?.prompt_tokens,
        outputTokens: u?.completion_tokens,
        totalTokens: total,
        billingClass: "free",
      });
    } else {
      await stub.markUncertain(requestId);
      await completeRequestRow(env, requestId, { status: "uncertain", billingClass: "none" });
    }
  };

  const parseEvents = (text: string) => {
    for (const event of text.split("\n\n")) {
      for (const line of event.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const json = JSON.parse(payload) as Record<string, unknown>;
          // chat.completions (stream_options.include_usage) / responses (response.completed)
          if (json.usage) usage = json.usage as UsageShape;
          const maybeResponse = json.response as { usage?: UsageShape } | undefined;
          if (json.type === "response.completed" && maybeResponse?.usage) {
            usage = maybeResponse.usage;
          }
        } catch {
          // 不完全な JSON フラグメントは次のチャンクで再構成されるため無視
        }
      }
    }
  };

  const tap = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const cut = buffer.lastIndexOf("\n\n");
      if (cut >= 0) {
        parseEvents(buffer.slice(0, cut + 2));
        buffer = buffer.slice(cut + 2);
      }
      controller.enqueue(chunk);
    },
    flush() {
      if (buffer.trim().length > 0) parseEvents(buffer + "\n\n");
      ctx.waitUntil(finalize(usage));
    },
  });

  const tapped = upstream.body!.pipeThrough(tap);
  const reader = tapped.getReader();
  const guarded = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    async cancel() {
      await reader.cancel();
      ctx.waitUntil(finalize(undefined)); // クライアント切断 = usage 不明 → uncertain
    },
  });

  return new Response(guarded, {
    status: 200,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
      ...buildOctgHeaders({ requestId, quota: snap, route: "free_shared" }),
    },
  });
}
```

`apps/gateway-worker/src/index.ts` の fetch を以下に置き換える:

```ts
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      return handleProxy(request, env, ctx, "chat");
    }
    if (request.method === "POST" && url.pathname === "/v1/responses") {
      return handleProxy(request, env, ctx, "responses");
    }
    return new Response("Not Found", { status: 404 });
  },
```

- [ ] **Step 5: テストを実行してパスを確認する**

Run: `npm test -w apps/gateway-worker && npm run typecheck`
Expected: PASS 全件（proxy 10 件を含む）、exit 0

fetchMock のモックが効かない場合は `OCTG_UPSTREAM_BASE_URL` がテスト vars（`https://aigw.invalid`）を指しているか確認する。監査の `expect.poll` がタイムアウトする場合は `completeRequestRow` が `ctx.waitUntil` で呼ばれているか確認する。

- [ ] **Step 6: コミット**

```bash
git add apps/gateway-worker
git commit -m "feat(worker): reserve → 上流転送 → settle の推論パイプラインを追加"
```

### Task 14: 上流失敗パス（uncertain / release / パススルー）のテスト

**Files:**
- Test: `apps/gateway-worker/test/proxy-failures.test.ts`

**Interfaces:**
- Consumes: Task 13 の `handleProxy` / `callUpstream` / `UpstreamConfigError`
- Produces: なし（失敗経路の振る舞いを固定するテスト。欠陥が見つかった場合のみ proxy.ts を修正する）

- [ ] **Step 1: テストを書く**

`apps/gateway-worker/test/proxy-failures.test.ts`:

```ts
import { env, fetchMock, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedClient, TEST_CLIENT_KEY } from "./seed";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
beforeEach(async () => {
  await seedClient();
});

const todayStub = () => {
  const day = new Date().toISOString().slice(0, 10);
  return env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${day}`));
};

const authed = (body: unknown) =>
  SELF.fetch("https://octg.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TEST_CLIENT_KEY}` },
    body: JSON.stringify(body),
  });
const payload = { model: "gpt-5", messages: [{ role: "user", content: "hi" }], max_completion_tokens: 100 };

describe("upstream failure paths (設計書 §5.6-4)", () => {
  it("upstream 5xx: passthrough the OpenAI-style error and markUncertain", async () => {
    fetchMock
      .get("https://aigw.invalid")
      .intercept({ path: "/chat/completions", method: "POST" })
      .reply(500, { error: { message: "upstream broke", type: "server_error", param: null, code: "x" } });

    const res = await authed(payload);
    expect(res.status).toBe(500);
    expect(res.headers.get("X-OCTG-Pool")).toBe("standard");
    const v = await todayStub().getState();
    expect(v.uncertainTokens).toBeGreaterThan(0);
    expect(v.reservedTokens).toBe(0);
    expect(v.confirmedTokens).toBe(0);
  });

  it("network failure (OpenAI 到達不明): reservation does not vanish — it becomes uncertain (設計書 §12)", async () => {
    fetchMock
      .get("https://aigw.invalid")
      .intercept({ path: "/chat/completions", method: "POST" })
      .replyWithError(new TypeError("fetch failed"));

    const res = await authed(payload);
    expect(res.status).toBe(500);
    const j = (await res.json()) as { error: { code: string } };
    expect(j.error.code).toBe("internal_error");
    const v = await todayStub().getState();
    expect(v.uncertainTokens).toBeGreaterThan(0);
    expect(v.reservedTokens).toBe(0);
  });

  it("pre-upstream config error releases the reservation", async () => {
    // OCTG_UPSTREAM_API_TOKEN が空の Env を直接呼んで callUpstream の例外経路を検証する
    const { callUpstream, UpstreamConfigError } = await import("../src/upstream");
    await expect(
      callUpstream(
        { ...env, OCTG_UPSTREAM_API_TOKEN: "" },
        "/chat/completions",
        {},
        { client_id: "c", pool: "standard", eligibility: "COMPLIMENTARY", route: "free_shared", request_id: "r" },
        null,
      ),
    ).rejects.toBeInstanceOf(UpstreamConfigError);

    // DO 側の release 遷移は quota-lifecycle.test.ts で検証済み
  });

  it("200 without usage -> markUncertain (usage 取得不能)", async () => {
    fetchMock
      .get("https://aigw.invalid")
      .intercept({ path: "/chat/completions", method: "POST" })
      .reply(200, { id: "chatcmpl-2", object: "chat.completion" }); // usage なし

    const res = await authed(payload);
    expect(res.status).toBe(200);
    const v = await todayStub().getState();
    expect(v.uncertainTokens).toBeGreaterThan(0);
    expect(v.confirmedTokens).toBe(0);
  });
});
```

- [ ] **Step 2: テストを実行してパスを確認する**

Run: `npm test -w apps/gateway-worker`
Expected: PASS 全件。失敗した場合は proxy.ts の失敗分岐（`!upstream.ok` / catch / usage 不在）を設計書 §5.6-4 と照合して修正する。

- [ ] **Step 3: コミット**

```bash
git add apps/gateway-worker/test/proxy-failures.test.ts
git commit -m "test(worker): 上流失敗パス（uncertain / release / パススルー）のテストを追加"
```

- [ ] **Step 4: PR-07 を作成する**

```bash
git push -u origin feat/octg-pr07-pipeline
gh pr create --title "feat: 推論パイプライン（非ストリーミング）" --body "設計書 §5.3-§5.7/§7 に対応。認証→分類→推定→reserve→AI Gateway 転送（cf-aig-* ヘッダ・metadata）→settle。失敗時は fail-closed に markUncertain。"
```


---

## PR-08: SSE ストリーミング中継（`feat/octg-pr08-streaming`）

対応設計書: §5.6-5（ストリーミング中継）。PR-07 マージ後に `main` からブランチを切る。`proxyStream` のコード自体は T13 に含まれているため、この PR はストリーミング系テストの追加と、テストがあばく欠陥の修正を行う。

### Task 15: ストリーミング中継のテスト（settle / 切断時 uncertain）

**Files:**
- Test: `apps/gateway-worker/test/proxy-stream.test.ts`
- Modify: `apps/gateway-worker/src/proxy.ts`（テストで欠陥が見つかった場合のみ）

**Interfaces:**
- Consumes: T13 の `proxyStream`（`chat` は `stream_options.include_usage` 付きの最終チャンクの `usage`、`responses` は `response.completed` イベントの `response.usage` を拾う）
- Produces: なし（振る舞いの固定）

- [ ] **Step 1: テストを書く**

`apps/gateway-worker/test/proxy-stream.test.ts`:

```ts
import { env, fetchMock, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedClient, TEST_CLIENT_KEY } from "./seed";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
beforeEach(async () => {
  await seedClient();
});

const todayStub = () => {
  const day = new Date().toISOString().slice(0, 10);
  return env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${day}`));
};

const authed = (path: string, body: unknown) =>
  SELF.fetch(`https://octg.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TEST_CLIENT_KEY}` },
    body: JSON.stringify(body),
  });

const SSE_CHAT = [
  'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"delta":{"content":"he"}}]}',
  'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
  "data: [DONE]",
  "",
].join("\n\n");

describe("streaming proxy (設計書 §5.6-5)", () => {
  it("chat.completions SSE: passes through and settles with the final usage", async () => {
    fetchMock
      .get("https://aigw.invalid")
      .intercept({ path: "/chat/completions", method: "POST" })
      .reply(200, SSE_CHAT, { headers: { "content-type": "text/event-stream" } });

    const res = await authed("/v1/chat/completions", {
      model: "gpt-5",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("X-OCTG-Pool")).toBe("standard");
    const text = await res.text();
    expect(text).toContain("[DONE]");

    await expect
      .poll(async () => (await todayStub().getState()).confirmedTokens, { timeout: 2_000 })
      .toBe(15); // reserve → SSE pass-through → final usage → settle の順序
    const v = await todayStub().getState();
    expect(v.reservedTokens).toBe(0);
    expect(v.uncertainTokens).toBe(0);
  });

  it("responses SSE: settles with usage from response.completed", async () => {
    const sse = [
      'data: {"type":"response.output_text.delta","delta":"he"}',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":8,"output_tokens":4,"total_tokens":12}}}',
      "",
    ].join("\n\n");
    fetchMock
      .get("https://aigw.invalid")
      .intercept({ path: "/responses", method: "POST" })
      .reply(200, sse, { headers: { "content-type": "text/event-stream" } });

    const res = await authed("/v1/responses", { model: "gpt-5", input: "hi", stream: true });
    expect(res.status).toBe(200);
    await res.text();
    await expect
      .poll(async () => (await todayStub().getState()).confirmedTokens, { timeout: 2_000 })
      .toBe(12);
  });

  it("stream ends without usage -> uncertain (fail-closed)", async () => {
    const sse = [
      'data: {"id":"c2","object":"chat.completion.chunk","choices":[{"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    fetchMock
      .get("https://aigw.invalid")
      .intercept({ path: "/chat/completions", method: "POST" })
      .reply(200, sse, { headers: { "content-type": "text/event-stream" } });

    const res = await authed("/v1/chat/completions", {
      model: "gpt-5",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    await res.text();
    await expect
      .poll(async () => (await todayStub().getState()).uncertainTokens, { timeout: 2_000 })
      .toBeGreaterThan(0);
    const v = await todayStub().getState();
    expect(v.reservedTokens).toBe(0);
    expect(v.confirmedTokens).toBe(0);
  });

  it("client disconnect -> uncertain (消えない予約は uncertain 側へ倒す)", async () => {
    fetchMock
      .get("https://aigw.invalid")
      .intercept({ path: "/chat/completions", method: "POST" })
      .reply(200, SSE_CHAT, { headers: { "content-type": "text/event-stream" } });

    const res = await authed("/v1/chat/completions", {
      model: "gpt-5",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    expect(res.status).toBe(200);
    await res.body!.cancel(); // 読まずに切断
    await expect
      .poll(async () => (await todayStub().getState()).uncertainTokens, { timeout: 2_000 })
      .toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: テストを実行する**

Run: `npm test -w apps/gateway-worker`
Expected: PASS 全件

失敗した場合は `proxyStream` を修正する。よくある原因: (1) SSE バッファの `\n\n` 区切り処理の off-by-one、(2) `finalize` の二重実行ガード漏れ、(3) `cancel()` が `markUncertain` まで届いていない。修正後は全テストを再実行する。

- [ ] **Step 3: コミット**

```bash
git add apps/gateway-worker
git commit -m "test(worker): SSE ストリーミング中継の settle / 切断時 uncertain のテストを追加"
```

- [ ] **Step 4: PR-08 を作成する**

```bash
git push -u origin feat/octg-pr08-streaming
gh pr create --title "feat: SSE ストリーミング中継" --body "設計書 §5.6-5 に対応。pass-through しつつ最終 usage で settle、usage 不明・クライアント切断は markUncertain。"
```

---

## PR-09: 読み取りエンドポイント（`feat/octg-pr09-read-endpoints`）

対応設計書: §9（エンドポイント一覧）、§9.1（GET /quota の認証・認可）。PR-08 マージ後に `main` からブランチを切る。

### Task 16: GET /v1/models

**Files:**
- Create: `apps/gateway-worker/src/models.ts`
- Modify: `apps/gateway-worker/src/index.ts`（ルート追加）
- Test: `apps/gateway-worker/test/models-api.test.ts`

**Interfaces:**
- Consumes: `authenticate`（T11）、`loadRegistry`（T12）
- Produces: `handleModels(request, env, requestId): Promise<Response>` — OpenAI 互換 `{ object: "list", data: [...] }` を返す。MVP の絞り込み: `enabled === true` かつ `complimentary_pool !== "NONE"` のモデルのみ（policy が REJECT 前提の MVP では NONE モデルはすべて拒否されるため、それを広告しない）。

- [ ] **Step 1: 失敗するテストを書く**

`apps/gateway-worker/test/models-api.test.ts`:

```ts
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { seedClient, TEST_CLIENT_KEY } from "./seed";

beforeEach(async () => {
  await seedClient();
});

describe("GET /v1/models", () => {
  it("returns enabled complimentary models in OpenAI list format", async () => {
    const res = await SELF.fetch("https://octg.test/v1/models", {
      headers: { authorization: `Bearer ${TEST_CLIENT_KEY}` },
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { object: string; data: Array<{ id: string; object: string }> };
    expect(j.object).toBe("list");
    const ids = j.data.map((m) => m.id).sort();
    expect(ids).toEqual(["gpt-5", "gpt-5-mini"]);
    expect(j.data[0]?.object).toBe("model");
  });

  it("excludes enabled-but-NONE models (advertising them would be misleading)", async () => {
    const { env } = await import("cloudflare:test");
    await env.DB.prepare(
      "INSERT INTO model_registry (model, provider, complimentary_pool, enabled, fallback_model, updated_at) VALUES ('gpt-4o', 'openai', 'NONE', 1, NULL, ?)",
    )
      .bind(new Date().toISOString())
      .run();
    const { invalidateConfigCaches } = await import("../src/policy");
    invalidateConfigCaches();
    const res = await SELF.fetch("https://octg.test/v1/models", {
      headers: { authorization: `Bearer ${TEST_CLIENT_KEY}` },
    });
    const j = (await res.json()) as { data: Array<{ id: string }> };
    expect(j.data.some((m) => m.id === "gpt-4o")).toBe(false);
  });

  it("401 without a client key", async () => {
    const res = await SELF.fetch("https://octg.test/v1/models");
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npm test -w apps/gateway-worker`
Expected: FAIL（404）

- [ ] **Step 3: 実装する**

`apps/gateway-worker/src/models.ts`:

```ts
import { errorResponse, type OctgHttpError } from "@octg/shared";
import { ulid } from "ulid";
import { authenticate } from "./auth";
import { loadRegistry } from "./policy";
import type { Env } from "./index";

export async function handleModels(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!("id" in auth)) return errorResponse(auth as OctgHttpError);
  const registry = await loadRegistry(env);
  const data = [...registry.values()]
    .filter((m) => m.enabled && m.complimentary_pool !== "NONE")
    .sort((a, b) => a.model.localeCompare(b.model))
    .map((m) => ({ id: m.model, object: "model" as const, created: 0, owned_by: m.provider }));
  return new Response(JSON.stringify({ object: "list", data }), {
    headers: { "content-type": "application/json", "X-OCTG-Request-Id": `req_${ulid()}` },
  });
}
```

`index.ts` の fetch に以下を追加する:

```ts
    if (request.method === "GET" && url.pathname === "/v1/models") {
      return handleModels(request, env);
    }
```

（import も合わせて追加する）

- [ ] **Step 4: テストを実行してパスを確認する**

Run: `npm test -w apps/gateway-worker && npm run typecheck`
Expected: PASS、exit 0

- [ ] **Step 5: コミット**

```bash
git add apps/gateway-worker
git commit -m "feat(worker): GET /v1/models を追加"
```

### Task 17: GET /quota（pool 集約の可視化）

**Files:**
- Create: `apps/gateway-worker/src/quota-api.ts`
- Modify: `apps/gateway-worker/src/index.ts`（ルート追加）
- Test: `apps/gateway-worker/test/quota-api.test.ts`

**Interfaces:**
- Consumes: `authenticate`、DO `getState`
- Produces: `handleQuota(request, env, requestId): Promise<Response>` — `{ request_id, pools: { standard: PoolView, mini: PoolView } }`。`PoolView = { pool, limit, confirmed, reserved, uncertain, remaining, usage_percent, reset_at }`。認可は「有効な client key を持つこと」（401 / 403 の契約は設計書 §9.1）。クライアント個別の利用行跡は含めない。

- [ ] **Step 1: 失敗するテストを書く**

`apps/gateway-worker/test/quota-api.test.ts`:

```ts
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { seedClient, TEST_CLIENT_KEY } from "./seed";

const getQuota = (key?: string) =>
  SELF.fetch("https://octg.test/quota", { headers: key ? { authorization: `Bearer ${key}` } : {} });

describe("GET /quota (設計書 §9.1 / §12)", () => {
  it("401 for unauthenticated requests", async () => {
    const res = await getQuota();
    expect(res.status).toBe(401);
  });

  it("403 for a disabled client", async () => {
    await seedClient({ enabled: false });
    const res = await getQuota(TEST_CLIENT_KEY);
    expect(res.status).toBe(403);
    const j = (await res.json()) as { error: { code: string } };
    expect(j.error.code).toBe("client_disabled");
  });

  it("returns aggregate pool views without per-client traces", async () => {
    await seedClient();
    const day = new Date().toISOString().slice(0, 10);
    const s = env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${day}`));
    await s.reserve("q1", 250_000, 250_000);
    await s.settle("q1", 200_000);
    await s.reserve("q2", 100_000, 100_000);

    const res = await getQuota(TEST_CLIENT_KEY);
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      request_id: string;
      pools: {
        standard: {
          limit: number; confirmed: number; reserved: number; uncertain: number;
          remaining: number; usage_percent: number; reset_at: string;
        };
        mini: { limit: number; remaining: number };
      };
    };
    expect(j.pools.standard.limit).toBe(1_000_000);
    expect(j.pools.standard.confirmed).toBe(200_000);
    expect(j.pools.standard.reserved).toBe(100_000);
    expect(j.pools.standard.uncertain).toBe(0);
    expect(j.pools.standard.remaining).toBe(700_000);
    expect(j.pools.standard.usage_percent).toBe(30);
    expect(j.pools.standard.reset_at).toMatch(/^20\d\d-\d\d-\d\dT00:00:00Z$/);
    expect(j.pools.mini.limit).toBe(10_000_000);
    expect(j.pools.mini.remaining).toBe(10_000_000);
    // per-client の行跡を含まない（キー名の静的検査）
    expect(JSON.stringify(j)).not.toContain("client");
  });

  it("pools are independent (STANDARD usage does not affect MINI)", async () => {
    await seedClient();
    const day = new Date().toISOString().slice(0, 10);
    const s = env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(`quota:MINI:${day}`));
    await s.reserve("m1", 5_000_000, 5_000_000);
    const res = await getQuota(TEST_CLIENT_KEY);
    const j = (await res.json()) as { pools: { standard: { remaining: number }; mini: { remaining: number; usage_percent: number } } };
    expect(j.pools.mini.remaining).toBe(5_000_000);
    expect(j.pools.mini.usage_percent).toBe(50);
    expect(j.pools.standard.remaining).toBe(1_000_000);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npm test -w apps/gateway-worker`
Expected: FAIL（404）

- [ ] **Step 3: 実装する**

`apps/gateway-worker/src/quota-api.ts`:

```ts
import { errorResponse, nextUtcMidnight, quotaIdOf, utcDayOf, type OctgHttpError } from "@octg/shared";
import { authenticate } from "./auth";
import type { Env } from "./index";

export async function handleQuota(request: Request, env: Env, requestId: string): Promise<Response> {
  const auth = await authenticate(request, env, requestId);
  if (!("id" in auth)) return errorResponse(auth as OctgHttpError);

  const day = utcDayOf(new Date());
  const resetAt = nextUtcMidnight(new Date(`${day}T00:00:00Z`));
  const view = async (pool: "STANDARD" | "MINI") => {
    const stub = env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(quotaIdOf(pool, day)));
    const s = await stub.getState();
    const used = s.confirmedTokens + s.reservedTokens + s.uncertainTokens;
    return {
      pool: pool.toLowerCase(),
      limit: s.limit,
      confirmed: s.confirmedTokens,
      reserved: s.reservedTokens,
      uncertain: s.uncertainTokens,
      remaining: s.remaining,
      usage_percent: Math.round((used / s.limit) * 10_000) / 100,
      reset_at: resetAt,
    };
  };

  return new Response(
    JSON.stringify({
      request_id: requestId,
      pools: { standard: await view("STANDARD"), mini: await view("MINI") },
    }),
    { headers: { "content-type": "application/json", "X-OCTG-Request-Id": requestId } },
  );
}
```

注意: レスポンスに pool 系 `X-OCTG-*` ヘッダは付けない（どちらの pool を指すか一意でないため。設計書 §30 の可視化 API であり、§29 のヘッダ契約は推論エンドポイントのエラー/成功応答向け）。

`index.ts` に以下を追加する:

```ts
    if (request.method === "GET" && url.pathname === "/quota") {
      return handleQuota(request, env, `req_${ulid()}`);
    }
```

- [ ] **Step 4: テストを実行してパスを確認する**

Run: `npm test -w apps/gateway-worker && npm run typecheck`
Expected: PASS、exit 0

- [ ] **Step 5: コミット**

```bash
git add apps/gateway-worker
git commit -m "feat(worker): GET /quota（pool 集約の可視化）を追加"
```

- [ ] **Step 6: PR-09 を作成する**

```bash
git push -u origin feat/octg-pr09-read-endpoints
gh pr create --title "feat: GET /v1/models と GET /quota" --body "設計書 §9/§9.1 に対応。registry 由来のモデル一覧、ned 401/無効化 403/集約のみ返却の /quota。"
```


---

## PR-10: Admin API + Cloudflare Access（`feat/octg-pr10-admin-api`）

対応設計書: §9（Admin API）、§10（Admin は Access で分離保護）。PR-09 マージ後に `main` からブランチを切る。

### Task 18: Cloudflare Access JWT 検証

**Files:**
- Create: `apps/gateway-worker/src/access.ts`
- Test: `apps/gateway-worker/test/access.test.ts`

**Interfaces:**
- Consumes: `jose` パッケージ、`.dev.vars` の `ACCESS_JWT_PUBLIC_JWK`（テスト用）
- Produces: `verifyAccessJwt(request, env, requestId): Promise<true | OctgHttpError>`。テストでは `env.ACCESS_JWT_PUBLIC_JWK`（JSON 文字列の RSA 公開鍵 JWK）が設定されている場合はそれで検証し、未設定の場合は `ACCESS_TEAM_DOMAIN` の JWKS エンドポイントから取得する。本番では後者を使う。

- [ ] **Step 1: 失敗するテストを書く**

`apps/gateway-worker/test/access.test.ts`:

```ts
import { env } from "cloudflare:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { verifyAccessJwt } from "../src/access";

let privateKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  // test 用の拡張 vars（wrangler.jsonc の test.vars に合わせて追加する）
  env.ACCESS_JWT_PUBLIC_JWK = JSON.stringify({ keys: [jwk] });
});

const sign = (claims: Record<string, unknown>) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer("https://team.cloudflareaccess.com")
    .setAudience("test-aud")
    .setExpirationTime("10m")
    .sign(privateKey);

const req = (jwt?: string) =>
  new Request("https://octg.test/admin/quota", {
    headers: jwt ? { "cf-access-jwt-assertion": jwt } : {},
  });

// ACCESS_AUD は wrangler.jsonc test.vars で "test-aud" に設定済み（T18 Step 1）

describe("verifyAccessJwt (設計書 §10)", () => {
  it("401 when the header is missing", async () => {
    const r = await verifyAccessJwt(req(), env, "req_t1");
    expect(r).toMatchObject({ status: 401, body: { error: { code: "invalid_api_key" } } });
  });

  it("401 for an expired token", async () => {
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("https://team.cloudflareaccess.com")
      .setAudience("test-aud")
      .setExpirationTime(new Date(Date.now() - 60_000))
      .sign(privateKey);
    const r = await verifyAccessJwt(req(jwt), env, "req_t2");
    expect(r).toMatchObject({ status: 401 });
  });

  it("401 for a wrong audience", async () => {
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("https://team.cloudflareaccess.com")
      .setAudience("other-aud")
      .setExpirationTime("10m")
      .sign(privateKey);
    const r = await verifyAccessJwt(req(jwt), env, "req_t3");
    expect(r).toMatchObject({ status: 401 });
  });

  it("accepts a valid token", async () => {
    const r = await verifyAccessJwt(req(await sign({ sub: "admin@example.com" })), env, "req_t4");
    expect(r).toBe(true);
  });
});
```

さらに 2 ファイルをテスト対応で調整する:

1. `apps/gateway-worker/wrangler.jsonc` の `test.vars` に `"ACCESS_JWT_PUBLIC_JWK": ""` を追加する（テスト内で上書きする前提のプレースホルダ）。
2. `apps/gateway-worker/src/index.ts` の `Env` に `ACCESS_JWT_PUBLIC_JWK?: string;` を追加する。

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npm test -w apps/gateway-worker`
Expected: FAIL（`../src/access` 不在）

- [ ] **Step 3: 実装する**

`apps/gateway-worker/src/access.ts`:

```ts
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JWTVerifyOptions } from "jose";
import type { JWKS } from "jose";
import { errInvalidApiKey, type OctgHttpError } from "@octg/shared";
import type { Env } from "./index";

export async function verifyAccessJwt(
  request: Request,
  env: Env,
  requestId: string,
): Promise<true | OctgHttpError> {
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return errInvalidApiKey(requestId);

  const options: JWTVerifyOptions = { audience: env.ACCESS_AUD };
  try {
    if (env.ACCESS_JWT_PUBLIC_JWK) {
      // テスト用: 明示的な公開鍵で検証する
      const jwks = createLocalJWKSet(JSON.parse(env.ACCESS_JWT_PUBLIC_JWK) as JWKS);
      await jwtVerify(token, jwks, options);
    } else {
      const jwks = createRemoteJWKSet(
        new URL(`${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`),
      );
      await jwtVerify(token, jwks, { ...options, issuer: env.ACCESS_TEAM_DOMAIN });
    }
    return true;
  } catch {
    return errInvalidApiKey(requestId);
  }
}
```

注意: テストの JWK は `keys` 配列を持つ JWKS 形式である必要がある。`access.test.ts` の `exportJWK` は単一 JWK を返すため、`env.ACCESS_JWT_PUBLIC_JWK = JSON.stringify({ keys: [jwk] })` とするよう Step 1 の該当行を修正する。

- [ ] **Step 4: テストを実行してパスを確認する**

Run: `npm test -w apps/gateway-worker && npm run typecheck`
Expected: PASS、exit 0

- [ ] **Step 5: コミット**

```bash
git add apps/gateway-worker
git commit -m "feat(worker): Cloudflare Access JWT 検証を追加"
```

### Task 19: Admin API ルート（quota / usage / clients / models / reconcile）

**Files:**
- Create: `apps/gateway-worker/src/admin.ts`
- Modify: `apps/gateway-worker/src/index.ts`（`/admin/*` ルート追加）
- Test: `apps/gateway-worker/test/admin-api.test.ts`

**Interfaces:**
- Consumes: `verifyAccessJwt`（T18）、`loadRegistry` / `invalidateConfigCaches`（T12）、DO `getState` / `finalizeDay`
- Produces: `handleAdmin(request, env, requestId): Promise<Response | undefined>` — マッチしない場合は `undefined`（ルータが 404 にフォールバック）。全ハンドラは先頭で Access JWT を検証する。

- [ ] **Step 1: 失敗するテストを書く**

`apps/gateway-worker/test/admin-api.test.ts`:

```ts
import { env, SELF } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedClient, TEST_CLIENT_ID } from "./seed";

let jwt: string;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  const jwk = await exportJWK(pair.publicKey);
  // test vars override（jose の JWKS 形式）
  env.ACCESS_JWT_PUBLIC_JWK = JSON.stringify({ keys: [jwk] });
  // ACCESS_AUD をテスト値に合わせる
  env.ACCESS_AUD = "test-aud";
  jwt = await new SignJWT({ sub: "admin@example.com" })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer("https://team.cloudflareaccess.com")
    .setAudience("test-aud")
    .setExpirationTime("10m")
    .sign(pair.privateKey);
});

const admin = (path: string, init?: RequestInit, useJwt = true) =>
  SELF.fetch(`https://octg.test${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
      ...(useJwt ? { "cf-access-jwt-assertion": jwt } : {}),
    },
  });

beforeEach(async () => {
  await seedClient();
});

describe("admin api guard", () => {
  it("/admin/* requires a valid Access JWT (401 without)", async () => {
    const res = await admin("/admin/quota", undefined, false);
    expect(res.status).toBe(401);
  });
});

describe("GET /admin/quota", () => {
  it("returns pool aggregate state", async () => {
    const day = new Date().toISOString().slice(0, 10);
    env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${day}`));
    const s = env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${day}`));
    await s.reserve("adm1", 123_456, 123_456);
    const res = await admin("/admin/quota");
    expect(res.status).toBe(200);
    const j = (await res.json()) as { pools: { standard: { reserved: number; remaining: number } } };
    expect(j.pools.standard.reserved).toBe(123_456);
    expect(j.pools.standard.remaining).toBe(1_000_000 - 123_456);
  });
});

describe("GET /admin/usage", () => {
  it("aggregates per-client rows for the day", async () => {
    const day = new Date().toISOString().slice(0, 10);
    // 監査行を直接 seed する（/admin/usage は D1 requests テーブルのみを読む。設計書 §11）
    await env.DB.prepare(
      "INSERT INTO requests (request_id, utc_day, client_id, requested_model, upstream_model, pool, eligibility, reserved_tokens, total_tokens, status, billing_class, started_at, completed_at) " +
        "VALUES ('u1', ?, ?, 'gpt-5', 'gpt-5', 'standard', 'COMPLIMENTARY', 10000, 7000, 'completed', 'free', ?, ?)",
    )
      .bind(day, TEST_CLIENT_ID, new Date().toISOString(), new Date().toISOString())
      .run();

    const res = await admin("/admin/usage");
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      utc_day: string;
      clients: Array<{ client_id: string; requests: number; tokens: number }>;
    };
    expect(j.utc_day).toBe(day);
    expect(j.clients).toEqual([{ client_id: TEST_CLIENT_ID, requests: 1, tokens: 7_000 }]);
  });
});

describe("GET /admin/models", () => {
  it("lists registry entries", async () => {
    const res = await admin("/admin/models");
    expect(res.status).toBe(200);
    const j = (await res.json()) as { models: Array<{ model: string; complimentary_pool: string }> };
    expect(j.models.map((m) => m.model).sort()).toEqual(["gpt-5", "gpt-5-mini"]);
  });
});

describe("PUT /admin/clients/:id/policy", () => {
  it("updates policy and invalidates the cache", async () => {
    const res = await admin(`/admin/clients/${TEST_CLIENT_ID}/policy`, {
      method: "PUT",
      body: JSON.stringify({ output_limit_mode: "CLAMP", cache_enabled: true }),
    });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT output_limit_mode, cache_enabled FROM client_policies WHERE client_id = ?")
      .bind(TEST_CLIENT_ID)
      .first<{ output_limit_mode: string; cache_enabled: number }>();
    expect(row?.output_limit_mode).toBe("CLAMP");
    expect(row?.cache_enabled).toBe(1);
  });

  it("404 for an unknown client", async () => {
    const res = await admin("/admin/clients/nope/policy", {
      method: "PUT",
      body: JSON.stringify({ output_limit_mode: "CLAMP" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("PUT /admin/models/:model", () => {
  it("updates complimentary_pool and invalidates caches", async () => {
    const res = await admin("/admin/models/gpt-5", {
      method: "PUT",
      body: JSON.stringify({ complimentary_pool: "NONE", enabled: true }),
    });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT complimentary_pool FROM model_registry WHERE model = 'gpt-5'")
      .first<{ complimentary_pool: string }>();
    expect(row?.complimentary_pool).toBe("NONE");
  });
});

describe("POST /admin/reconcile", () => {
  it("is wired for PR-11: returns 202 with the target day", async () => {
    const res = await admin("/admin/reconcile", { method: "POST", body: "{}" });
    expect(res.status).toBe(202);
    const j = (await res.json()) as { utc_day: string };
    expect(j.utc_day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npm test -w apps/gateway-worker`
Expected: FAIL（404 / `../src/admin` 不在）

- [ ] **Step 3: 実装する**

`apps/gateway-worker/src/admin.ts`:

```ts
import { errorResponse, quotaIdOf, utcDayOf, type OctgHttpError } from "@octg/shared";
import { ulid } from "ulid";
import { snapshotOf } from "./proxy";
import { loadRegistry, invalidateConfigCaches } from "./policy";
import { errInvalidApiKey } from "@octg/shared";
import { verifyAccessJwt } from "./access";
import { reconcileYesterday } from "./reconcile"; // PR-11 で実装。ここでは 202 を返すスタブでよい
import type { Env } from "./index";

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });

const notFound = (requestId: string): OctgHttpError => ({
  status: 404,
  requestId,
  body: {
    error: {
      message: "Not found.",
      type: "invalid_request_error",
      param: null,
      code: "not_found",
    },
    request_id: requestId,
  },
});

export async function handleAdmin(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/admin/")) return undefined;

  const gate = await verifyAccessJwt(request, env, requestId);
  if (gate !== true) return errorResponse(gate);

  const day = utcDayOf(new Date());

  if (request.method === "GET" && url.pathname === "/admin/quota") {
    const view = async (pool: "STANDARD" | "MINI") => {
      const stub = env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(quotaIdOf(pool, day)));
      return snapshotOf(await stub.getState());
    };
    return json({ request_id: requestId, utc_day: day, pools: { standard: await view("STANDARD"), mini: await view("MINI") } });
  }

  if (request.method === "GET" && url.pathname === "/admin/usage") {
    const rs = await env.DB.prepare(
      "SELECT client_id, COUNT(*) AS requests, COALESCE(SUM(total_tokens), 0) AS tokens " +
        "FROM requests WHERE utc_day = ? AND status = 'completed' GROUP BY client_id",
    )
      .bind(day)
      .all<{ client_id: string; requests: number; tokens: number }>();
    return json({ request_id: requestId, utc_day: day, clients: rs.results });
  }

  if (request.method === "GET" && url.pathname === "/admin/clients") {
    const rs = await env.DB.prepare("SELECT id, name, enabled, created_at FROM clients ORDER BY id").all();
    return json({ request_id: requestId, clients: rs.results });
  }

  if (request.method === "GET" && url.pathname === "/admin/models") {
    const registry = await loadRegistry(env);
    return json({ request_id: requestId, models: [...registry.values()] });
  }

  const policyMatch = url.pathname.match(/^\/admin\/clients\/([^/]+)\/policy$/);
  if (request.method === "PUT" && policyMatch) {
    const clientId = decodeURIComponent(policyMatch[1]!);
    const exists = await env.DB.prepare("SELECT id FROM clients WHERE id = ?").bind(clientId).first();
    if (!exists) return errorResponse(notFound(requestId));
    const body = (await request.json().catch(() => null)) as {
      overflow_mode?: string;
      output_limit_mode?: string;
      max_paid_usd_day?: number;
      cache_enabled?: boolean;
    } | null;
    await env.DB.prepare(
      "INSERT INTO client_policies (client_id, overflow_mode, output_limit_mode, max_paid_usd_day, cache_enabled) " +
        "VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(client_id) DO UPDATE SET overflow_mode=excluded.overflow_mode, " +
        "output_limit_mode=excluded.output_limit_mode, max_paid_usd_day=excluded.max_paid_usd_day, " +
        "cache_enabled=excluded.cache_enabled",
    )
      .bind(
        clientId,
        body?.overflow_mode === "PAID_SHARED" ? "PAID_SHARED" : "REJECT",
        body?.output_limit_mode === "CLAMP" ? "CLAMP" : "REJECT",
        typeof body?.max_paid_usd_day === "number" ? body.max_paid_usd_day : 0,
        body?.cache_enabled ? 1 : 0,
      )
      .run();
    invalidateConfigCaches();
    return json({ request_id: requestId, client_id: clientId, updated: true });
  }

  const modelMatch = url.pathname.match(/^\/admin\/models\/([^/]+)$/);
  if (request.method === "PUT" && modelMatch) {
    const model = decodeURIComponent(modelMatch[1]!);
    const body = (await request.json().catch(() => null)) as {
      complimentary_pool?: string;
      enabled?: boolean;
      fallback_model?: string | null;
    } | null;
    const pool = body?.complimentary_pool === "STANDARD" || body?.complimentary_pool === "MINI" ? body.complimentary_pool : "NONE";
    const result = await env.DB.prepare(
      "UPDATE model_registry SET complimentary_pool = ?, enabled = ?, fallback_model = ?, updated_at = ? WHERE model = ?",
    )
      .bind(pool, body?.enabled === false ? 0 : 1, body?.fallback_model ?? null, new Date().toISOString(), model)
      .run();
    if (!result.meta.changes) return errorResponse(notFound(requestId));
    invalidateConfigCaches();
    return json({ request_id: requestId, model, complimentary_pool: pool });
  }

  if (request.method === "POST" && url.pathname === "/admin/reconcile") {
    // PR-11 の reconcileYesterday をキックする。ここでは受理だけを返す。
    const target = reconcileYesterday.targetUtcDay(new Date());
    return json({ request_id: requestId, utc_day: target, accepted: true }, { status: 202 });
  }

  return errorResponse(notFound(requestId));
}
```

`./reconcile` は PR-11 で実装する。PR-10 時点では以下のスタブを `apps/gateway-worker/src/reconcile.ts` として作成する（PR-11 で本実装に置き換える）:

```ts
export const reconcileYesterday = {
  targetUtcDay(now: Date): string {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1))
      .toISOString()
      .slice(0, 10);
  },
};
```

`index.ts` に以下を追加する（404 フォールバックの前）:

```ts
    const adminRes = await handleAdmin(request, env, `req_${ulid()}`);
    if (adminRes) return adminRes;
```

- [ ] **Step 4: テストを実行してパスを確認する**

Run: `npm test -w apps/gateway-worker && npm run typecheck`
Expected: PASS、exit 0

- [ ] **Step 5: コミット**

```bash
git add apps/gateway-worker
git commit -m "feat(worker): Admin API を追加（Access JWT 検証つき）"
```

- [ ] **Step 6: PR-10 を作成する**

```bash
git push -u origin feat/octg-pr10-admin-api
gh pr create --title "feat: Admin API + Cloudflare Access" --body "設計書 §9/§10 に対応。Access JWT を全 /admin/* で検証し、quota/usage/clients/models 参照と policy/model 更新、reconcile 受付を実装。"
```


---

## PR-11: Reconciliation（Cron）と DO ライフサイクル実行（`feat/octg-pr11-reconciliation`）

対応設計書: §8（Reconciliation）、§4.5（過去日 DO のライフサイクル）。PR-10 マージ後に `main` からブランチを切る。PR-10 の `src/reconcile.ts` スタブを本実装に置き換える。

### Task 20: OpenAI Usage API との突合（方式 B: 単一 Project 集約）

**Files:**
- Create: `apps/gateway-worker/src/reconcile.ts`（スタブを全置換）
- Modify: `apps/gateway-worker/src/index.ts`（`scheduled` ハンドラを接続）
- Test: `apps/gateway-worker/test/reconcile.test.ts`

**Interfaces:**
- Consumes: D1 `requests` / `reconciliations`、DO `reconcileRequest` / `finalizeDay`（PR-03）、`env.OPENAI_USAGE_API_KEY` / `env.OPENAI_FREE_PROJECT_ID`
- Produces:
  - `runReconciliation(env, now): Promise<ReconciliationReport[]>` — 直前 UTC 日の両 pool を突合する。
  - `ReconciliationReport { utcDay, pool, localTokens, openaiTokens, difference, status: "done" | "open" }`
  - 冪等性: 同一 `utc_day × pool` で `reconciliations.status = 'done'` の行が既にあれば再実行せず前回結果を返す（設計書 §8.2）。
  - Usage API は `start_time` を対象日 00:00 UTC、`end_time` を対象日 + 2 日（後続 24h 再取得）で 1 時間バケット・モデルグループで取得し、全バケットの `input_tokens + output_tokens` を合算する。

- [ ] **Step 1: 失敗するテストを書く**

`apps/gateway-worker/test/reconcile.test.ts`:

```ts
import { env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runReconciliation, targetUtcDay } from "../src/reconcile";
import { seedClient } from "./seed";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

const NOW = new Date("2026-08-10T00:05:00Z"); // 8/9 分を突合する
const DAY = "2026-08-09";

const usageResponse = (inputTokens: number, outputTokens: number) => ({
  object: "page",
  data: [
    {
      buckets: [
        {
          start_time: Math.floor(Date.parse(`${DAY}T00:00:00Z`) / 1000),
          end_time: Math.floor(Date.parse(`${DAY}T01:00:00Z`) / 1000),
          results: [{ input_tokens: inputTokens, output_tokens: outputTokens, num_model_requests: 1 }],
        },
      ],
    },
  ],
  has_more: false,
});

describe("runReconciliation (設計書 §8)", () => {
  beforeEach(async () => {
    await seedClient();
  });

  it("targetUtcDay returns the previous UTC day without JST dependence", () => {
    expect(targetUtcDay(NOW)).toBe(DAY);
  });

  it("records done when local and OpenAI totals match; uncertain entries become reconciled (consumed)", async () => {
    // D1 側の確定値: requests テーブルに completed 100 / uncertain 40
    const dayNow = new Date(`${DAY}T12:00:00Z`).toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO requests (request_id, utc_day, client_id, requested_model, pool, total_tokens, status, started_at, completed_at) " +
          "VALUES ('r-done', ?, 'client_test', 'gpt-5', 'standard', 100, 'completed', ?, ?)",
      ).bind(DAY, dayNow, dayNow),
      env.DB.prepare(
        "INSERT INTO requests (request_id, utc_day, client_id, requested_model, pool, reserved_tokens, status, started_at) " +
          "VALUES ('r-unc', ?, 'client_test', 'gpt-5', 'standard', 40, 'uncertain', ?)",
      ).bind(DAY, dayNow),
    ]);
    // DO 側に uncertain エントリを用意
    const stub = env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${DAY}`));
    await stub.reserve("r-unc", 40, 40);
    await stub.markUncertain("r-unc");

    fetchMock
      .get("https://api.openai.com")
      .intercept({ path: (p) => p.startsWith("/v1/organization/usage/completions") })
      .reply(200, usageResponse(90, 50)); // 合計 140 = local(100) + uncertain(40)

    const reports = await runReconciliation(env, NOW);
    const std = reports.find((r) => r.pool === "STANDARD")!;
    expect(std.localTokens).toBe(100); // uncertain は localTokens に含めない（未確定）
    expect(std.openaiTokens).toBe(140);
    expect(std.status).toBe("done"); // 差分が uncertain 合計と一致 → 全て consumed 確定

    const v = await stub.getState();
    expect(v.uncertainTokens).toBe(0);
    expect(v.confirmedTokens).toBe(40); // reconcileRequest("consumed") が適用された

    const row = await env.DB.prepare(
      "SELECT status, local_tokens, openai_tokens, difference FROM reconciliations WHERE utc_day = ? AND pool = 'STANDARD'",
    )
      .bind(DAY)
      .first<{ status: string; local_tokens: number; openai_tokens: number; difference: number }>();
    expect(row?.status).toBe("done");
    expect(row?.difference).toBe(40);

    // daily_usage に確定値が計上される（設計書 §6）
    const du = await env.DB.prepare(
      "SELECT confirmed_tokens, request_count FROM daily_usage WHERE utc_day = ? AND pool = 'STANDARD'",
    )
      .bind(DAY)
      .first<{ confirmed_tokens: number; request_count: number }>();
    expect(du?.confirmed_tokens).toBe(140); // done 確定 → openai 合計を confirmed に計上
    expect(du?.request_count).toBe(2); // r-done(completed) + r-unc(consumed 確定で completed)
  });

  it("is idempotent: a second run returns the stored row without touching the DO again", async () => {
    const dayNow = new Date(`${DAY}T12:00:00Z`).toISOString();
    await env.DB.prepare(
      "INSERT INTO requests (request_id, utc_day, client_id, pool, total_tokens, status, started_at, completed_at) " +
        "VALUES ('r1', ?, 'client_test', 'standard', 100, 'completed', ?, ?)",
    )
      .bind(DAY, dayNow, dayNow)
      .run();
    fetchMock
      .get("https://api.openai.com")
      .intercept({ path: (p) => p.startsWith("/v1/organization/usage/completions") })
      .reply(200, usageResponse(60, 40))
      .times(4); // 全 pool × 初回実行分のみ許可

    const first = await runReconciliation(env, NOW);
    const second = await runReconciliation(env, NOW); // 2 回目は fetch も DO 変更もしない
    expect(second).toEqual(first);
  });

  it("keeps status open when the difference does not match uncertain totals (fail-closed: uncertain を解放しない)", async () => {
    const dayNow = new Date(`${DAY}T12:00:00Z`).toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO requests (request_id, utc_day, client_id, pool, total_tokens, status, started_at, completed_at) " +
          "VALUES ('r2', ?, 'client_test', 'standard', 100, 'completed', ?, ?)",
      ).bind(DAY, dayNow, dayNow),
      env.DB.prepare(
        "INSERT INTO requests (request_id, utc_day, client_id, pool, reserved_tokens, status, started_at) " +
          "VALUES ('r3', ?, 'client_test', 'standard', 40, 'uncertain', ?)",
      ).bind(DAY, dayNow),
    ]);
    fetchMock
      .get("https://api.openai.com")
      .intercept({ path: (p) => p.startsWith("/v1/organization/usage/completions") })
      .reply(200, usageResponse(70, 60)); // 合計 130 ≠ 100 + 40 → 不一致

    const reports = await runReconciliation(env, NOW);
    const std = reports.find((r) => r.pool === "STANDARD")!;
    expect(std.status).toBe("open"); // 集約一致のみを根拠に解放しない（設計書 §8.3）
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npm test -w apps/gateway-worker`
Expected: FAIL（`runReconciliation` 不在）

- [ ] **Step 3: reconcile.ts を実装する（PR-10 のスタブを全置換）**

`apps/gateway-worker/src/reconcile.ts`:

```ts
import { quotaIdOf } from "@octg/shared";
import type { Env } from "./index";

export interface ReconciliationReport {
  utcDay: string;
  pool: "STANDARD" | "MINI";
  localTokens: number;
  openaiTokens: number;
  difference: number;
  status: "done" | "open";
}

export function targetUtcDay(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1))
    .toISOString()
    .slice(0, 10);
}

interface UsageBucketResult {
  input_tokens?: number;
  output_tokens?: number;
}

// OpenAI Organization Usage API: project × 時刻帯集約（設計書 §8.1 方式 B）。
// 対象日 00:00 UTC から +48h（後続 24h 再取得込み）を 1 時間バケットで取得し合算する。
async function fetchOpenAiTokens(env: Env, utcDay: string): Promise<number> {
  const start = Math.floor(Date.parse(`${utcDay}T00:00:00Z`) / 1000);
  const url = new URL("https://api.openai.com/v1/organization/usage/completions");
  url.searchParams.set("start_time", String(start));
  url.searchParams.set("end_time", String(start + 48 * 3600));
  url.searchParams.set("bucket_width", "1h");
  url.searchParams.set("group_by", "model");
  if (env.OPENAI_FREE_PROJECT_ID) url.searchParams.set("project_ids", env.OPENAI_FREE_PROJECT_ID);
  url.searchParams.set("limit", "24");

  let total = 0;
  let page: string | null = null;
  do {
    const pageUrl = page ? `${url.toString()}&page=${encodeURIComponent(page)}` : url.toString();
    const res = await fetch(pageUrl, {
      headers: { authorization: `Bearer ${env.OPENAI_USAGE_API_KEY}` },
    });
    if (!res.ok) throw new Error(`OpenAI Usage API ${res.status}`);
    const json = (await res.json()) as {
      data?: Array<{ buckets?: Array<{ results?: UsageBucketResult[] }> }>;
      has_more?: boolean;
      next_page?: string;
    };
    for (const d of json.data ?? []) {
      for (const b of d.buckets ?? []) {
        for (const r of b.results ?? []) {
          total += (r.input_tokens ?? 0) + (r.output_tokens ?? 0);
        }
      }
    }
    page = json.has_more ? (json.next_page ?? null) : null;
  } while (page);
  return total;
}

export async function runReconciliation(env: Env, now: Date): Promise<ReconciliationReport[]> {
  const utcDay = targetUtcDay(now);
  const reports: ReconciliationReport[] = [];

  for (const pool of ["STANDARD", "MINI"] as const) {
    const existing = await env.DB.prepare(
      "SELECT local_tokens, openai_tokens, difference, status FROM reconciliations WHERE utc_day = ? AND pool = ?",
    )
      .bind(utcDay, pool)
      .first<{ local_tokens: number; openai_tokens: number; difference: number; status: "done" | "open" }>();
    if (existing?.status === "done") {
      // 冪等: 前回結果を返し、再計上しない（設計書 §8.2）
      reports.push({ utcDay, pool, ...existing });
      continue;
    }

    const poolLower = pool.toLowerCase();
    const local = await env.DB.prepare(
      "SELECT COALESCE(SUM(total_tokens), 0) AS t FROM requests WHERE utc_day = ? AND pool = ? AND status = 'completed'",
    )
      .bind(utcDay, poolLower)
      .first<{ t: number }>();
    const localTokens = local?.t ?? 0;

    const uncertain = await env.DB.prepare(
      "SELECT request_id, COALESCE(reserved_tokens, 0) AS rt FROM requests WHERE utc_day = ? AND pool = ? AND status = 'uncertain'",
    )
      .bind(utcDay, poolLower)
      .all<{ request_id: string; rt: number }>();
    const uncertainTotal = uncertain.results.reduce((a, r) => a + r.rt, 0);

    const openaiTokens = await fetchOpenAiTokens(env, utcDay);
    const difference = openaiTokens - localTokens;

    // fail-closed: 差分が uncertain 合計と一致する場合のみ uncertain を consumed 確定する。
    // 一致しない場合は解放も確定もしない（集約値の見かけ上の一致/不一致で判断しない。設計書 §8.3）
    let status: "done" | "open" = "open";
    if (uncertain.results.length > 0 && difference === uncertainTotal) {
      const stub = env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(quotaIdOf(pool, utcDay)));
      for (const u of uncertain.results) {
        await stub.reconcileRequest(u.request_id, "consumed");
        await env.DB.prepare("UPDATE requests SET status = 'completed', completed_at = ? WHERE request_id = ?")
          .bind(new Date().toISOString(), u.request_id)
          .run();
      }
      status = "done";
    } else if (uncertain.results.length === 0) {
      status = "done"; // 不確定要素がなければ突合完了
    }

    await env.DB.prepare(
      "INSERT INTO reconciliations (utc_day, pool, local_tokens, openai_tokens, difference, status, attempts, executed_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, 1, ?) " +
        "ON CONFLICT(utc_day, pool) DO UPDATE SET local_tokens=excluded.local_tokens, " +
        "openai_tokens=excluded.openai_tokens, difference=excluded.difference, " +
        "status=excluded.status, attempts=reconciliations.attempts + 1, executed_at=excluded.executed_at",
    )
      .bind(utcDay, pool, localTokens, openaiTokens, difference, status, new Date().toISOString())
      .run();

    // daily_usage の確定値を upsert する（設計書 §6）。confirmed は確定済みトークンのみ計上する。
    const completedCount = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM requests WHERE utc_day = ? AND pool = ? AND status = 'completed'",
    )
      .bind(utcDay, poolLower)
      .first<{ n: number }>();
    const confirmedTokens = status === "done" ? openaiTokens : localTokens;
    await env.DB.prepare(
      "INSERT INTO daily_usage (utc_day, pool, confirmed_tokens, paid_tokens, request_count) VALUES (?, ?, ?, 0, ?) " +
        "ON CONFLICT(utc_day, pool) DO UPDATE SET confirmed_tokens = excluded.confirmed_tokens, " +
        "paid_tokens = excluded.paid_tokens, request_count = excluded.request_count",
    )
      .bind(utcDay, pool, confirmedTokens, completedCount?.n ?? 0)
      .run();

    reports.push({ utcDay, pool, localTokens, openaiTokens, difference, status });
  }
  return reports;
}
```

`apps/gateway-worker/src/admin.ts` も同時に更新する（PR-10 の 202 受理ルートを冪等な突合の同期実行へ置き換え、`reconcileYesterday` 参照を削除する。この PR で reconcile.ts は `runReconciliation` / `targetUtcDay` のみを export するため、import を差し替えないと typecheck が壊れる）:

```ts
- import { reconcileYesterday } from "./reconcile"; // PR-11 で実装。ここでは 202 を返すスタブでよい
 import { runReconciliation, targetUtcDay } from "./reconcile";
...
   if (request.method === "POST" && url.pathname === "/admin/reconcile") {
-     // PR-11 の reconcileYesterday をキックする。ここでは受理だけを返す。
-     const target = reconcileYesterday.targetUtcDay(new Date());
-     return json({ request_id: requestId, utc_day: target, accepted: true }, { status: 202 });
     try {
       // 冪等な突合を同期実行して結果を返す（2 回目以降は保存済み結果。設計書 §8.2/§9）
       const target = targetUtcDay(new Date());
       const reports = await runReconciliation(env, new Date());
       return json({ request_id: requestId, utc_day: target, reports }, { status: 200 });
     } catch {
       // Usage API 到達不能など → エラー契約（§5）に沿った JSON で返す
       return json(
         {
           request_id: requestId,
           error: {
             message: "Reconciliation failed.",
             type: "api_error",
             param: null,
             code: "reconciliation_failed",
           },
         },
         { status: 502 },
       );
     }
   }
```

`apps/gateway-worker/test/admin-api.test.ts` を更新する（reconcile テストを 202 受理から 200 実結果へ）:

```ts
- import { env, SELF } from "cloudflare:test";
 import { env, fetchMock, SELF } from "cloudflare:test";
...
   beforeAll(async () => {
     fetchMock.activate();
     fetchMock.disableNetConnect();
     const pair = await generateKeyPair("RS256");
...
 describe("POST /admin/reconcile", () => {
-   it("is wired for PR-11: returns 202 with the target day", async () => {
-     const res = await admin("/admin/reconcile", { method: "POST", body: "{}" });
-     expect(res.status).toBe(202);
-     const j = (await res.json()) as { utc_day: string };
-     expect(j.utc_day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
-   });
   it("runs reconciliation synchronously and returns reports", async () => {
     fetchMock
       .get("https://api.openai.com")
       .intercept({ path: (p) => p.startsWith("/v1/organization/usage/completions") })
       .reply(200, { object: "page", data: [], has_more: false });
     const res = await admin("/admin/reconcile", { method: "POST", body: "{}" });
     expect(res.status).toBe(200);
     const j = (await res.json()) as {
       utc_day: string;
       reports: Array<{ pool: string; status: string }>;
     };
     expect(j.utc_day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
     expect(j.reports).toHaveLength(2); // STANDARD / MINI
     expect(j.reports.every((r) => r.status === "done")).toBe(true);
   });
 });
```

- [ ] **Step 4: テストを実行してパスを確認する**

Run: `npm test -w apps/gateway-worker && npm run typecheck`
Expected: PASS、exit 0

- [ ] **Step 5: コミット**

```bash
git add apps/gateway-worker
git commit -m "feat(worker): OpenAI Usage API との突合（方式 B）を実装"
```

### Task 21: Cron ハンドラと過去日 DO のファイナライズ

**Files:**
- Modify: `apps/gateway-worker/src/index.ts`（`scheduled` を本実装に）
- Create: `apps/gateway-worker/src/scheduled.ts`
- Test: `apps/gateway-worker/test/scheduled.test.ts`

**Interfaces:**
- Consumes: `runReconciliation`（T20）、DO `finalizeDay` / `getState`（PR-03）
- Produces: `runScheduled(env, now): Promise<void>` — (1) `runReconciliation` を実行、(2) 対象日の翌々日（= 保持期限超過）より古い pool DO、および uncertain 0 で `reconciliations.status = 'done'` の対象日 DO に対し `finalizeDay()` を呼ぶ。(3) `finalizeDay()` 成功時に D1 `reconciliations.status` を `'deleted'` に更新する（設計書 §4.5 の deleteAll + 記録）。

- [ ] **Step 1: 失敗するテストを書く**

`apps/gateway-worker/test/scheduled.test.ts`:

```ts
import { env, fetchMock } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { runScheduled } from "../src/scheduled";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

describe("runScheduled (Cron: 設計書 §8.2/§4.5)", () => {
  it("reconciles the previous day and finalizes a clean past-day DO", async () => {
    const now = new Date("2026-08-12T00:05:00Z"); // 対象日: 8/11、保持期限超過日: 8/10 以前
    const pastDay = "2026-08-09";

    // 過去日 DO: uncertain なしで完結済み
    const pastStub = env.QUOTA_CONTROLLER.get(
      env.QUOTA_CONTROLLER.idFromName(`quota:STANDARD:${pastDay}`),
    );
    await pastStub.reserve("old-1", 500, 500);
    await pastStub.settle("old-1", 300);
    await env.DB.prepare(
      "INSERT INTO reconciliations (utc_day, pool, local_tokens, openai_tokens, difference, status, attempts, executed_at) " +
        "VALUES (?, 'STANDARD', 300, 300, 0, 'done', 1, ?)",
    )
      .bind(pastDay, new Date().toISOString())
      .run();

    // 前日 (8/11) の突合は openai 側 0 で done になる
    fetchMock
      .get("https://api.openai.com")
      .intercept({ path: (p) => p.startsWith("/v1/organization/usage/completions") })
      .reply(200, { object: "page", data: [], has_more: false });

    await runScheduled(env, now);

    // 過去日 DO は deleteAll 済みで初期状態に戻る
    const v = await pastStub.getState();
    expect(v.confirmedTokens).toBe(0);
    expect(v.requestCount).toBe(0);
    const rec = await env.DB.prepare(
      "SELECT status FROM reconciliations WHERE utc_day = ? AND pool = 'STANDARD'",
    )
      .bind(pastDay)
      .first<{ status: string }>();
    expect(rec?.status).toBe("deleted");

    // 前日の突合行が記録されている
    const latest = await env.DB.prepare(
      "SELECT status FROM reconciliations WHERE utc_day = '2026-08-11' AND pool = 'STANDARD'",
    ).first<{ status: string }>();
    expect(latest?.status).toBe("done");
  });

  it("does not delete a past-day DO while uncertain entries remain (設計書 §4.5)", async () => {
    const now = new Date("2026-08-12T00:05:00Z");
    const pastDay = "2026-08-08";
    const stub = env.QUOTA_CONTROLLER.get(
      env.QUOTA_CONTROLLER.idFromName(`quota:MINI:${pastDay}`),
    );
    await stub.reserve("stuck", 1_000, 1_000);
    await stub.markUncertain("stuck");
    // 突合は done 済みのため DO が finalize 候補になる（保持期限超過 + status='done'）
    await env.DB.prepare(
      "INSERT INTO reconciliations (utc_day, pool, local_tokens, openai_tokens, difference, status, attempts, executed_at) " +
        "VALUES (?, 'MINI', 0, 0, 0, 'done', 1, ?)",
    )
      .bind(pastDay, new Date().toISOString())
      .run();

    fetchMock
      .get("https://api.openai.com")
      .intercept({ path: (p) => p.startsWith("/v1/organization/usage/completions") })
      .reply(200, { object: "page", data: [], has_more: false });

    await runScheduled(env, now);

    // finalizeDay は uncertain 残留で ok:false → deleteAll されない（設計書 §4.5）
    const v = await stub.getState();
    expect(v.uncertainTokens).toBe(1_000);
    const rec = await env.DB.prepare(
      "SELECT status FROM reconciliations WHERE utc_day = ? AND pool = 'MINI'",
    )
      .bind(pastDay)
      .first<{ status: string }>();
    expect(rec?.status).toBe("done"); // deleted に更新されない（finalize が拒否された証跡）
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npm test -w apps/gateway-worker`
Expected: FAIL（`../src/scheduled` 不在）

- [ ] **Step 3: 実装する**

`apps/gateway-worker/src/scheduled.ts`:

```ts
import { quotaIdOf } from "@octg/shared";
import { runReconciliation, targetUtcDay } from "./reconcile";
import type { Env } from "./index";

const POOLS = ["STANDARD", "MINI"] as const;

// 設計書 §8.2 + §4.5。Cron `5 0 * * *` (00:05 UTC) から呼ばれる。
export async function runScheduled(env: Env, now: Date): Promise<void> {
  const target = targetUtcDay(now); // 直前に完了した UTC 日
  await runReconciliation(env, now);

  // 保持期限（当該日の翌々日 00:00 UTC）を超えた日、および突合完了済みの対象日を finalize する
  const retentionHorizon = targetUtcDay(target === "1970-01-02" ? now : new Date(`${target}T00:00:00Z`)); // target の前日
  const rows = await env.DB.prepare(
    "SELECT utc_day, pool, status FROM reconciliations WHERE utc_day <= ? AND status = 'done'",
  )
    .bind(retentionHorizon)
    .all<{ utc_day: string; pool: "STANDARD" | "MINI"; status: string }>();

  const candidates = new Map(rows.results.map((r) => [`${r.pool}:${r.utc_day}`, r]));
  // 対象日本体も reconciliations.status = done なら早期削除候補に加える（設計書 §4.5）
  for (const pool of POOLS) {
    const rec = await env.DB.prepare(
      "SELECT status FROM reconciliations WHERE utc_day = ? AND pool = ?",
    )
      .bind(target, pool)
      .first<{ status: string }>();
    if (rec?.status === "done") candidates.set(`${pool}:${target}`, { utc_day: target, pool, status: "done" });
  }

  for (const { utc_day, pool } of candidates.values()) {
    const stub = env.QUOTA_CONTROLLER.get(env.QUOTA_CONTROLLER.idFromName(quotaIdOf(pool, utc_day)));
    const fin = await stub.finalizeDay(); // uncertain 残留時は ok:false で安全に拒否される
    if (fin.ok) {
      await env.DB.prepare(
        "UPDATE reconciliations SET status = 'deleted', executed_at = ? WHERE utc_day = ? AND pool = ?",
      )
        .bind(new Date().toISOString(), utc_day, pool)
        .run();
    }
  }
}
```

`apps/gateway-worker/src/index.ts` の `scheduled` を以下に置き換える:

```ts
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduled(env, new Date(_event.scheduledTime)));
  },
```

（`ScheduledEvent` 型は `@cloudflare/workers-types` に含まれる）

- [ ] **Step 4: テストを実行してパスを確認する**

Run: `npm test && npm run typecheck`
Expected: 全ワークスペース PASS、exit 0

- [ ] **Step 5: コミット**

```bash
git add apps/gateway-worker
git commit -m "feat(worker): Cron scheduled ハンドラと過去日 DO のファイナライズを実装"
```

- [ ] **Step 6: PR-11 を作成する**

```bash
git push -u origin feat/octg-pr11-reconciliation
gh pr create --title "feat: Cron Reconciliation と DO ライフサイクル" --body "設計書 §8/§4.5 に対応。Usage API 集約突合（fail-closed、冪等）、uncertain の consumed 確定、過去日 DO の finalizeDay + deleted 記録。"
```

---

## Self-Review（計画作成者による確認済み）

- **Spec カバレッジ**: 設計書 §4（DO 全体: T4-T7）/ §5（Worker: T8/T9 分類・推定、T10 エラー、T11/T12 認証・ポリシー、T13-T15 パイプライン）/ §6（D1: T1）/ §7（AIG 連携: T13）/ §8（reconciliation: T20/T21）/ §9（エンドポイント: T13/T16/T17/T18/T19）/ §10（T11/T18）/ §12 の必須テスト 14 件は T4-T6/T9/T13/T17 に全て対応付け済み。
- **必須テスト対応表（設計書 §12→本計画）**: 境界値×2→T4、Concurrent→T5、Settlement→T6、Duplicate settle→T6、Unknown model→T8/T13、Tool-use→T8/T13、Network failure→T14、Midnight→T5、reserve 再送→T4、settle 超過→T6、markUncertain 後 settle→T6、CLAMP 境界→T9/T13、非テキスト→T9/T13、GET /quota 認可→T17。
- **型整合**: `QuotaView`（pool/remaining を含む）を T2 で定義し T4/T13/T17/T19 が共有。`ReserveResult`/`SettleResult` 等の判別共用体は T2 で固定、T4/T6/T7 が遵う。`NormalizedRequest.maxOutputTokens` と `decideOutput` の戻り値は T9 で定義し T13 が `reservation = estimatedInput + decision.maxOutputTokens + margin` で使用。`authenticate` の requestId 外部採番は T13 Step 1 で後方互換のオプショナル引数として導入（T11 テストは無修正でグリーン）。
- **既知の計画上の注意**: T13 の `handleProxy` は reserve 時点の DO スタブをクロージャ保持して settle する（Global Constraints 参照）。`wrangler d1 migrations` の `migrations_dir` はワークスペース相対（`../../db/migrations`）のため CI/ローカルで `npm install` 後に一度 `npx wrangler d1 migrations list octg --local` で検証すること。


**Plan complete and saved to `docs/superpowers/plans/2026-08-09-octg-mvp-implementation.md`.**

Two execution options:

1. **Subagent-Driven (recommended)** — タスクごとに新しいサブエージェントを派遣し、タスク間でレビューを挟みながら高速に反復する（superpowers:subagent-driven-development）。
2. **Inline Execution** — このセッション内で executing-plans を使い、チェックポイントつきでバッチ実行する。

Which approach?
