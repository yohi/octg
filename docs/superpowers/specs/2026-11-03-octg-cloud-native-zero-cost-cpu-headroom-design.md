# OCTG — Cloud-native Zero-Cost CPU Headroom Design R0.1

**基準日：** 2026-11-03（JST）  
**Repository：** `yohi/octg`  
**Baseline HEAD：** `40857b37db1e0a53f20b794daae6e6b45195beef`  
**Design Status：** `DRAFT / NOT_OWNER_APPROVED`  
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

不完全なTelemetryをPASS扱いしない。

測定は、入力サイズ、Streaming有無、Tool履歴、同時実行条件を含む既存のCanonical Workload Matrixに基づく。

## 8. 無料枠の成立性

以下の無料枠を設計上の制約として扱う。

- Cloudflare Workers Freeのリクエスト・CPU制限
- Durable Objects Freeのリクエスト・実行時間・ストレージ枠
- Deno Deploy Freeのリクエスト・Active CPU・メモリ時間・帯域枠

**追加費用が0 USDであることと、十分な運用容量があることは別の受入条件とする。**

見積りは推測値ではなく、実際のInvocation数、Deno CPU消費、DO稼働時間、通信量から算出する。

無料枠内に収まらないことが判明した場合、別の有料サービスを自動契約しない。Human Ownerに選択肢を提示して停止する。

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

設計承認後、必要なら既存のSuperpowers実装計画に対する**限定的な差分整理**を行う。

新規のImplementation Planを機械的に作成しない。

Stage 1実行、Cloudflare操作、GitHub書込み、Production HOLD変更は、いずれも別の明示承認を必要とする。

**Document status：DESIGN DRAFT — NOT OWNER APPROVED**
