# OCTG — Cloud-native Zero-Cost CPU Headroom Design R0.1.1 — Owner-Adopted Documentary Correction

**基準日：** 2026-11-03（JST）  
**Repository：** `yohi/octg`  
**Baseline HEAD：** `40857b37db1e0a53f20b794daae6e6b45195beef`  
**Design Status：** `R0.1.1 OWNER_ADOPTED_DOCUMENT_ONLY / IMPLEMENTATION_HOLD`  
**Origin：** `R0.1 feature-branch commit 2b17defc93956308c89198dce6831fa6afc1271d`  
**Scope：** `OCTG-ZC-RG-001 / OCTG-ZC-RG-002 ONLY`  
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

### 8.1 Free枠と参照元

| リソース | Free枠・計測単位（設計時参照） | 集計期間 | 公式一次資料 |
| --- | --- | --- | --- |
| Cloudflare Workers | 100,000リクエスト、HTTP CPU 10ms/Invocation | リクエストは1日、CPUは各Invocation | [Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)、[Pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| SQLite-backed Durable Objects | 100,000リクエスト、Duration 13,000 GB-s | 1日（00:00 UTCリセット） | [Durable Objects Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| SQLite-backed Durable Objects Storage | Freeアカウント合計5 GB。書込み制限や永続占有量も対象 | アカウント単位・累積 | [Durable Objects Limits](https://developers.cloudflare.com/durable-objects/platform/limits/) |
| Deno Deploy Free（新Deploy） | 月100万Inbound Requests、Active CPU 10時間、Memory Time 150 GiB-hour、Egress 20 GiB、Revision Storage 10 GiB | 月次／累積ストレージ | [Deno Deploy Pricing](https://deno.com/deploy/pricing) |

Deno Deployの公式ページは取得時点のスナップショットによってCPU 10時間と15時間などの表示差異が観測されている。この文書では**より保守的な10時間を仮の計画上限**とするが、実行時の正式なアカウント上限・計測定義・期間をDeno Consoleまたは当時の公式ページで再確認しない限り`NOT_VERIFIED`とする。Deploy Classicの枠を新Deployの枠として流用しない。各サービス・同一アカウント／Organization内の他アプリとの共有使用量も含める。

Cloudflare DOのRPCはメソッド呼出しごとに課金対象のRPC Sessionになり得る。Worker測定Invocation数をそのままDOのRequest数やDenoのInbound Request数と見なさない。CPU GateはCloudflare Worker 10msの上限、5/7/0条件の双方を維持する。

### 8.2 測定Matrixと最小・最大試行の計上

Source of truth：`scripts/relay-cpu-workloads.mjs`の`requiredSeriesMatrix()`、`scripts/run-relay-cpu-gate.mjs`の`SUCCESS_SAMPLE_TARGET=500`と試行制限、およびIssue #121のCanonical Workload Matrix。

- Invocation Classは7種、Workload Classは4種。`activation_normal`と`terminal_normal`はConcurrency=1のみ（計8系列）、他5クラスはConcurrency=1/2/3（計60系列）。合計**68系列**。
- **最小成功測定Invocation数は68 × 500 = 34,000**。Stage 1とStage 2はそれぞれ独立した測定・予算を必要とする。条件付きLifecycle DOへの変更でStage 1を再実行する場合、その分を改めて計上する。
- Runnerの`attempts < totalTarget * 5`により、500成功/系列を目標とする測定試行の計画上の5倍枠は**68 × 2,500 = 170,000回**。Concurrencyによる最終バッチの端数、失敗時の復旧、再実行、Fixture制御呼出しは**追加の安全側予算**に含める。170,000回を全リソースの厳密な課金上限と誤認しない。
- 測定以外に、Fixture `setup`、`setup-fence`、`decision-context`、`quota/slot` Snapshot、`operation-inspection`、`reconcile-unused`、`close-operation`、GrantのActivation/Renewal/Terminal、Secretの一時登録・後始末、Telemetry API取得、通常トラフィック、復旧用操作を種別ごとに数える。
- 最小34,000測定InvocationだけでWorker Freeの1日100,000枠の34%に相当するが、これを1日の実行可能性の証明としない。5倍試行枠170,000は、追加呼出し・通常トラフィックを除いてもWorkerの日次枠を超えるため、最悪ケースを単一日で無条件に実行してはならない。

### 8.3 実行前の判定契約

Stage 1、Stage 2、条件付き再測定それぞれの実行前に、**アカウントおよび期間単位**で、以下を一次証拠の時刻・計測範囲とともに記録する。CPU Gate実行そのものは本訂正Taskでは行わない。

1. `L`：現在有効なFreeプランの公式上限、UTC日次／契約月次リセット時刻、Billing/Hard limit設定、プラン種別。
2. `U`：同一アカウント・Organizationでその期間に**実際に消費済み**のWorkerリクエスト、DO RPC/Duration/Storage、Deno Inbound/Active CPU/Memory Time/Egressなどの各メーター。Cloudflare/Denoのダッシュボード・API等、権威ある使用量証拠を記録する（Secretやペイロードは保存しない）。
3. `N`：次のリセットまでのProduction通常運用・Preview・他アプリの消費見通し。利用可能な実績の期間・ピークを示す。実績値が取得不能なら実績を推測で補わず`NOT_VERIFIED`とする。
4. `B`：今回許可する測定バッチに必要な各リソースの予算。測定試行・Concurrency・Fixtureセットアップ/終了・内部RPC・Deno Relay・Telemetry・失敗復旧を、既存Harnessの呼出し構造と測定可能な単価/容量実績から分けて計上する。数が不明な操作は0件と扱わず`NOT_VERIFIED`とする。
5. `R`：通常運用継続、Quota/Grantの安全な後始末、統計の揺らぎを保護する余裕容量。根拠とOwnerの許容範囲を記録する。値を恣意的な0で埋めない。

**全メーターで `L - U - N - R >= B` が実績と保守的な見積りから証明でき、かつ実行権限・Preview隔離・Cleanup/Recovery前提が揃った場合に限り `PREFLIGHT_PASS` とする。** これ以外は`PREFLIGHT_HOLD`とし、未取得・不明・証拠欠損は`NOT_VERIFIED`を添える。実際にFree上限超過が観測された場合のみ「観測済み超過」と記す。CPU Gateの`PASS / FAIL / BLOCKED`をこのCost Gateの判定に読み替えない。

### 8.4 実行中の制限・停止・日分割

- 計画したバッチ開始直前および日次/課金期間リセットをまたぐ前に、残容量と通常トラフィックの消費を再確認する。消費が計画以上に増えた、権威ある使用量を取得できない、Cleanup余力が不足する場合は**次の測定バッチを開始せずHOLD**する。既存の活動中Grantは通常の安全な閉鎖・証拠保存を優先する。
- 残容量不足時は、同じSource Revision・ScriptVersion・Harness Fingerprint・Workload定義を維持でき、非重複Measurement Window、各系列500成功、Telemetry完全性、Fixture/Grant終端証拠を損なわない範囲で、**UTC日次またはDeno課金月次のリセットに沿って測定を分割する**。**実装済みRunnerの安全な一時停止・再開手段は未証明**であり、実現できない場合は分割を実行せずHOLDする。系列の一部だけをPASSに繰り上げない。
- 追加課金や自動アップグレード、Cloudflare Workers Paid・Deno Proへの移行、Quota制限・CPU 5/7/0基準の緩和、Production消費枠の転用は許可しない。費用条件の不成立時はHuman Ownerへ「期間分割」「実行保留」「本アプローチの再検討」を提示して停止する。
- **Preflight判定はドキュメント上の要求であって、現行Runnerに自動Cost Gateが実装済みであるという主張ではない。** 本書を実行認可・実行済み証拠と扱わない。

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

**Document status：R0.1.1 OWNER_ADOPTED_DOCUMENT_ONLY / IMPLEMENTATION HOLD — RUNTIME_NOT_VERIFIED**
