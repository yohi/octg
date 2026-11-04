# OCTG Cloud-native Zero-Cost CPU Headroom R0.1.1 — Implementation Continuation Plan R1.1 (Documentary Correction Candidate)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish an enforceable, evidence-backed zero-additional-cost preflight and resume existing Issue #121 Stage 1 safely, without reimplementing merged code or weakening quota, API, CPU, or release safeguards.

**Architecture:** Reuse existing Cloudflare Worker → Deno Relay → Durable Objects paths and Issue #121 Tasks 1–5. Add a pure local Cost/Capacity Preflight evaluator and fail-closed runner entry guard as the smallest missing executable boundary. Then, **only with new Human Owner authorization**, execute existing Task 6; activate existing conditional Tasks 7–8 only on lifecycle CPU FAIL, and reuse Tasks 9–12 without rewriting their plan.

**Tech Stack:** Node.js 22+, ECMAScript modules (`.mjs`), `node:test`, TypeScript 5.6, Cloudflare Workers Free / SQLite-backed Durable Objects, Deno Deploy Free, Wrangler 4.x and the existing OCTG scripts.

**Spec:** Adopted **R0.1.1** remains unchanged; R0.1.2 is a **document-only correction candidate**, not adopted. Original path: `docs/superpowers/specs/2026-11-03-octg-cloud-native-zero-cost-cpu-headroom-design.md` on `feature/octg-cloud-native-zero-cost-cpu-headroom-design-r01`, commit `bcf23252c1b616059bb9f18a83a32582e40bb2c2`, Git blob `2bd9ec5d75a5e1f84fb9d45bb26de85e57b8afdb`.

**Normative implementation plan retained:** `docs/superpowers/plans/2026-10-05-worker-free-cpu-headroom-redesign.md` (`master` at `40857b37db1e0a53f20b794daae6e6b45195beef`). This continuation plan supplements its Cost Gate and as-built boundaries; it **does not replace or silently amend** that plan.

**Plan status:** `R1.1 TARGETED_DOCUMENTARY_CORRECTION_CANDIDATE / NOT_OWNER_APPROVED_FOR_IMPLEMENTATION` (Review Gate R1 F-001/F-002/F-003 only; original Git plan unchanged). This document authorizes no source change, test execution, remote telemetry query, Cloudflare/Deno deployment, quota change, CI change, branch push or HOLD release. Recording the plan in GitHub also requires separate authorization.

## Global Constraints

- Project success: Workers Free HTTP CPU ≤10 ms, **every required stateless measurement series** p99 ≤5 ms, max ≤7 ms, `exceededCpu = 0`, ≥500 successful invocations, complete platform telemetry.
- **Zero additional recurring cost**: Workers Free + Deno Deploy Free; no automatic upgrade or supplemental paid platform. Account-specific effective free limits and balances are verified at execution time, not inferred from the design snapshot.
- `QuotaController` is the sole Quota Authority. D1 is not used to authorize admission, settlement or grant lifecycle decisions.
- Maintain `/v1/responses` and `/v1/chat/completions` public compatibility, streaming, idempotency, uncertainty handling, fail-closed logic and Production/Preview separation.
- Retain existing Production HOLD, Option B normative authority and Owner Decisions. `HOLD_CODE_PRESENT` is **not** evidence that remote `HOLD_ACTIVE` is proved.
- Secret material, raw requests/responses, prompts, client keys, HMAC keys, grant credentials and raw telemetry must not be committed or included in cost evidence.
- **Do not rerun the old Plan's Tasks 1–5 as implementation work** merely because their checkboxes remain unchecked. Source is merged, but current runtime acceptance is not proved.
- Existing Stage 1 orchestration expects a full 68-series run, with candidate/secret cleanup; safe pause/resume across quota-reset boundaries and preservation of a single candidate ScriptVersion are **not established**. This plan does not claim day splitting is already safe.
- On missing/late/unverifiable capacity evidence **or independently verified execution target**, return `PREFLIGHT_HOLD` **before any upload, deploy, fixture setup or measured request**. Recovery/cleanup of already-live grants must remain available independently of Cost Gate status.
- Required Cost meters include SQLite-backed DO `rows_read` / `rows_written` / `storage` and D1 `rows_read` / `rows_written` / `storage`, even when D1 is audit-only. `CapacityEvidenceV1` cannot attest to its own execution target or plan eligibility.
- Completion of local implementation work or documentation does not authorize remote execution. Every later mutation needs explicit scope-bound Human Owner permission.

## Review Focus — high-risk failures and owning tests

1. **Missing DO/D1 row meters or unknown usage interpreted as zero**: missing DO/D1 Rows Read, Rows Written, Storage or stale usage must HOLD; exact-boundary Rows Read/Write tests (`relay-cpu-capacity.test.mjs`).
2. **Under-counted gate work**: 34,000 successful measured callbacks must not be treated as the whole Worker/DO/Deno cost budget; all 68 series, 170,000 fivefold attempt envelope, fixture/control operations and safety reserve are represented or HOLD (`relay-cpu-capacity.test.mjs`).
3. **Gate bypass**: `stage1`, `stage2-preflight` and `stage2-series` cannot begin external actions without a passing, in-scope Cost Gate; `recover-operation` is permitted to safely close previously active operations (`relay-cpu-cli` regression tests).
4. **Cross-target and evidence-origin mismatch**: Cloudflare account, Deno Organization, Environment, Worker, Stage, SHA, Free eligibility or Usage Period divergence (or missing independent verification) must HOLD (`relay-cpu-capacity.test.mjs`, CLI tests).
5. **CPU telemetry failure vs absence of proof**: `exceededCpu` is FAIL even without an app marker, while missing telemetry is `BLOCKED/INCOMPLETE`, not PASS (reuse `relay-cpu-evidence.test.mjs` and old Task 6).

---

## File / responsibility map

| File | Proposed disposition | Responsibility |
| --- | --- | --- |
| `docs/superpowers/specs/2026-11-03-octg-cloud-native-zero-cost-cpu-headroom-design.md` | **Read-only source of truth** | Adopted Cost Gate, thresholds, authority and pending-work crosswalk. |
| `docs/superpowers/plans/2026-10-05-worker-free-cpu-headroom-redesign.md` | **Read-only** | Existing 12-task normative implementation/rollout plan. |
| `scripts/relay-cpu-workloads.mjs` | Read-only | `requiredSeriesMatrix()` source of truth; do not duplicate class lists. |
| `scripts/relay-cpu-capacity.mjs` | **Create if implementation separately authorized** | Pure capacity evaluation with **separate evidence and verified target** inputs, DO/D1 row-meter enforcement, matrix-derived lower/upper requirements. No network I/O. |
| `scripts/relay-cpu-capacity.test.mjs` | **Create if authorized** | Boundary tests including missing data, meter periods, fixtures, reserve and matching SHA. |
| `scripts/relay-cpu-capacity-cli.mjs` | **Create if authorized** | Read separate protected capacity evidence and independently operator-verified target record; perform structural checks and emit sanitized `PREFLIGHT_PASS`/`PREFLIGHT_HOLD`. No provider access. |
| `scripts/relay-cpu-capacity-cli.test.mjs` | **Create if authorized** | Valid/invalid JSON, predictable exit codes, no secret leakage. |
| `scripts/relay-cpu-cli.mjs` | **Modify if authorized** | Bind `--capacity-evidence=<path>` to independently verified execution target, fail closed before any Stage 1/2 remote action; preserve `--execute` and `recover-operation` paths. |
| `scripts/relay-cpu-stage1.mjs` | Keep existing unless proven necessary | Already provisions Preview candidate, runs gate, safely cleans up. Do not refactor gratuitously. |
| `scripts/relay-cpu-cli`-related tests (`scripts/run-relay-cpu-gate.test.mjs`, `scripts/relay-cpu-stage1.test.mjs`) | Extend if authorized | Verify early rejection before deployment and preservation of recovery behavior. |
| `docs/operations.md` | **Modify only after authorized implementation** | Document capacity inputs, evidence handling, stop conditions, and reference to old Task 6; do not duplicate rollout protocol. |

Only the proposed capacity evaluator, its read-only CLI and CLI entry guard are **new local implementation work**. Other source files already merged by PR #124 are not reimplemented. Conditional DO and Stage 2 code belong to the old Plan's Tasks 7–12, with their separate gates.

## Execution states and dependencies

```text
Owner-approved R0.1.1 (DOCUMENT_ONLY)
    │
    ├─ Task 1: fixed-source as-built verification (READ_ONLY)
    │
    ├─ Task 2: capacity evaluator + offline evidence CLI (LOCAL CODE — not authorized yet)
    │
    ├─ Task 3: fail-closed CPU Runner entry guard (LOCAL CODE — not authorized yet)
    │
    └─ Owner Checkpoint for local implementation/evidence
              │
              ├─ No verified capacity or split-run safety -> HOLD / no remote action
              │
              └─ PREFLIGHT_PASS + explicit remote approval
                          │
                          └─ Original Issue #121 Task 6 / Stage 1
                                  │
                                  ├─ CPU Gate PASS -> Owner chooses next authorized stage
                                  ├─ Lifecycle class FAIL -> conditional old Tasks 7–8,
                                  │                       then full Stage 1 rerun
                                  ├─ Ingress/Decision FAIL -> STOP (no lifecycle DO)
                                  └─ Missing evidence / capacity -> BLOCKED / HOLD
```

**Important:** Task 2/3 are future *implementation* work and not implied by the present `writing-plans` invocation. Running Stage 1 and remote telemetry is a separate Owner decision after local readiness. The implementation team must not treat this diagram as blanket approval.

### Task 1: Lock the existing code / plan identity (READ_ONLY; no source modifications)

**Files:**
- Inspect: `packages/shared/src/relay-credential.ts`, `apps/gateway-worker/src/relay-callback.ts`, `apps/gateway-worker/wrangler.jsonc`.
- Inspect: `scripts/relay-cpu-workloads.mjs`, `scripts/run-relay-cpu-gate.mjs`, `scripts/relay-cpu-stage1.mjs`, `scripts/relay-cpu-evidence.mjs`.
- Inspect: adopted R0.1.1 spec and the existing Issue #121 implementation plan.

**Interfaces:**
- Consumes: fixed `master` SHA `40857b37db1e0a53f20b794daae6e6b45195beef` and adopted spec commit `bcf23252c1b616059bb9f18a83a32582e40bb2c2`.
- Produces: a source identity and source-to-task inventory. No new API or RPC.

- [ ] **Step 1: Verify both immutable refs.** Use `git rev-parse` / `git show` against the exact hashes, without switching Production or starting Actions. Abort if ref identity differs.
- [ ] **Step 2: Confirm existing implementation:** `relayMacKey` cache, CPU Gate RPC/runner/evidence code, 68-row `requiredSeriesMatrix()`; confirm Lifecycle DO class and v4 migration are absent at this baseline. Document observed facts without treating absence of remote results as CPU FAIL.
- [ ] **Step 3: Compare with old plan:** Tasks 1–5 `IMPLEMENTED_IN_CODE`, earlier tests `LOCALLY_VERIFIED` **historically only**; Task 6 `RUNTIME_NOT_VERIFIED`, Tasks 7–8 conditional unimplemented, Tasks 9–11 incomplete, Task 12 HELD. If current checkout differs, stop and reassess source identity rather than rewriting all historical tasks.
- [ ] **Step 4: Check local commands** on the exact selected source tree only when authorized for local execution:
  `npm run typecheck` and `npm test`. Expected 0 exits to claim this checkout's local test PASS. Do not infer remote Stage 1 PASS from these results.

**Task completion / stop:** Produce one accurate as-built source inventory and then stop; no new standalone review, PR or reimplementation sequence.

### Task 2: Make the Cost / Capacity Preflight calculation executable (future LOCAL implementation; separate Owner authorization)

**Files:**
- Create: `scripts/relay-cpu-capacity.mjs`, `scripts/relay-cpu-capacity.test.mjs`.
- Create: `scripts/relay-cpu-capacity-cli.mjs`, `scripts/relay-cpu-capacity-cli.test.mjs`.
- Reuse unchanged: `scripts/relay-cpu-workloads.mjs`.
- Do not modify `SPEC.md`, DO/QuotaController code, existing Issue #121 plan or existing source for Tasks 1–5.

**Interfaces (one normative function contract shared by Design §8 and Tasks 2–4):**

```ts
// ESM exports with JSDoc/TS-checkable JS types
export function requiredCapacityMatrix(): {
  seriesCount: number; successesPerSeries: number;
  minimumSuccessfulCalls: number; attemptEnvelope: number;
};
export function evaluateCapacityPreflight(
  evidence: CapacityEvidenceV1,
  target: ExecutionTargetV1,
  nowUTC: string,
): { status: 'PREFLIGHT_PASS' | 'PREFLIGHT_HOLD'; reasons: string[] };
```

`CapacityEvidenceV1` is a protected **data claim**, never an execution authority. JSON top-level required:

```ts
interface CapacityEvidenceV1 {
  version: 1;
  stage: 'stage1' | 'stage2';
  environment: 'preview' | 'production';
  cloudflareAccountId: string;
  denoOrganizationId: string;
  sourceRevision: string; // exact lowercase 40-hex SHA
  workerName: string;
  observedAtUTC: string; expiresAtUTC: string; // ISO-8601 UTC
  budgetMethodRef: string;
  freePlanEligibility: { cloudflare: 'free'; deno: 'free'; providerEvidenceRefs: string[] };
  matrix: { seriesCount: 68; successesPerSeries: 500; attemptEnvelope: 170000; fullRun: true };
  meters: CapacityMeterV1[];
}
interface ExecutionTargetV1 {
  version: 1;
  stage: 'stage1' | 'stage2';
  environment: 'preview' | 'production';
  cloudflareAccountId: string;
  denoOrganizationId: string;
  workerName: string;
  sourceRevision: string;
  usagePeriods: Record<string, { kind: 'utc_day' | 'billing_month' | 'nonresetting_stock'; startUTC?: string; endUTC?: string; asOfUTC?: string }>;
  freePlanEligibility: { cloudflare: 'free'; deno: 'free' };
  verifiedAtUTC: string;
  operatorVerificationRef: string;
  providerIdentityEvidenceRefs: string[];
}
interface CapacityMeterV1 {
  id: string; scope: string; unit: string;
  resetWindow: { kind: 'utc_day' | 'billing_month' | 'nonresetting_stock'; startUTC?: string; endUTC?: string; asOfUTC?: string };
  verifiedFreeLimit: number; consumedUsage: number; normalForecast: number; reserve: number; gateBudget: number;
  usageObservedAtUTC: string; limitVerifiedAtUTC: string;
  limitSourceUrl: string; usageEvidenceRef: string; normalForecastEvidenceRef: string;
  budgetEvidenceRef: string; reserveEvidenceRef: string;
  zeroIncrementJustificationRef?: string;
}
```

Required IDs, canonical units, Free reference limits, Scope/reset semantics and official sources are exactly **Design §8.1** (14 explicit IDs including DO Rows Read/Written, D1 Rows Read/Written, and separate DO/D1 storage). Every Cloudflare meter has `scope = "cloudflare:" + target.cloudflareAccountId`; every Deno meter has `scope = "deno:" + target.denoOrganizationId`, never a Worker- or database-only scope. `requiredMeters` must be the full set plus any provider/account active limit metering determined by the independent Operator check. No implicit exclusions. Inapplicability requires explicit verified evidence and Owner decision, not deletion of rows by implementation convenience. For the account's *verified* effective Free limit, use that limit only when backed by provider evidence; never silently take a higher published or operator-provided number. Active plan mismatch ⇒ HOLD.

**Trust boundary:** The `evidence` and `target` arguments must come from **different derivation paths**. The Operator must independently verify `target` against actual Cloudflare/Deno account/provider configuration, protected usage period, fixed Git source identity, Worker binding, Environment and Stage. A trusted orchestration layer supplies this verified target as a distinct input. `target` **MUST NOT** be copied from `evidence`, nor can an arbitrary user-authored file be treated as trusted solely by matching keys or a self-declared verification flag. The CLI may validate protected operator-verification references, freshness, and structural consistency, but cannot cryptographically prove provider authenticity from two matching JSON files; if independent verification is absent ⇒ `PREFLIGHT_HOLD`. No remote provider reads are performed by this documentary Task; read-only provider proof collection is a separately authorized operator activity.

**Decision order:** Verify exact required ID set, canonical units, finite and non-negative numbers, valid evidence refs, `matrix === requiredCapacityMatrix()`, target verification, exact `cloudflareAccountId`/`denoOrganizationId`/`environment`/`workerName`/`sourceRevision`/`stage`/`freePlanEligibility` matching, per-meter `scope` and identical verified `usagePeriods`, period reset alignment, no crossed monthly/day windows, ISO-UTC timestamps (usage/target/evidence no older than 15 minutes and not in the future, `expiresAtUTC > nowUTC`), then each meter's `L - U - N - R >= B`. `nonresetting_stock` uses `asOfUTC`, not a fabricated daily reset; `gateBudget` includes all storage growth and control operations. Explicit zero requires an authoritative zero usage or `zeroIncrementJustificationRef`; unknown is HOLD. This `PASS` asserts capacity/identity evidence only, not CPU acceptance, permission to run, provider cryptographic attestation or HOLD release.

- [ ] **Step 1: Write focused RED tests:** `matrix_has_68_series_34000_minimum_and_170000_attempt_envelope`, `missing_do_rows_read_or_write_holds`, `missing_d1_rows_read_or_write_holds`, `missing_do_or_d1_storage_holds`, `row_read_at_limit_with_positive_budget_holds`, `row_write_at_limit_with_positive_budget_holds`, `row_read_exact_balance_passes`, `row_write_exact_balance_passes`, `missing_usage_or_fixture_cost_holds`, `cross_cloudflare_account_holds`, `cross_deno_organization_holds`, `cross_environment_holds`, `wrong_revision_holds`, `expired_evidence_holds`, `wrong_stage_or_worker_holds`, `usage_period_mismatch_holds`, `free_plan_not_proven_holds`, `operator_verification_missing_holds`, `two_self_consistent_jsons_without_external_proof_hold`, `target_file_same_as_capacity_file_holds`, `normal_complete_meters_pass`. Use a fixture with every required meter and independent evidence refs; zero budgets require explicit justifications.
- [ ] **Step 2: Run RED:** `node --test scripts/relay-cpu-capacity.test.mjs scripts/relay-cpu-capacity-cli.test.mjs`; expected missing-module/missing-contract failures.
- [ ] **Step 3: Implement `requiredCapacityMatrix()` and `evaluateCapacityPreflight(evidence,target,nowUTC)`** in `scripts/relay-cpu-capacity.mjs` with the exact signature and structural/trust-boundary contract above; no provider API access, no new Quota RPC. Return only safe reason codes such as `MISSING_METER`, `CROSS_ACCOUNT`, `TARGET_NOT_VERIFIED`, `EXPIRED_EVIDENCE`, `FREE_PLAN_NOT_PROVEN`, `INSUFFICIENT_CAPACITY`, without credential/usage values in stdout.
- [ ] **Step 4: Implement offline evidence CLI** `node scripts/relay-cpu-capacity-cli.mjs --evidence=<protected-path> --target=<independently-operator-verified-protected-path> --now=<ISO-UTC>`. Exit `0` on `PREFLIGHT_PASS`, `2` on `PREFLIGHT_HOLD`, `1` on malformed CLI / I/O. Its target input must be operator-verified from **independent provider/Git evidence**, not autogenerated from CapacityEvidence. CLI performs **structural validation and correlation only**; do not advertise it as cryptographic provider authentication. No network queries.
- [ ] **Step 5: Run GREEN:** `node --test scripts/relay-cpu-capacity.test.mjs scripts/relay-cpu-capacity-cli.test.mjs`, then `npm run test:scripts`. Expected all exit 0.
- [ ] **Step 6: Stop at Owner-approved local implementation/commit boundary only if separately authorized.** Do not write to GitHub, push, deploy, run Gate or alter adopted R0.1.1 automatically.

**Task stop:** If any required meter, including DO/D1 Rows Read/Write, lacks authoritative account usage; if the verified actual execution target is unavailable; or if full nonpausing run capacity/safe cleanup cannot be shown, return `PREFLIGHT_HOLD / NOT_VERIFIED`, not fake zeros, truncated 68-series tests or unsafe day splitting.

#### F-002 — Operator Trust Record and resolver contract (normative addition)

##### 変更ファイルの固定

既存Task 2のファイルに加え、将来の**別承認されたローカル実装**として以下を明示する。

- **新規:** `scripts/relay-cpu-operator-trust.mjs` — `OperatorTrustRecordV1`、`createOperatorVerifiedTargetResolver`の本体、保護ファイル・Operator証拠検証、Fail-Closed。必要な外部API呼出しを開始する責務は持たず、**事前に別承認で取得した**Provider/Gitの証拠を消費する。
- **新規:** `scripts/relay-cpu-operator-trust.test.mjs` — Hash・Provider証拠・Owner/Operator・保護権限・同一内容の未承認JSONに対する拒否試験。
- **新規:** `scripts/relay-cpu-operator-approve.mjs` — Operatorの明示操作に限って、独立収集済み証拠を確認・固定するローカル準備CLI。自動承認は禁止。非対話モードは`HOLD`。
- **既存予定:** `scripts/relay-cpu-capacity.mjs` — `evaluateCapacityPreflight(evidence,target,nowUTC)`は**信頼解決が先に成立したTargetのみ**受ける。構造照合と容量計算は純粋関数のままとする。
- **既存予定:** `scripts/relay-cpu-capacity-cli.mjs` — `--evidence`と`--target`の単なるJSON一致では`PASS`とせず、Operator Trust Recordの受理が必要。独立のOperator承認入力がないと`HOLD`。

##### 追加の具体的な型と責務

設計書R0.1.2限定訂正§8.6の`OperatorTrustRecordV1`が唯一の正規型である。Planに別版のSchemaを作らない。関数契約は次で確定する。

```ts
// scripts/relay-cpu-operator-trust.mjs (future; no code is implemented in this Task)
export function createOperatorVerifiedTargetResolver(deps: {
  readAndVerifyProtectedFile: (path: string) => Promise<ProtectedFileSnapshotV1 | undefined>;
  trustedOperatorSession: {
    operatorUid: number;
    approvedTrustRecordSha256: string; // approved out-of-band, NOT CLI or CapacityEvidence
    trustRootPath: string;             // Operator-owned, not taken from untrusted JSON
    interactiveApprovalVerified: boolean;
  };
  gitHead: () => Promise<string>;
  actualWorkerConfig: () => Promise<{ workerName: string; environment: 'preview'|'production'; cloudflareAccountId: string }>;
  nowUTC: () => string;
}): (args: {
  mode: 'stage1' | 'stage2-preflight' | 'stage2-series';
  sourceRevision: string; workerName: string; scriptVersionId?: string;
  environment: 'preview' | 'production'; targetPath: string; capacityEvidencePath: string;
}) => Promise<VerifiedCapacityInputV1 | undefined>;

interface ProtectedFileSnapshotV1 {
  bytes: Uint8Array;
  fileIdentity: { device: string; inode: string };
  beforeRead: { isFile: boolean; isSymlink: boolean; uid: number; mode: number; device: string; inode: string; size: number; mtimeNs: string; ctimeNs: string };
  afterRead: { isFile: boolean; isSymlink: boolean; uid: number; mode: number; device: string; inode: string; size: number; mtimeNs: string; ctimeNs: string };
}
```


```ts
// A resolver success carries the parsed Evidence derived from the EXACT approved bytes.
interface VerifiedCapacityInputV1 {
  target: ExecutionTargetV1;
  capacityEvidence: CapacityEvidenceV1;
  capacityEvidenceSha256: string; // SHA-256 of the same verified UTF-8 bytes
  trustRecordId: string;           // OperatorTrustRecordV1.recordId
}
```

`ExecutionTargetV1`・`CapacityEvidenceV1`は既存Task 2のSchemaのまま。`OperatorTrustRecordV1`が固定する`targetSha256`/`capacityEvidenceSha256`と8種類のproofEntriesについて、Record承認時・Runner使用時に**実ファイルのバイト列**とSHA-256を照合する。とりわけ`capacityEvidencePath`から保護Readerが一度だけ取得したUTF-8生バイトをSHA-256化して承認済み`capacityEvidenceSha256`と完全一致させ、**その同じバイト列だけ**をJSON parseして`VerifiedCapacityInputV1.capacityEvidence`へ入れる。`target`と`capacityEvidence`は一つの承認`recordId`に結び付ける。UUID/参照ID・JSON相互一致だけでは受理しない。

`readAndVerifyProtectedFile`の契約は、依存側がpathnameを一度だけ`O_NOFOLLOW`相当で開き、**同一FD**の読み取り前後に`fstat`し、そのFDから得た実バイト・前後stat・`device/inode`識別情報を単一の`ProtectedFileSnapshotV1`として返すことである。読取前後で識別情報または保護属性が変化した場合、通常ファイルでない場合、Symlinkの場合は`undefined`を返す。Resolverは返却された`bytes`のみをHash/parseに使用し、pathnameを別のstat/read操作で再検証しない。各proof/targetにも同じ保護読取契約を適用する。

**信頼できる入力と禁止入力**：`trustedOperatorSession`はOperator本人が管理するローカル実行コンテキストから供給する。`resolveTrustedOperatorRuntimeDependencies`は`node:os.homedir()`から固定root `~/.local/state/octg/cpu-gate/approved/`を導出し、`process.stdin.isTTY && process.stdout.isTTY`が真の場合だけ`node:readline/promises`でOperatorに正規Trust RecordのSHA-256（64桁）を対話入力させる。CLIフラグ、環境変数、Target/Evidence JSONから承認ダイジェストを得るFallbackはない。非対話・入力中断・未承認rootは`undefined`/HOLD。`approvedTrustRecordSha256`、`trustRootPath`、`interactiveApprovalVerified`を、任意の`--execution-target`、`--capacity-evidence`、そのJSON、一般ユーザーが編集可能なCLI引数から作ってはならない。Provider認証対象、Git HEAD、Worker名・Stage・Accountは別系統で検証する。Operatorによる人手確認が証拠の真正性の最終根拠であり、暗号学的Provider署名の存在を仮定しない。承認セッションを保護できなければHOLD。

##### Operator準備フロー（将来のローカル実装・独立承認が必要）

1. **事前Evidence Check:** 実アカウントのCloudflare/Deno Provider設定・Free資格・Meter実績、固定Git commit、Worker構成を別承認の読み取り工程で照合する。UsageとTargetは異なる資料から導出する。少なくとも`git_commit`、`worker_config`、`cloudflare_account`、`cloudflare_free_plan`、`cloudflare_usage`、`deno_organization`、`deno_free_plan`、`deno_usage`の8種類を揃える。
2. **Operator事実確認:** Operatorが8種類の元資料（実ファイル、取得方法、SHA-256、取得日時、実ID）を確認し、Free有効期限・アカウント一致を照合する。Snapshotの存在だけでは確認成立しない。確認できないProvider証拠を「Operator確認済み」にしない。
3. **保護作成:** `relay-cpu-operator-approve.mjs`が保護領域（Operator-owned dir `0700`; regular files `0600`）内に`ExecutionTargetV1`、Capacity Evidence、Provider/Git proof、Operator Trust Recordを排他的に作る。Symlink・所有者/権限不一致・既存ファイル上書きは拒否する。秘密値は永続記録に載せない。
4. **独立承認固定:** OperatorがTrust RecordのSHA-256を明示確認し、値をCaller非制御のOperator sessionに固定する。任意の2つのJSONと自己申告参照だけでは承認状態を作れない。
5. **実行直前消費:** Resolverが上記8種類の保護実体・内容Hash・Operator承認・実Git HEAD・実Worker/Account/Stage・Deno Organization・Free適格性・Usage期間・15分鮮度・revision一致を再検証する。`capacityEvidencePath`を同一`recordId`ディレクトリ内の保護ファイルとして一回だけOpen/Readし、同じFDの`fstat`前後照合、非Symlink、Operator UID/権限、承認済み`capacityEvidenceSha256`との実バイトSHA-256完全一致を必須とする。別セッションのTarget/Evidence/Proof、差替え・失効・パス外参照はHOLD。検証済みバイトをparseして`VerifiedCapacityInputV1 { target, capacityEvidence, capacityEvidenceSha256, trustRecordId }`を返す。失敗は`undefined`、上位CLIは`PREFLIGHT_HOLD`終了コード`2`。新規Remote操作0件。

**Fail-Closed reason codes（ログはコードのみ）：** `TRUST_RECORD_MISSING`、`UNTRUSTED_RECORD_PATH`、`OPERATOR_NOT_CONFIRMED`、`PROOF_UNVERIFIED`、`HASH_MISMATCH`、`CROSS_ACCOUNT`、`CROSS_ENVIRONMENT`、`WRONG_REVISION`、`EXPIRED_EVIDENCE`、`FREE_PLAN_NOT_PROVEN`、`TARGET_NOT_VERIFIED`。`undefined`以外の成功値は全チェックを満たした正規Targetだけに限る。例外は`PASS`へ変換しない。

##### Task 2に追加するRED→GREENテスト名

- `two_matching_unapproved_jsons_hold`
- `operator_ref_string_without_resolvable_proof_holds`
- `unreadable_protected_provider_snapshot_holds`
- `provider_snapshot_hash_mismatch_holds`
- `operator_session_digest_missing_holds`
- `operator_session_digest_mismatch_holds`
- `trust_root_symlink_or_writable_parent_holds`
- `record_wrong_uid_or_file_mode_holds`
- `untrusted_target_not_derived_from_approved_record_holds`
- `cloudflare_account_and_deno_org_proof_disagree_holds`
- `git_commit_does_not_match_checkout_holds`
- `unverifiable_free_plan_or_expired_usage_holds`
- `verified_trust_record_and_independent_evidence_accepts_target`
- `approved_target_with_unapproved_capacity_evidence_swap_holds`
- `capacity_evidence_digest_mismatch_or_file_tamper_holds`
- `capacity_evidence_replaced_during_read_holds`
- `capacity_evidence_from_other_operator_session_holds`
- `capacity_evidence_or_proof_expired_holds`
- `capacity_evidence_actual_bytes_including_newline_hash_checked`
- `capacity_evidence_verified_snapshot_is_exactly_evaluator_input`

既存F-001の必須Rows Read/Written/Storage・上限境界テストは**維持**。これらの新テストは実装承認後に初めて実行し、文書訂正中には実行しない。

### Task 3: Enforce Cost Gate before any Stage 1/2 remote action (future LOCAL implementation; separate Owner authorization)

**Files:**
- Modify: `scripts/relay-cpu-cli.mjs`, `scripts/run-relay-cpu-gate.mjs`.
- Test: `scripts/run-relay-cpu-gate.test.mjs`, `scripts/relay-cpu-stage1.test.mjs`, `scripts/relay-cpu-capacity.test.mjs`.
- Reuse unchanged: `scripts/relay-cpu-capacity.mjs`, `scripts/relay-cpu-stage1.mjs` (unless an independently demonstrated adapter necessity is later authorized).

**Interfaces:**
- Existing entry function: `executeCpuGateCli(argv, env, io): Promise<number>`; keep `runRelayCpuGate({ mode, adapters, journalPath, ledgerPath, sourceRevision, signal })` unchanged.
- New options on `stage1`, `stage2-preflight`, `stage2-series`: **`--capacity-evidence=<protected-json-path>`** and **`--execution-target=<independent-protected-json-path>`**. The latter is an Operator-reviewed Target record with independent Provider/Git provenance. The CLI invokes `io.resolveVerifiedExecutionTarget({ mode, sourceRevision, workerName, scriptVersionId, environment, targetPath: pairs["--execution-target"], capacityEvidencePath: pairs["--capacity-evidence"] })`. The production resolver (Task 2) checks the protected Target, Operator Trust Record and all independent Provider/Git proofs; it **reads and SHA-256 verifies the actual CapacityEvidence bytes from `capacityEvidencePath` against the approved Record in the same `recordId` session**. It returns `VerifiedCapacityInputV1 | undefined`, never an unbound Target. If that independent proof, same-session binding, digest or freshness cannot be established, return `undefined`/HOLD. A caller-provided Target field, unverified file, or two matching self-declared JSONs are insufficient.
- Preserve existing `--execute`, `--origin`, `--worker-name`, `--pool`, `--model`, `--journal`, `--ledger`, `--source-revision`, `--preview-config`, `--script-version` flags. Require `--execution-target` only for new Stage 1/2 Cost Gate modes; never require it for `recover-operation`. For every measured Stage 1/2 mode, require explicit 40-hex `--source-revision`; for Stage 2 require the selected ScriptVersion identity where existing Task 6/12 prescribes it.
- **Stage mapping**: `stage1` ⇒ `{stage:'stage1',environment:'preview'}`; `stage2-preflight` and `stage2-series` ⇒ `{stage:'stage2',environment:'production'}`. Target's Cloudflare account ID must come from actual authenticated deploy/account configuration; Deno Organization ID must be operator-verified independently from Deno Console; bind worker name/source SHA to actual checkout/target build metadata, not to Cost JSON. Stage 1 candidate ScriptVersion is verified again by the existing Preview preflight after upload; Stage 2 Version Override/DO version verification remains governed by old Task 12.
- `recover-operation` remains accessible when Cost Gate is `PREFLIGHT_HOLD`, **only** under existing `--execute`, service bearer, `runRelayCpuGate` recovery preflight, authoritative slot/operation fences and terminal proof. Do not add a Cost Gate bypass for fresh setup or another mutating path.

- [ ] **Step 1: Write RED CLI regression tests:** `production_entry_initializes_trusted_resolver`, `production_entry_rejects_caller_fake_resolver`, `capacity_evidence_path_reaches_production_resolver`, `stage1_missing_capacity_evidence_no_remote_calls`, `stage1_missing_independent_target_no_remote_calls`, `stage1_two_matching_unverified_jsons_hold`, `stage1_cross_cloudflare_account_holds`, `stage1_wrong_revision_or_preview_env_holds`, `stage1_expired_usage_holds`, `stage2_preflight_cross_environment_holds`, `stage2_series_other_deno_org_holds`, `stage2_wrong_source_sha_holds`, `stage2_no_actual_candidate_version_holds`, `missing_do_rows_written_blocks_stage1`, `missing_d1_rows_read_blocks_stage2`, `execute_flag_still_required`, `valid_capacity_reaches_existing_stage1_adapter`, `recover_operation_with_capacity_hold_preserves_existing_auth`, `cost_hold_does_not_block_terminal_cleanup_of_existing_operation`. Run through `npm run gate:relay-cpu` and production `runCpuGateCli()`; inject fakes only at filesystem/provider/Trusted Session dependencies, not in place of the production resolver. Supply spy `fetchImpl`/`commandImpl`/`runGate` and independent operator target resolution. On every HOLD assert **zero calls** to upload/deploy/createFixture/callback/telemetry before existing cleanup.
- [ ] **Step 2: Run RED:** `node --test scripts/run-relay-cpu-gate.test.mjs scripts/relay-cpu-stage1.test.mjs`; expected new tests fail against unchanged CLI.
- [ ] **Step 3: Extend argument validation in `executeCpuGateCli(argv,env,io)`** for both new flags, then pass `targetPath` **and `capacityEvidencePath`** into `io.resolveVerifiedExecutionTarget(...)` **before** `runStage1Provisioned`, `createRelayCpuHttpAdapters`, any upload, Secret mutation or Stage 2 action. The resolver itself reads the approved Evidence bytes **once**, computes their SHA-256, compares `OperatorTrustRecordV1.capacityEvidenceSha256`, validates protection/session/expiry, parses the exact bytes and returns `VerifiedCapacityInputV1 | undefined`. CLI **must not re-read** `--capacity-evidence` for Evaluator. Only after a complete verified result exists call `evaluateCapacityPreflight(verified.capacityEvidence, verified.target, nowUTC)` synchronously using that same parsed snapshot. Never obtain Target from Evidence. On HOLD emit non-secret reason codes and exit `2` before remote calls; malformed CLI/IO retains `1` only where the existing error contract requires it, but untrusted/tampered Evidence specifically produces `PREFLIGHT_HOLD / 2`. Provider facts are acquired only in separately authorized preflight.
- [ ] **Step 4: Preserve recovery and failure cleanup:** `recover-operation` bypasses only this **new** capacity requirement, not existing authorization / source / slot checks. A previously active Grant's terminalization or Preview Secret teardown remains callable after capacity evidence expires; do not block it because normal measurements are HOLD.
- [ ] **Step 5: Run GREEN:** `node --test scripts/run-relay-cpu-gate.test.mjs scripts/relay-cpu-stage1.test.mjs scripts/relay-cpu-capacity.test.mjs`, `npm test`, `npm run typecheck`; expected exit 0. This is a future implementation task; none were run during documentation correction.
- [ ] **Step 6: Stop at scoped commit boundary only if Owner separately approves it.** No GitHub push, remote CPU measurement, Production changes or automatic next review.

**Task stop:** Independent actual account/environment/Source Revision binding or free eligibility cannot be proven ⇒ `PREFLIGHT_HOLD`. If Runner cannot support bounded single-run consumption and retains no proven reset-safe pause/resume, do not split the run; Owner selects HOLD or a later separately scoped design. Preserve old Issue #121 Task 6/12 authority and 5/7/0 acceptance.

#### F-003 — Production CLI resolver wiring (normative addition)

##### 変更ファイル・責務を一意にする

| ファイル | 将来の変更責務 |
| --- | --- |
| `scripts/relay-cpu-cli.mjs` | Stage 1/2の`--capacity-evidence`/`--execution-target`受理、実行前Cost Gate呼出し、HOLD時remote 0回。`recover-operation`は除外。`--execute`の既存要求を維持 |
| **`scripts/run-relay-cpu-gate.mjs`** | **本番CLI入口の修正必須**：`runCpuGateCli()`がTrusted Operator Sessionから**本番用Resolver Factoryを生成**し、`executeCpuGateCli()`へ`io.resolveVerifiedExecutionTarget`として注入。既存`runGate: runRelayCpuGate`も維持 |
| `scripts/relay-cpu-operator-trust.mjs` | Resolver Factory本体。既存のTask 2で作る実装を再利用し、Fakeを本番に持ち込まない |
| `scripts/relay-cpu-operator-approve.mjs` | 独立Operator確認とRecord作成。Stage 1/2開始時に自動実行・自動承認しない |
| `scripts/run-relay-cpu-gate.test.mjs` | **本番entry `runCpuGateCli()`を経由した統合回帰試験**。Fakeは依存I/Oにのみ注入し、認証済みのTrusted SessionなしにResolverを偽装しない |
| `scripts/relay-cpu-stage1.test.mjs` | Preview upload/secret/createFixtureに到達する前のHOLD、Cleanup経路維持 |
| `scripts/relay-cpu-operator-trust.test.mjs` | 実Factoryによる保護Record/証拠真正性検証、Fail-Closed |

##### 本番注入契約

```ts
// scripts/run-relay-cpu-gate.mjs — planned, not current implementation
import { createOperatorVerifiedTargetResolver } from './relay-cpu-operator-trust.mjs';

export async function runCpuGateCli(argv = process.argv.slice(2), env = process.env, io = {}) {
  const mode = argv[0] ?? 'stage1';
  if (mode === 'recover-operation') {
    // Existing authorization and recovery path — do NOT impose the new Cost Gate.
    return executeCpuGateCli(argv, env, { ...io, runGate: runRelayCpuGate });
  }
  // Construct only from trusted Operator-session controls and verified local/protected I/O,
  // not from CapacityEvidence, untrusted argv or a caller-supplied resolver.
  // resolveTrustedOperatorRuntimeDependencies verifies TTY and Operator-controlled root,
  // then asks the Operator to re-enter the approved Trust Record SHA-256. No JSON/env fallback.
  const resolver = createOperatorVerifiedTargetResolver(
    await resolveTrustedOperatorRuntimeDependencies({ env, io })
  );
  return executeCpuGateCli(argv, env, {
    ...io,
    runGate: runRelayCpuGate,
    resolveVerifiedExecutionTarget: resolver // after ...io, so caller cannot replace it
  });
}
```

`resolveTrustedOperatorRuntimeDependencies`は**本番入口で新規実装する内部関数**であり、未実装の擬似コードである。Trusted SessionはOperator専用の保護されたローカルRuntime入力と実在するGit/config/Provider証拠へバインドする。上記FactoryはテストFakeに入れ替えられないよう、**Production pathで呼ぶFactoryを固定**する。Unit test用に`executeCpuGateCli`を直接呼ぶ場合のみFake Resolverを許す。`io.resolveVerifiedExecutionTarget`の任意差替えを本番の成功要件にしない。

**入口引数と先行チェック:** `stage1`、`stage2-preflight`、`stage2-series`では`--execute`、`--capacity-evidence=<protected-path>`、`--execution-target=<protected-path>`、`--source-revision=<exact 40-hex>`を要求。原Task 6/12で必要な`--origin`、`--worker-name`、`--pool`、`--journal`、`--ledger`、`--preview-config`/`--script-version`等は残す。新しい引数を未実装の現行CLIで動くと主張しない。現在の`runCpuGateCli()`にResolverがない場合、将来の実装完了まで新Cost Gate経由の実行は`PREFLIGHT_HOLD`。Stage 1は`preview`、Stage 2は`production`に独立バインドする。

**進行順序:** 引数検査 → `--execute`検査 → 本番Resolver生成（Trusted Sessionがない場合`undefined`/HOLD）→ `targetPath`と`capacityEvidencePath`をResolverへ渡す → 同一`recordId`のTarget/Evidence/Trust Record/Provider proof保護・有効性照合 → **容量証拠の実バイトSHA-256と承認Digestの完全一致** → `VerifiedCapacityInputV1`（同じバイト列からparseしたEvidence/Target） → `evaluateCapacityPreflight(verified.capacityEvidence,verified.target,nowUTC)` → `PREFLIGHT_PASS`の場合のみ**既存**`runStage1Provisioned`/`createRelayCpuHttpAdapters`/`runRelayCpuGate`へ接続。別ファイル再読込や後段でのEvidence上書きを禁止。HOLD/期限切れ/改変/差替え/例外は`PREFLIGHT_HOLD` / exit `2`、`Upload=Deploy=Secret=Fixture=MeasuredRequest=0`、機微情報はログなし。CPU 5/7/0・Quota/Grant/Streaming/Idempotency/Fail-ClosedとProduction HOLDは不変。

**Cleanup:** `recover-operation`は従来通りの`--execute`、認証Bearer、Slot/Fence/Grant終端証明を必要とし、**新しい**Cost Gateと2つの新引数を要求しない。Cost Gateの失効後も活動中Operationの安全なCloseとSecret後始末は妨げない。回復経路が新規MeasurementやFixtureを開始する抜け道になることは禁止。

##### Task 3に追加するRED→GREENテスト名

- `production_entry_initializes_real_resolver`
- `production_entry_without_trusted_operator_session_holds_before_remote`
- `production_entry_non_tty_or_digest_from_env_only_holds`
- `production_entry_interactive_digest_mismatch_holds`
- `production_entry_does_not_accept_injected_fake_resolver`
- `production_entry_rejects_matching_two_fake_jsons`
- `production_entry_rejects_unapproved_trust_record`
- `production_entry_detects_tampered_protected_snapshot`
- `production_entry_wrong_cloudflare_account_or_deno_org_holds`
- `production_entry_stage1_wrong_sha_or_env_holds`
- `production_entry_stage2_preflight_and_series_bind_actual_target`
- `production_entry_valid_operator_record_reaches_existing_gate_without_bypass`
- `production_entry_recover_operation_retains_existing_authorization`
- `production_entry_recovery_after_cost_expiry_allows_cleanup_only`
- `production_entry_passes_capacity_evidence_path_to_real_resolver`
- `production_entry_rejects_unapproved_evidence_swap_remote_zero`
- `production_entry_rejects_digest_mismatch_remote_zero`
- `production_entry_rejects_file_replacement_after_stat_remote_zero`
- `production_entry_rejects_expired_approval_session_remote_zero`
- `production_entry_same_session_verified_bytes_reach_evaluator`
- `production_entry_recover_operation_works_without_cost_gate_evidence`

**検証入口:** 将来の実装者は`npm run gate:relay-cpu`に結び付く`runCpuGateCli()`を直接テストし、実Factoryを介したHOLDと正常経路双方を確認する。単体テストで`executeCpuGateCli()`へFakeを直接渡すだけではこのTaskをPASSにしない。将来のローカル試験実行・GitHub push・Remote CPU Gateは**別承認**。

##### 相互整合・停止条件

- Design訂正§8.6の`OperatorTrustRecordV1`が唯一のSchema。Plan Task 2の`ExecutionTargetV1`/`CapacityEvidenceV1`と`evaluateCapacityPreflight(evidence,target,nowUTC)`を変更しない。
- `resolveVerifiedExecutionTarget`の正常戻り値は検証済み`VerifiedCapacityInputV1`（Targetと承認済み実バイト由来Evidenceの不可分な組）、失敗は`undefined`、上位は`PREFLIGHT_HOLD`終了コード`2`。別パス・別セッション・改変・失効・証拠欠損・例外をPASSにしない。Plan Task 2の純粋Evaluator `evaluateCapacityPreflight(evidence,target,nowUTC)`、既存F-001の14メーター、本番Resolver配線は変更しない。
- F-001はRESOLVEDとして維持。68系列・各500成功・p99<=5ms/max<=7ms/exceededCpu=0・Platform Telemetry完全・無料枠成立を緩めない。
- 既存Issue #121 Tasks 1–5再実装禁止。Stage 1 CPU Gate RUNTIME_NOT_VERIFIED、Stage 2 NOT_AUTHORIZED、Production HOLDを維持。
- 本限定訂正は文書候補であり、Owner採択と将来の実装承認は別の判断。完了後に自動的な独立再レビュー・GitHub書込み・次Taskを作らない。

### Task 4: Prepare actual Stage 1 evidence and operator checkpoint (READ_ONLY preparation; remote steps require separate Owner approval)

**Files:**
- Reference unchanged: `docs/superpowers/plans/2026-10-05-worker-free-cpu-headroom-redesign.md`, **Task 6 Steps 1–6**.
- Read-only inputs: official plan/usage evidence, existing protected Preview configuration, source revision, worker bindings and account-scoped permission information.
- Evidence outputs: protected local journal/ledger/telemetry or sanitized aggregate, **never Git-tracked raw records**.

**Interfaces:**
- Consumes: a documented `PREFLIGHT_PASS`, source revision identity, separately authorized Preview + platform telemetry scope, existing Task 6 Runner.
- Produces (only after actual authorized execution): per-series `PASS / FAIL / BLOCKED`, exact source SHA / Worker ScriptVersion / harness identity, quota closure status and terminalization proof.

- [ ] **Step 1: Read-only readiness:** identify actual Preview environment and isolated D1/DO/Relay origin, account-level Free plan and metering evidence, normal workload baseline, fresh Secret **presence** (not values), current remote state, and minimum privileges. `NOT_VERIFIED` is a HOLD, not a presumed PASS.
- [ ] **Step 2: Budget the *exact proposed full Runner workload*:** record `34,000` minimum successes, `170,000` measured-attempt envelope, all fixture/callback/DO operations and Deno traffic (including retries and cleanup), account-shared headroom and reserved safety margin. **DO Rows Read/Written + Storage and D1 Rows Read/Written + Storage** must each have distinct authoritative consumption evidence, forecast, reserve, gate budget and reset/stock window. Obtain independent Cloudflare/Deno target identity/Free eligibility proof. Where a necessary meter or independently confirmed target is missing, HOLD.
- [ ] **Step 3: Owner checkpoint:** request permission separately for Preview candidate upload/secret lifecycle and Stage 1 measurements, and for Production historical telemetry queries if attribution requires them. No global blanket execution permission.
- [ ] **Step 4: Only if explicitly approved and capacity PASS, follow original Task 6 exactly:** preserve all original flags, per-run Preview bearer and teardown, and `npm run telemetry:relay-cpu -- ...` with completeness. The **additional** Cost Gate CLI contract (not present in original Issue #121 Task 6) is:

```bash
# Illustrative only — NEVER run under documentary authorization
npm run gate:relay-cpu -- stage1 --execute \
  --origin=<approved-preview-origin> \
  --worker-name=<operator-verified-preview-worker> \
  --pool=<STANDARD-or-MINI> \
  --preview-config=<protected-preview-config-path> \
  --journal=<protected-journal-path> \
  --ledger=<protected-ledger-path> \
  --source-revision=<post-implementation-exact-SHA> \
  --capacity-evidence=<protected-capacity-evidence.json> \
  --execution-target=<separate-operator-verified-target.json>
```

Both new flags are **planned**, not present in the current CLI. The separate Target record must be checked against independently resolved Git/config/account identifiers and external Operator proof before it is accepted; matching the capacity JSON is insufficient. **Fixed historical `master` `40857b37...` is NOT the future Stage 1 candidate revision** after separately authorized Task 2/3 implementation. Set `--source-revision` to the exact post-implementation candidate SHA and independently bind it to the actual Stage 1 ScriptVersion. Stage 2 uses the identical `--capacity-evidence` addition for `stage2-preflight` and `stage2-series`, with a new Production-specific independently verified Target and exact Stage 2 version/revision; each requires separate execution approval. Never present the old baseline SHA as newly CPU-tested.

`recover-operation --execute ...` retains the existing commands, required bearer/slot protections and **does not require** `--capacity-evidence`; it may close already-live work during HOLD but must not start a new fixture or measurement. Never copy raw secrets into the plan or run these commands as part of documentation work.
- [ ] **Step 5: Classify:** pass only with all 68 series, each ≥500 successes and 5/7/0, exact candidate identity and complete telemetry. A missing series is `BLOCKED`; a CPU exceedance is `FAIL`. Ensure all grants are terminal/recovered and Preview gate secrets are removed/verified according to old Task 6.

**Task-specific stop:** `PREFLIGHT_HOLD`, absent remote permission, missing account balance, missing/ambiguous telemetry, incomplete fixture closure, or unsafe need to span reset boundaries => **no further measurement**. Do not treat a successful Preview smoke test as Stage 1 CPU acceptance.

### Task 5: Apply the one bounded Owner branch decision after Stage 1 (no automatic execution)

**Files:**
- Reference unchanged: `docs/superpowers/plans/2026-10-05-worker-free-cpu-headroom-redesign.md`, old **Tasks 7–12** and spec's rollout/HOLD rules.
- No additional file changes unless a specific downstream task is separately authorized.

**Interfaces:**
- Consumes: complete authorized Stage 1 CPU evidence and cost proof, or explicit `BLOCKED/FAIL` evidence.
- Produces: one Human Owner decision for next phase, not a newly spawned review series.

- [ ] **Step 1: If every Stage 1 series PASS:** report that conditional Tasks 7–8 are unnecessary and retain their `CONDITIONAL_NOT_IMPLEMENTED` status. Only after separate authorization may old Tasks 9–11 address the still-missing DO compatibility manifest, bridge/candidate/hardening tooling, local verification and revision lock.
- [ ] **Step 2: If activation/renewal/terminal fails the CPU gate with complete evidence:** report the specific failing series; request one scoped Owner decision on old Tasks 7–8. If approved and implemented, rerun the **whole** Stage 1 using the changed candidate as the old plan requires. No automatic review/redo loop.
- [ ] **Step 3: If ingress or decision CPU fails:** STOP; do not use Lifecycle DO as a purported fix. The Owner chooses a focused alternative or HOLD.
- [ ] **Step 4: If evidence is `BLOCKED`, cost preflight HOLD, or operational recovery incomplete:** preserve the corresponding status, keep Production HOLD, and obtain a focused Owner decision; do not convert unknown to PASS.
- [ ] **Step 5: Stage 2 remains separate:** old Task 12 requires the full compatibility bridge at 100%, CPU-tested candidate at 0%, compatibility preflight, Production-like gate, exact candidate promotion, distinct hardening ScriptVersion and explicit Production mutation/telemetry permission. Do not loosen these contracts or use the CPU pass to lift HOLD automatically.

## Completion criteria and handoff

**This writing-plans task is complete when:** (1) the plan maps the adopted spec to exact files, signatures, tests and stop conditions, (2) the existing merged code is not scheduled for automatic reimplementation, (3) the minimum and fivefold matrix budgets and additional unknown operation costs are explicitly gated, (4) Cost Gate and CPU Gate are independent, and (5) all non-approval and HOLD states remain explicit.

**Execution is *not* complete:** this plan is a candidate; no source change or CPU measurement was performed. Under current evidence, Cost/Capacity Preflight is `NOT_VERIFIED`, Stage 1 runtime is `NOT_VERIFIED`, and Production remains `HOLD`.

**Human Owner choice after reading:** approve this continuation plan, approve it with bounded changes, or return it. Even plan approval does **not** automatically authorize implementing Tasks 2–3, running Task 4, starting old Tasks 7–12, publishing a PR, or lifting the Production HOLD.

**Original plan remains a candidate and this R1.1 correction is NOT adopted:** No implementation authorization or GitHub write is implied.

**Repository destination if separately approved:** `docs/superpowers/plans/2026-11-03-octg-cloud-native-zero-cost-cpu-headroom-r011-execution.md` on `feature/octg-cloud-native-zero-cost-cpu-headroom-design-r01`. No GitHub write was performed by this plan-authoring task.
