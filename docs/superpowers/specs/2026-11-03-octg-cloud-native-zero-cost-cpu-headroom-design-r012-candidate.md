# OCTG — Cloud-native Zero-Cost CPU Headroom Design R0.1.2 — Targeted Documentary Correction Candidate

**基準日：** 2026-11-03（JST）  
**Repository：** `yohi/octg`  
**Baseline HEAD：** `40857b37db1e0a53f20b794daae6e6b45195beef`  
**Design Status：** `R0.1.2 DOCUMENTARY_CORRECTION_CANDIDATE / NOT_OWNER_ADOPTED / IMPLEMENTATION_HOLD`  
**Origin：** `R0.1.1 OWNER_ADOPTED_DOCUMENT_ONLY` (feature branch `bcf23252c1b616059bb9f18a83a32582e40bb2c2`; original unchanged)  
**Scope：** `Superpowers Review Gate R1 F-001 / F-002 / F-003 ONLY`  
**Authority：** `DOCUMENT_ONLY / NO_IMPLEMENTATION / NO_REMOTE_MUTATION`

## 1. 目的

Cloudflare Workers FreeのHTTP CPU制限（10ms）によるOCTGの`/v1/responses`障害を、追加月額費用0 USDで回避する。

既存のDeno Relay、Durable Objects、QuotaControllerを最大限活用し、Production相当のCPU測定で十分な余裕を証明できる構成を実現する。

新しいLinux Host Runnerの構築自体は目的としない。

## 2. 設計上の制約

### 必須条件

- Cloudflare Workers Freeを維持する。
- Deno Deploy Freeを維持する。
- 新たな月額課金を発生させない。
- Stage 1/2の実行前には、§8のCost / Capacity Preflight Gateが`PASS`であること。未確認なら`HOLD`とする。
- 自宅サーバー、VPS、EC2を必要としない。
- `QuotaController`を唯一のQuota Authorityとして維持する。
- D1をQuota判断の権威にしない。
- 既存の公開API契約、Idempotency、Streaming、Fail-Closedを維持する。
- ProductionとPreviewの制御・データを隔離する。

### 非目標

- Cloudflare Workers Paidへの移行
- Deno Deploy Proへの移行
- Linux systemd/cgroupベースのHost Runner導入
- 任意コード実行やDeno Sandbox導入
- Chat Completionsの仕様変更
- 無関係な`invalid_json`対応
- 既存Option Bの規範、Owner Decision、HOLDの無断変更

### Anti-goals

CPU問題が解決しても、Quotaの正確性が失われる構成は失敗とする。

また、追加費用0 USDを達成しても、無料枠不足によって通常運用が成立しない構成は採用しない。

## 3. 検討アプローチ

| 方式 | 内容 | 判断 |
|---|---|---|
| Linux Host Runner | systemd、cgroup、独立Registryで処理を実行 | 今回のCPU問題の解決経路としては採用しない |
| Deno中心の全面再設計 | Relay制御・認証をさらにDenoへ移譲 | 変更範囲が大きいため第一候補にしない |
| 既存Deno＋Durable Objects | Workerを軽量化し、CPU負荷を既存クラウド内部へ移譲 | **選択した設計方針** |

採用するのは、既存のIssue #121を活用するCloud-native方式である。

## 4. システムアーキテクチャ

```text
OCTG Client
     |
     v
Cloudflare Worker Free
     |
     | Client認証
     | Relay Context生成・署名
     | Bodyを可能な限り再処理せず転送
     |
     v
Deno Deploy Free
     |
     | Request normalize / prepare
     | Exact tokenization
     | Responses relay / streaming
     |
     +-- Decision Callback
     |      |
     |      v
     |   Cloudflare Worker
     |      |
     |      v
     |   RelayDecisionController DO
     |      |
     |      v
     |   QuotaController DO
     |
     +-- Activation / Renewal / Terminal
     |      |
     |      v
     |   Cloudflare Worker
     |      |
     |      +-- Existing Worker-side path
     |      |
     |      +-- Optional Lifecycle DO
     |          (CPU Gate FAIL時のみ)
     |                 |
     |                 v
     |           QuotaController DO
     |
     +-- Cloudflare AI Gateway
              |
              v
           OpenAI API
```

この図は論理設計であり、Optional Lifecycle DOの実装・有効化はまだ承認しない。

## 5. コンポーネント責務

### 5.1 Cloudflare Worker

責務：

- Client Key認証
- Relay Contextの生成・署名
- 入力とCallbackのサイズ・形式制限
- 内部サービス認証
- Durable ObjectへのDispatch
- Deno Relayへのストリーム転送
- APIレスポンスの軽量なマッピング

WorkerのCPU負荷を増やす本文再解析、重複した正規化、不要な暗号鍵Importを避ける。

### 5.2 Deno Deploy Free

責務：

- Tokenizer / Prepare
- Responsesの正規化
- OpenAI互換Relay
- 上流APIへのリクエスト送信
- Streamingの中継
- Grant Lifecycle Callbackの呼び出し

DenoはRelay HMAC鍵を保持せず、GrantやQuotaの最終的な権限を取得しない。

### 5.3 RelayDecisionController

責務：

- 署名済みContextの検証
- Model・Policy・Token Budgetの判断
- QuotaControllerへのAdmission依頼
- Grant発行処理

既存の正常なDecision経路を不要に再設計しない。

### 5.4 RelayGrantLifecycleController（条件付き）

Activation、Renewal、TerminalのWorker CPU GateがFAILになった場合のみ導入を検討する。

対象処理：

- Grant HMAC検証
- Canonical JSON検証
- Grant Binding検証
- Lifecycle Callbackの意味検証
- QuotaControllerへの操作依頼

新DOはQuota Authorityにならない。

### 5.5 QuotaController

引き続き唯一のQuota Authorityとし、予約、Admission、精算、Uncertainty、Replay、Reconciliationの整合性を維持する。

## 6. CPU問題の解決方式

### 6.1 既存のHMAC最適化

PR #124で実装されたCryptoKey再利用コードを再利用する。

確認対象：

- 同一鍵のImport再利用
- 鍵ローテーション
- 同時Import
- Import失敗後の回復
- 署名・検証結果の互換性

コードの存在は実測CPU改善の証明ではない。

### 6.2 Invocation単位での測定

以下を個別に測定する。

- Ingress
- Decision
- Activation（Normal / Replay）
- Renewal
- Terminal（Normal / Replay）

実測によって問題のあるInvocationを特定する。推測だけでCPU負荷の移譲先を変更しない。

### 6.3 Lifecycle DO移譲

Activation、Renewal、Terminalに関する必須CPU測定がFAILの場合、既存Issue #121に定義された条件付きLifecycle DO移譲を検討する。

IngressまたはDecisionのFAILを、無関係なLifecycle DO導入で解決したことにはしない。

## 7. CPU受入条件

既存Issue #121の基準を維持する。

各必須測定系列で以下を満たすこと。

```text
successfulInvocations >= 500
p99 <= 5 ms
max <= 7 ms
exceededCpu = 0

Platform telemetry = complete
Candidate identity = verified
Workload classification = verified
```

不完全なTelemetryをPASS扱いしない。CPUの5/7/0 Gateと§8の無料枠Preflight Gateは独立した必須条件であり、どちらか一方のPASSで他方の未検証を代替しない。

測定は、入力サイズ、Streaming有無、Tool履歴、同時実行条件を含む既存のCanonical Workload Matrixに基づく。

## 8. 無料枠の成立性 — Cost / Capacity Preflight Gate (OCTG-ZC-RG-001)

**追加費用0 USD**と**通常運用およびCPU Gate測定の容量成立**は、CPU性能とは独立した必須受入条件とする。以下の公開値は2026-11-03（JST）に公式一次資料を参照した設計用のスナップショットであり、OCTGアカウントの現在の契約・残量を確認した証拠ではない。

### 8.1 Free枠・必須メーター・参照元（F-001）

下表は2026-11-03（JST）に公開された公式一次資料を照合して記述した**設計時参考値**であり、実アカウントの料金体系・残量・限度額の確認済み証拠ではない。実行前に当該CloudflareアカウントおよびDeno Organizationの有効プラン、Limits、期間、Billing上限と照合する。Free資格・残量・根拠に欠落があれば`PREFLIGHT_HOLD / NOT_VERIFIED`。

| メーターID | 対象Scope（共有上限の単位） | Canonical Unit | Reset window | Free参考上限 | 公式証拠・実行時確認先 |
| --- | --- | --- | --- | --- | --- |
| `workers.requests.daily` | Cloudflare account内のWorker全体 | requests | UTC日次 00:00 | 100,000/日 | [Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)；同アカウントのUsage/Billing |
| `do.requests.daily` | Cloudflare account内のSQLite-backed DO全体（RPC session・HTTP・Alarm等） | requests | UTC日次 00:00 | 100,000/日 | [DO Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)；同アカウントのDO Analytics/Billing |
| `do.duration.gb_s.daily` | Cloudflare account内のDO全体 | GB-s | UTC日次 00:00 | 13,000 GB-s/日 | [DO Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)；DO Duration Analytics |
| `do.rows_read.daily` | Cloudflare account内のSQLite-backed DO全体（SQL/KV readを含む） | rows | UTC日次 00:00 | 5,000,000 rows/日 | [DO Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)；DO SQL/KV rows read Usage |
| `do.rows_written.daily` | Cloudflare account内のSQLite-backed DO全体（SQL/KV write・delete・alarmを含む） | rows | UTC日次 00:00 | 100,000 rows/日 | [DO Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)；DO rows written Usage |
| `do.storage.bytes.total` | Cloudflare account全体のSQLite-backed DO保存データ | bytes | non-resetting stock | 5,000,000,000 bytes 合計 | [DO Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) / [DO Limits](https://developers.cloudflare.com/durable-objects/platform/limits/)；DO Storage Usage |
| `d1.rows_read.daily` | Cloudflare account内の全D1データベース | rows | UTC日次 00:00 | 5,000,000 rows/日 | [D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/)；D1 Metrics/GraphQL/API |
| `d1.rows_written.daily` | Cloudflare account内の全D1データベース | rows | UTC日次 00:00 | 100,000 rows/日 | [D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/)；D1 Metrics/GraphQL/API |
| `d1.storage.bytes.total` | Cloudflare account内の全D1データベース | bytes | non-resetting stock | 5,000,000,000 bytes 合計 | [D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/) / [D1 Limits](https://developers.cloudflare.com/d1/platform/limits/)；D1 Storage Usage |
| `deno.inbound_requests.monthly` | Deno Organization内の対象プラン全Deploy | requests | 料金期間ごとの月次 | 1,000,000/月（設計時参考） | [Deno Deploy Pricing](https://deno.com/deploy/pricing)；Deno Consoleの現在のFree契約 |
| `deno.active_cpu.seconds.monthly` | 同上 | seconds | 同上 | 保守計画値36,000秒（10h）；現行実効値は未検証 | 同上；CPU meterをOrganization単位で照合 |
| `deno.memory.gib_hours.monthly` | 同上 | GiB-h | 同上 | 保守計画値150 GiB-h；現行実効値は未検証 | 同上；実アカウントのMemory meter |
| `deno.egress.bytes.monthly` | 同上 | bytes | 同上 | 保守計画値20,000,000,000 bytes；実効値要確認 | 同上；Egress meter |
| `deno.revision_storage.bytes.total` | Deno Organization内の適用されるrevision/storage枠 | bytes | 原則non-resetting stock（公式契約に従う） | 過去R0.1.1参考値10 GiB；現行適用と単位は`NOT_VERIFIED` | 同上；当該組織のプロダクト/Storage上限を照合 |

Denoの月間CPU 10hと150 GiB-h、Revision Storage 10 GiBは先行R0.1.1由来の**暫定上限**であり、現在の公開Pricingと差異があり得る。実行時には現行Deno Deploy/Classicの種別を区別し、当該Organizationの有効なメーター・Free実効値を確認する。該当しないメーターを無根拠に削除・ゼロ化しない。実アカウントで追加の課金／Hard limitメーターが有効なら同じ契約で`requiredMeters`に追加し、適用不可が証明されたメーターは理由・公式根拠をOperatorが記録してから設計のOwner判断を受ける。未解決の適用判断は`HOLD`。

Worker Free HTTP CPU 10ms/InvocationおよびCPU Gateの`p99 <= 5ms`、`max <= 7ms`、`exceededCpu = 0`は**別の性能Gate**。DO CPU 30秒などのInvocation limit、Worker subrequest上限、D1データベースあたりのサイズ上限も別の技術上限として遵守する。Rows Read/Writtenを既存Requests/Durationで代用しない。D1が監査専用でも、D1の消費と容量はCost Gateから除外しない。

DOのRPC method呼出しは個々にRequest計上され得る。DO SQL/KVの読み書きはRows Read/Writtenに計上される。各`meter`は`id`以外にも必ず`scope`、`unit`、`resetWindow`、`verifiedFreeLimit`、`consumedUsage`、`normalForecast`、`reserve`、`gateBudget`、`evidenceSource`（参照・取得時刻）を持つ。`scope`はCloudflare系なら`cloudflare:<cloudflareAccountId>`、Deno系なら`deno:<denoOrganizationId>`とし、当該Providerの全サービスを合計した実際の共有上限へ結び付ける。Worker名やD1データベース名単独を上限Scopeとして認めない。`limit/consumed/normalForecast/reserve/gateBudget`の不明値を推定で埋めない。空・欠損・`NaN`・不正単位は`PREFLIGHT_HOLD`とする。

### 8.2 測定Matrixと最小・最大試行の計上

Source of truth：`scripts/relay-cpu-workloads.mjs`の`requiredSeriesMatrix()`、`scripts/run-relay-cpu-gate.mjs`の`SUCCESS_SAMPLE_TARGET=500`と試行制限、およびIssue #121のCanonical Workload Matrix。

- Invocation Classは7種、Workload Classは4種。`activation_normal`と`terminal_normal`はConcurrency=1のみ（計8系列）、他5クラスはConcurrency=1/2/3（計60系列）。合計**68系列**。
- **最小成功測定Invocation数は68 × 500 = 34,000**。Stage 1とStage 2はそれぞれ独立した測定・予算を必要とする。条件付きLifecycle DOへの変更でStage 1を再実行する場合、その分を改めて計上する。
- Runnerの`attempts < totalTarget * 5`により、500成功/系列を目標とする測定試行の計画上の5倍枠は**68 × 2,500 = 170,000回**。Concurrencyによる最終バッチの端数、失敗時の復旧、再実行、Fixture制御呼出しは**追加の安全側予算**に含める。170,000回を全リソースの厳密な課金上限と誤認しない。
- 測定以外に、Fixture `setup`、`setup-fence`、`decision-context`、`quota/slot` Snapshot、`operation-inspection`、`reconcile-unused`、`close-operation`、GrantのActivation/Renewal/Terminal、Secretの一時登録・後始末、Telemetry API取得、通常トラフィック、復旧用操作を種別ごとに数える。
- 最小34,000測定InvocationだけでWorker Freeの1日100,000枠の34%に相当するが、これを1日の実行可能性の証明としない。5倍試行枠170,000は、追加呼出し・通常トラフィックを除いてもWorkerの日次枠を超えるため、最悪ケースを単一日で無条件に実行してはならない。

### 8.3 実行前のCost Gate判定契約（F-001 / F-002）

Stage 1、Stage 2（PreflightおよびSeries）、条件付き再測定を開始する前に、**証拠と実行対象の独立した二つの入力**を要する。`CapacityEvidenceV1`は費用計画の申告であって、実行対象を自分自身で認証するものではない。`ExecutionTargetV1`はOperatorが外部の権威ある情報から照合した別入力であり、単に同一JSON内のコピーを比較することを禁止する。正確な型と検証責務は§8.5に定義する。

各必須メーターについて、当該プロバイダの共有Scope・Unit・Reset windowを基準に、以下を記録する。

1. `L` / `verifiedFreeLimit`：現行有効Freeプランの公式限度・取得時刻・アカウント確認証拠。
2. `U` / `consumedUsage`：同一Scope・期間の**権威ある実消費量**。Account/Organization内の他サービスも含み、`usageObservedAtUTC`を記す。
3. `N` / `normalForecast`：期間内の本番・Preview・他アプリの需要見通し。使用実績がない場合は`NOT_VERIFIED`であり、仮のゼロを認めない。
4. `B` / `gateBudget`：同一期間内の完全な測定・再試行・Fixture setup/close・内側のRPC・D1行走査/書込み・DO SQL/KV読み書き・Deno実行・Telemetry/後始末の予算。Rows Readは検索・全表走査を、Rows WrittenはIndex更新・Delete・Alarm設定を反映する。予算内訳の欠損は`HOLD`。
5. `R` / `reserve`：通常運用、復旧/閉鎖、ピーク揺らぎの余力。Owner許容値と根拠を記録する。

`resetWindow`が`utc_day`ならUTC 00:00から次のUTC 00:00、`billing_month`ならProviderが実際に定めた請求期間、`nonresetting_stock`なら永続ストックとして`asOfUTC`を使い、日次枠のように再計算しない。Stageの実行期間・計測範囲が証拠のwindowを超える場合は`HOLD`。ストック系は予測される保存増分・削除の検証された差分を`B`/`N`に含める。

**全必須メーターで** `L - U - N - R >= B` が成立し、かつ§8.5の独立したTarget照合・Operator確認・鮮度・Free資格が証明されて初めて`PREFLIGHT_PASS`とする。一項目でも欠損、Scope/Unit/期間の不一致、Rows Read/Write超過、証拠真正性未確認、実行対象との不一致があれば`PREFLIGHT_HOLD`とし、実績未取得は`NOT_VERIFIED`と別記する。明示的な0は権威ある0実績または根拠付きゼロ増分のみ許す。観測していないFree枠超過を観測済みFAILと記さない。

`PREFLIGHT_PASS`の保証は**証拠が指定実行対象と独立照合済みで、現時点のFree容量の計画上の余裕が証明されたことのみ**である。CPU Gate PASS、Secret/Quota安全性、Remote実行承認、Production HOLD解除を意味しない。Provider使用量は変化するため実行開始直前にも再確認する。

### 8.4 実行中の制限・停止・日分割

- 計画したバッチ開始直前および日次/課金期間リセットをまたぐ前に、残容量と通常トラフィックの消費を再確認する。消費が計画以上に増えた、権威ある使用量を取得できない、Cleanup余力が不足する場合は**次の測定バッチを開始せずHOLD**する。既存の活動中Grantは通常の安全な閉鎖・証拠保存を優先する。
- 残容量不足時は、同じSource Revision・ScriptVersion・Harness Fingerprint・Workload定義を維持でき、非重複Measurement Window、各系列500成功、Telemetry完全性、Fixture/Grant終端証拠を損なわない範囲で、**UTC日次またはDeno課金月次のリセットに沿って測定を分割する**。**実装済みRunnerの安全な一時停止・再開手段は未証明**であり、実現できない場合は分割を実行せずHOLDする。系列の一部だけをPASSに繰り上げない。
- 追加課金や自動アップグレード、Cloudflare Workers Paid・Deno Proへの移行、Quota制限・CPU 5/7/0基準の緩和、Production消費枠の転用は許可しない。費用条件の不成立時はHuman Ownerへ「期間分割」「実行保留」「本アプローチの再検討」を提示して停止する。
- **Preflight判定はドキュメント上の要求であって、現行Runnerに自動Cost Gateが実装済みであるという主張ではない。** 本書を実行認可・実行済み証拠と扱わない。

### 8.5 Evidence Trust Boundary / Execution Target Binding（F-002 / F-003）

- **証拠作成側**：`CapacityEvidenceV1`を、公式の使用量・料金画面/Analytics/APIの取得時刻と参照IDに基づいて作成する。データそのものは「申告」に過ぎず、JSON内の`stage`/`workerName`/`sourceRevision`/`accountScopeRef`を信頼された実行対象として再利用しない。
- **Operator（外部事実の確認責任）**：実際のCloudflare Account ID、Deno Organization ID、Environment、Worker名、選択Source Revision、Stage、Usage Period、Freeプラン適格性、証拠の真正性を、証拠ファイルとは**別の権威ある取得元**（Git固定HEAD、Providerの実アカウント設定・Billing・Usage、認証スコープ、Preview/Production構成）から照合し、確認日時・確認者・保護された参照記録を作成する。保護された`ExecutionTargetV1`を別入力として与える。Stage 1のUpload前は固定Source RevisionとPreview対象、Upload後は実ScriptVersionを既存Stage 1 Preflightで改めて照合する。
- **実装による構造検証**：`evaluateCapacityPreflight(evidence, target, nowUTC)`は必須メーター完全性、Unit/期間/Free Limit/残量算術、両入力のID/Environment/Revision/Stage/期間/Free資格の一致を検証し、独立したOperator確認の証拠ID・鮮度・未改変取扱いを確認する。CLIはProtected Targetファイルの読込みに加えて、現在のGit checkout HEAD、CLI引数、Preview Config、認証スコープ内のCloudflare Account IDとの独立一致を要求し、Deno Organization/Free資格は別のOperator確認記録を要求する。別入力であること**だけ**では暗号学的な真正性を保証しないため、Operator確認の外部根拠が未取得なら`PREFLIGHT_HOLD`。
- **Runner（実行境界）**：外部アクション前にCLI引数・固定Git checkout・Preview/Production構成・認証済みCloudflare Account IDから独立に導出したTargetと、OperatorがDeno Console等から照合した保護記録を照合する。追加CLI入力は`--capacity-evidence=<protected-path>`と`--execution-target=<separate-operator-verified-protected-path>`。後者のファイルが存在する**だけ**では真正性を証明しない。別取得のProvider/Git証拠・Operator確認参照が検証できない場合は`HOLD`。証拠JSONからWorker名・アカウント・Stageを採用しない。`recover-operation`は既存の認可・Fence・Grant終端証明を保ち、Cost Gate `HOLD`でも安全なCleanupを妨げない。

`ExecutionTargetV1`には少なくとも`cloudflareAccountId`、`denoOrganizationId`、`environment`、`workerName`、`sourceRevision`、`stage`、`usagePeriods`（各meterのScope/period）、`freePlanEligibility`、`verifiedAtUTC`、`operatorVerificationRef`、`providerIdentityEvidenceRefs`を保持する。`CapacityEvidenceV1`にはこれと同じ対象識別子、観測時刻・満了時刻・必須メーターと各参照を保持し、**双方の正当性の確認元を分離する**。独立確認は秘密情報をログ・Gitへ持ち込まない。

どちらかのCloudflare account、Deno Organization/account、Environment、Worker名、Source Revision、Stage、Usage Period、Free資格が相違、15分を超える使用量鮮度、明示的な満了、検証参照の不備、Source SHAが未固定、Operator確認が成立しない場合は`PREFLIGHT_HOLD`。`--execute`等の既存認可だけでこの照合を迂回できない。`stage2-preflight`と`stage2-series`は共通のStage 2 Targetを使いつつ、それぞれ開始前に照合し直す。

### 8.6 Operator Trust Record — 信頼起点・生成・保護・検証・消費（Review Gate R1 F-002/F-003）

#### 8.6.1 信頼モデルと保証範囲

本Cost Gateの信頼起点は、既存のHuman Ownerが認めた**Operatorによる独立証拠確認と、Operator管理のローカル実行セッション**である。`CapacityEvidenceV1`、`ExecutionTargetV1`、任意の`operatorVerificationRef`は、どれも単独では信頼起点にならない。新規署名サービス、外部クラウド、Host Runnerは追加しない。

Operatorは、候補ファイルの外から、①固定Git commit、②CLI引数と実際のPreview/Production構成、③認証されたCloudflare Accountの画面/API・Free契約、④Deno Organizationの画面/API・Free契約、⑤各メーターのProvider使用量・期間を確認する。Provider画面を人手で照合する場合はその事実を明記し、暗号学的なProvider認証を行ったと主張しない。アカウント・Git・Free資格を同一の自己申告JSONからコピーして「独立照合済み」としない。

Operatorを**信頼主体**とすることは、同じOSユーザー権限を完全に奪取した攻撃者への耐性を主張するものではない。Operatorセッションまたは証拠保存先の制御が立証できないときは`PREFLIGHT_HOLD / TRUST_ROOT_NOT_PROVEN`。

#### 8.6.2 `OperatorTrustRecordV1`（正規スキーマ）

実行承認済みOperatorが保護領域で生成する記録は、次の必須フィールドを持つ。`ExecutionTargetV1`と`CapacityEvidenceV1`は既存§8.5/Plan Task 2の型を維持する。

```ts
interface OperatorTrustRecordV1 {
  schemaVersion: 1;
  recordId: string; // locally generated UUID; never a user-selected proof of authority
  operatorId: string; // authorized Operator identity in the controlled session
  reviewedAtUTC: string; expiresAtUTC: string; // ISO UTC, expiry <= 15 minutes
  targetSha256: string; capacityEvidenceSha256: string; // 64 lowercase hex
  target: {
    cloudflareAccountId: string; denoOrganizationId: string;
    environment: 'preview' | 'production'; workerName: string;
    stage: 'stage1' | 'stage2'; sourceRevision: string;
    usagePeriodsSha256: string; freePlans: { cloudflare: 'free'; deno: 'free' };
  };
  proofEntries: Array<{
    kind: 'git_commit' | 'worker_config' | 'cloudflare_account' |
          'cloudflare_free_plan' | 'cloudflare_usage' |
          'deno_organization' | 'deno_free_plan' | 'deno_usage';
    sourceKind: 'authenticated_provider_read' | 'operator_verified_console' |
                'local_git' | 'local_config';
    sourceRef: string; snapshotSha256: string; observedAtUTC: string;
    checkedIdentity: string; verificationMethod: string;
  }>;
  operatorDecision: 'VERIFIED_FOR_CAPACITY_PREFLIGHT';
}
```

`proofEntries`は上記8種類すべてを最低1件ずつ必要とし、実際の固定Source/Worker/Account/Organization/期間を各証拠と一致させる。参照IDだけを用意しても足りない。`sourceRef`の保護された実体を読めること、各実体のSHA-256が記録と一致すること、取得元・認証スコープ・確認方法・観測時刻が記録されたことを要する。存在しない証拠、未取得のProvider値、失効した証拠、自己申告の`verified: true`だけでは成立しない。Providerが提供しない機械可読の真正性保証を仮定しない。

#### 8.6.3 Operatorによる生成と保護

1. **独立証拠取得（将来の別承認作業）:** Operatorは正規Git/Preview構成と、ログイン済みのCloudflare/Deno Consoleまたは認証付き読み取りAPIから上記証拠を取得・照合する。証拠は秘密情報・Request/Response Bodyを除いた保護スナップショットとして扱い、`sourceRef`・観測時刻・内容SHA-256を残す。対象が`stage1`ならPreview、`stage2`ならProductionの実対象で確認する。
2. **容量証拠作成:** `CapacityEvidenceV1`はProvider/使用期間のメーター実績から作成し、実行対象から独立の証拠としてSHA-256を算出する。F-001の全14メーターと追加の適用メーターが欠けたら停止する。
3. **TargetとTrust Record作成:** Operatorは証拠の事実から独立して`ExecutionTargetV1`を確定し、`targetSha256`、`capacityEvidenceSha256`、8種類のproofと確認日時を固定した`OperatorTrustRecordV1`を作成する。`recordId`を使って任意のJSONを承認済みと扱わない。
4. **保存先:** Operatorが信頼するローカル作業領域の専用ディレクトリ（所有者Operator、permission `0700`）に、Target/Cost Evidence/Proof/Trust Recordを個別の通常ファイル`0600`で保護する。Symlink、想定外の所有者・ACL・他者書込み、world/group writableな親ディレクトリ、同名ファイルの上書きは拒否する。作成は排他的・原子的に行う。Secretsや生のPromptは保存しない。Git/CI artifactへアップロードしない。
5. **Operator承認:** 証拠のアカウント名・Free適格性・Revision・Stage・期間・内容ダイジェストをOperator自身が**実際のProvider/Git証拠と照合して確認**する。専用承認手続きはTrust RecordのSHA-256を、`--execution-target`の入力とは独立したOperator管理セッションに固定する。**具体的な入力方式は、本番entryで`process.stdin.isTTY && process.stdout.isTTY`を確認し、`node:readline/promises`の対話入力でOperatorがTrust RecordのSHA-256（64桁）を再入力する方式とする。** 文字列は入力ファイル・CLI引数・環境変数から補完しない。証拠保護rootは`node:os.homedir()`から導出する`~/.local/state/octg/cpu-gate/approved/`（Operator-owned `0700`）に固定し、Callerの任意指定で変更しない。実行Callerは承認ダイジェストを任意のコマンド引数/CapacityEvidenceで上書きできない。非対話/承認主体不明/承認記録不備はHOLD。承認確認はCPU Gate実行承認・HOLD解除を意味しない。

#### 8.6.4 受理時の判定とFail-Closed

`resolveVerifiedExecutionTarget(...)`はローカル保護領域とOperatorの**独立した承認ダイジェスト**を信頼起点にし、①Recordの存在・所有権/保護/通常ファイル確認、②承認ダイジェスト照合、③Recordの必須8証拠の保護実体・SHA-256・確認元・期限検証、④Target/EvidenceのSHA-256固定、⑤Git checkoutの実HEAD・CLI引数・実Worker構成・認証済みCloudflare account・独立にOperator検証されたDeno OrganizationとFree資格の一致、⑥Stage/Usage period/15分鮮度、⑦既存§8.3の全メーター残容量、の順で判定する。

**戻り値:** 正常時のみ`ExecutionTargetV1`を返す。入力/保護/認証元/対象/期間/Hash/Operator承認のいずれかが不明・不一致・失効・照合不能なら`undefined`を返し、上位CLIは`PREFLIGHT_HOLD`かつ終了コード`2`で**Upload/Deploy/Secret変更/Fixture/測定の全てを開始しない**。例外を捕捉してPASSにしない。ログには`TRUST_RECORD_MISSING`、`UNTRUSTED_RECORD_PATH`、`PROOF_UNVERIFIED`、`HASH_MISMATCH`、`OPERATOR_NOT_CONFIRMED`、`TARGET_MISMATCH`、`EXPIRED_EVIDENCE`等の非秘密reason codeだけを出す。

このモデルは**Operatorに対する偽装耐性を暗号学的に証明するものではない**。Operatorとその保護領域が信頼できない場合は`NOT_VERIFIED/HOLD`。有効なTrust Recordがあっても`PREFLIGHT_PASS`は容量照合のみであり、別途OwnerによるRemote実行承認、CPU Gate 5/7/0、Quota/Streaming/Idempotency/Fail-Closed、Production HOLDの条件を変更しない。

#### 8.6.5 CLI境界

本番CLI経路は`runCpuGateCli()`（`scripts/run-relay-cpu-gate.mjs`）→本番`createOperatorVerifiedTargetResolver()`→`executeCpuGateCli()`（`scripts/relay-cpu-cli.mjs`）→`resolveVerifiedExecutionTarget()`→`evaluateCapacityPreflight(evidence,target,nowUTC)`とする。Fake resolverは**テスト限定**であり、本番入口から任意に差し替えられない。Task 2/3でこの接続・失敗テストを定義する。`recover-operation`は既存の認可と安全な終端処理を維持し、新Cost GateだけのHOLDによって妨げない。

## 9. Security / Safety Invariants

以下は変更不可の設計条件とする。

- Relay HMAC秘密鍵はCloudflare側に保持する。
- DenoからのCallbackを、それ自体でGrant認可済みと扱わない。
- Grantの検証とQuota変更の権限を分離する。
- 不明な上流実行結果はUncertaintyとして保守的に扱う。
- 再試行で二重の上流請求・Quota消費を発生させない。
- Client Key、Grant Credential、Prompt、Request/Response BodyをTelemetryやFixtureに保存しない。
- PreviewとProductionの権限・Secret・Quota状態を混在させない。
- CPU改善を理由にFail-Openを許さない。

## 10. 実証とRollout

既存のIssue #121の実装計画を使用する。

### Stage 1 — Preview CPU Gate

隔離PreviewでCPU測定と正しさを実証する。

必要な証拠：

- Source RevisionとWorker Versionの一致
- Previewリソース隔離
- Grantの終了・復旧証拠
- 完全なCPU Telemetry
- 必須系列のPASS判定

### Conditional Lifecycle DO

既存計画で定義された条件が成立した場合のみ実装・検証対象にする。

### Stage 2 — Production-like Gate

別途Human Ownerが承認した範囲で、既存のCompatibility BridgeとVersion Overrideを利用する。

Stage 1の成功だけでProductionへ適用しない。

### Rollback / HOLD

既存のProduction HOLDを維持する。

CPU Gate未成立、Version不一致、Quota整合性不明、Secret処理未完了の場合には適用を停止する。

### As-built / Pending Crosswalk (OCTG-ZC-RG-002)

以下は固定`master` HEAD `40857b37db1e0a53f20b794daae6e6b45195beef`に対する**静的な現状整理**。既存Planのチェックボックスは歴史的な計画記述であり、「未チェック」だけで実装未着手と判定しない。逆にGitHub Merge/CI成功をRuntime CPU Gate PASSやRemote承認に昇格させない。

| 既存Plan工程 | 状態区分 | 確認済みの範囲と未成立の境界 | 再開上の判断 |
| --- | --- | --- | --- |
| Tasks 1–5：HMAC Cache、共有Contract、QuotaController CPU Gate、Worker保護制御、Measurement Harness | `IMPLEMENTED_IN_CODE` | PR #124は2026-10-27マージ済み。`relay-credential.ts`、`relay-cpu-gate.ts`、`relay-cpu-workloads.mjs`、`relay-cpu-evidence.mjs`、`run-relay-cpu-gate.mjs`等を現行コードで確認。 | **Task 1からの無条件再実装は禁止。** 必要なら固定HEADと既存テスト・スクリプトの適合確認だけ行う。 |
| Tasks 1–5のローカル検証 | `LOCALLY_VERIFIED`（履歴限定） | PR #124の報告には`npm test` 1,617件PASS、`npm run typecheck` PASSがある。本Taskでテストは再実行しておらず、現行HEADの新たなPASS証拠ではない。 | 過去のCI/PR証拠と現在のCode Identityを区別する。 |
| Task 6：Production再発原因照合・Stage 1 Preview測定 | `RUNTIME_NOT_VERIFIED` / `NOT_AUTHORIZED` | 認可されたRemote CPU計測の合格証拠、Previewの最新Secret/環境/残容量は未取得。Stage 1のRunner存在はGate PASSを意味しない。 | **最初の実証再開地点はTask 6の事前条件確認**。§8 Preflightと権限が揃った場合に限り、別承認で実行。 |
| Tasks 7–8：Lifecycle DO実装とCallback移譲 | `CONDITIONAL_NOT_IMPLEMENTED` | `RelayGrantLifecycleController`のクラス、Binding、migration v4、Offload Selectorは固定HEADに未実装。 | **Activation/Renewal/TerminalのCPU系列がFAILした場合のみ**実装要否を判断する。Ingress/Decision FAILでは進まない。 |
| Tasks 9–11：DO Compatibility Manifest、Production Version/Bridge/Harden Tooling、Operations整合・Revision Lock | `NOT_AUTHORIZED`（一部未実装） | Planが要求する`do-compatibility-manifest.mjs`、`relay-cpu-version-config.mjs`、`relay-cpu-rollout.mjs`は固定HEADで確認できない。先行するPreview/CPU Gateの成果をもってこの範囲を完成扱いしない。 | Stage 1の結果とOwner判断を受け、必要な残作業だけを元Planに沿って扱う。 |
| Task 12：Production-like Stage 2・Candidate Promotion・Hardening | `HELD` / `RUNTIME_NOT_VERIFIED` / `NOT_AUTHORIZED` | PR #126のHOLD保護コードは存在。`HOLD_CODE_PRESENT=YES`だがRemoteでの`HOLD_ACTIVE`は未証明。Stage 2の合格証拠は未確認。 | 明示承認と既存PlanのStage 1→Bridge/0% Candidate→Stage 2→Hardeningの順序を満たすまで実行禁止。 |

**Cost Gate契約の連続性：** 本R0.1.2候補の§8.1〜§8.5と、Continuation Plan R1.1候補のTask 2/3は同一の`CapacityEvidenceV1`・`ExecutionTargetV1`・`evaluateCapacityPreflight(evidence,target,nowUTC)`を用いる（将来実装であり現行コードには未追加）。

**Contract alignment（本訂正での差分導入禁止）：** §4〜§7の`/v1/responses`、Relay Context/Grant、`RelayDecisionController`、`QuotaController`、Callbackの認証・型・エラー分類・Streaming/Idempotencyは既存`SPEC.md`とIssue #121のNormative Design/Implementation Planを参照し、本書から新しいRPC、HTTPステータス、エラーEnum、Retry規則、Quota挙動を定義しない。§8は**Remote Gate起動前の費用・容量判断**の追加であり、Runnerの実装済み機能ではない。テスト方針（既存Canonical Matrix・Platform Telemetry・5/7/0）と非機能条件（追加費用0 USD、Preview/Production隔離、Fail-Closed、Rollback/HOLD）は変更しない。矛盾する解釈があれば本書を正規化根拠とせず、既存Normative Contractを優先し、当該実行をHOLDする。

## 11. 既存成果物との関係

本設計は、次の既存資料を置き換えない。

- [Issue #121 — Worker CPU Headroom Redesign](https://github.com/yohi/octg/issues/121)
- [PR #123 — 既存の技術設計・実装計画](https://github.com/yohi/octg/pull/123)
- [PR #124 — 実装済みCPU対策](https://github.com/yohi/octg/pull/124)
- [PR #126 — Production Release HOLD関連実装](https://github.com/yohi/octg/pull/126)
- `SPEC.md` — 現行API・Quota契約
- Option B Phase 1の既存Owner DecisionおよびHOLD

本書は、CPU制限回避という本来の目的に照らし、Cloud-native方式を選択した理由と、その適合条件を整理する設計上の補足文書である。

## 12. 残余リスク・未検証事項

1. Stage 1 CPU Gateの実測PASSは未確認。
2. 現在のCloudflare Preview環境・Secret・権限は未確認。
3. Productionでの新CandidateのCPU改善は未証明。
4. Deno Deploy FreeとDurable Objects Freeの実利用量に基づく容量適合性は未証明。
5. Lifecycle DO移譲の必要性はCPU実測に依存する。
6. 既存Option BのHost Runner要件をCloud-native方式が満たすとは主張しない。

これらを設計上の未確定事項として残す。実際の失敗と証拠未取得を混同しない。

## 13. 完了条件と後続工程

### 本設計Taskの完了条件

- 目的・非目標・費用条件が明確である。
- 選択したアーキテクチャと責務境界が明確である。
- 既存Issue #121との重複・差分が明確である。
- CPU受入条件と安全不変条件が明確である。
- Human Ownerが本設計を承認または差戻しできる。

### 後続工程

Human Ownerは2026-11-03（JST）にR0.1.1を文書限定採択した。これはImplementation GO、Stage 1/2実行承認、Production/Preview操作、HOLD解除を含まない。既存PlanのTasks 1–5を再開始せず、§10 Crosswalkに従いTask 6の準備状況を判断する。必要なら既存のSuperpowers実装計画に対する**限定的な差分整理**を行う。

新規のImplementation Planを機械的に作成しない。

Stage 1実行、Cloudflare操作、GitHub書込み、Production HOLD変更は、いずれも別の明示承認を必要とする。

**Document status：R0.1.2 DOCUMENTARY_CORRECTION_CANDIDATE / NOT_OWNER_ADOPTED — IMPLEMENTATION HOLD / RUNTIME_NOT_VERIFIED**
