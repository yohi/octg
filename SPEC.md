# OCTG MVP 設計書

**Version:** 1.2
**作成日:** 2026-08-09
**更新日:** 2026-08-24
**基盤要件:** [REQUIREMENTS.md](./REQUIREMENTS.md) v1.0
**スコープ:** Phase 1 (MVP) のみ。Phase 2 / Phase 3 は本書では実装対象外とし、拡張を妨げない設計上の配慮のみ記述する。

---

## 1. 目的と設計原則

OpenAI Data Sharing Program の Tier 3 Complimentary Tokens（STANDARD 1M tokens/日 + MINI 10M tokens/日）を複数クライアント間で一元管理し、意図しない課金を最大限防止する OpenAI 互換 API Gateway を構築する。

REQUIREMENTS.md 第 52 章の 5 原則を継承する：

1. AI Gateway Spend Limit を無料枠カウンターとして信用しない
2. Durable Object で request 前 reservation を行う
3. actual usage で reservation を精算する
4. 不確実な request は消費済みとして扱う（fail-closed）
5. Paid fallback は明示的 opt-in がない限り発生させない

## 2. 確定した意思決定

ブレインストーミングで確定した事項：

| # | 項目 | 決定 |
|---|------|------|
| 1 | 設計スコープ | Phase 1 (MVP) のみ |
| 2 | 言語・ランタイム | TypeScript / Cloudflare Workers (V8) |
| 3 | DO の粒度 | 1 DO / pool / UTC 日（例: `quota:STANDARD:2026-08-09`） |
| 4 | Worker → AI Gateway 接続 | AI Gateway REST API 経由 |
| 5 | クライアント認証 | `Authorization: Bearer octg_sk_*`。Admin API は Cloudflare Access で二重防御 |
| 6 | Tool-use 判定 | `tools` / `tool_choice` 等が存在する場合は `client_policies.tools_mode` で制御。デフォルトは `REJECT` |
| 7 | リポジトリ構成 | シンプルモノレポ（`apps/gateway-worker`, `durable-objects`, `packages/shared`） |
| 8 | テスト基盤 | Vitest + Miniflare（DO 含む） |

## 3. アーキテクチャ概要

```text
Client (OpenCode / AI Agent / MCP / Apps)
        │  Authorization: Bearer octg_sk_*
        ▼
Cloudflare Worker (OpenAI 互換 API)
        │  認証 → ポリシー解決 → モデル分類 → Tool-use 判定
        │  → QuotaController state 読み出し
        ▼
Durable Object: TokenizerController (exact o200k_base BPE)
        │  固定 ID tokenizer:primary への 1 回の RPC
        ▼
Cloudflare Worker
        │  token budget 算術 → reservation 要求
        ▼
Durable Object: QuotaController (pool × UTC 日)
        │  reserve / settle / markUncertain（単一スレッドで直列化）
        ▼ (permit 後のみ)
Cloudflare AI Gateway (REST)
        │  BYOK + Secrets Store / metadata / cache (opt-in) / Spend Limit (二次防御)
        ▼
OpenAI API (Project A: shared-free, Data Sharing ON)

Worker ──非同期──► D1（監査・履歴・レジストリ・ポリシー・reconciliation）
Cron Trigger ──► Reconciliation（OpenAI Usage API との突合）
```

## 4. QuotaController（Durable Object）設計

### 4.1 インスタンス粒度

DO ID を `quota:{POOL}:{UTC日付}` とする（POOL は `STANDARD` / `MINI`）。

- Worker はリクエスト時点の UTC 日付から対象 DO を解決するため、日次リセットは Cron に依存せず構造的に保証される（要件第 15 章）。
- UTC 0 時境界の同時リクエストは旧日付 DO / 新日付 DO に自然に分かれ、state の混在が起きない（要件第 49 章「Midnight」テストに対応）。
- 過去日の DO はアイドル化して自然淘汰される（保持・削除運用は 4.5 を参照）。

### 4.2 状態

```typescript
interface PoolState {
  utcDay: string;
  limit: number;          // STANDARD=1_000_000 / MINI=10_000_000（設定外部化）
  confirmedTokens: number;
  reservedTokens: number;
  uncertainTokens: number;
  requestCount: number;
  updatedAt: string;
}
```

利用可能量：

```text
remaining = limit - confirmedTokens - reservedTokens - uncertainTokens
```

加えて冪等性と遅延処理のため、DO ストレージに `request_id -> RequestEntry` のマップを保持する。`settled: boolean` のような単一フラグではなく、以下の明示的な状態機械で管理する（要件第 14 章、第 36 章の fail-closed 契約を RPC 再送に対しても成立させるため）。

```typescript
type RequestState = 'reserved' | 'settled' | 'uncertain' | 'reconciled' | 'released';

interface RequestEntry {
  state: RequestState;
  reservedTokens: number;      // reserve 時点の予約量（不変）
  actualTokens?: number;       // settle 確定値
  result?: unknown;            // 各 RPC の最初の成功応答（再送時はカウンターを変更せずこの値を返す）
  createdAt: string;
  updatedAt: string;
}
```

状態遷移（単一スレッド下で直列化。遷移不能な組合せは no-op またはエラーで冪等に扱う）：

```text
(none) --reserve--> reserved --settle--> settled
reserved --markUncertain--> uncertain --settle--> settled  # 消費確定（後述）
uncertain --reconcile--> reconciled                        # confirmed へ確定
uncertain --reconcile--> released                          # 未消費が Usage API で裏付けられた場合のみ解放
reserved --reconcile--> reconciled                         # markUncertain 配送失敗後に Usage API で消費確定
reserved --reconcile--> released                           # markUncertain 配送失敗後に未消費を確認
reserved --release--> released                             # upstream 到達前と確定的に判明した場合のみ
```

### 4.3 RPC インターフェース（3 つのみ）

1. `reserve(requestId: string, tokens: number, upperBoundTokens: number, idempotencyKey?: string, clientId?: string) -> { ok, remaining, resetAt }`
   - 予約量が remaining 内に収まる場合のみ `reservedTokens += tokens`。
   - pool 利用ポリシー（要件第 28 章）に基づく NORMAL / CAUTION / STRICT 判定もここで行う。STRICT 帯では conservative upper bound（`upperBoundTokens`）が remaining 以下の場合のみ許可。
   - 冪等性: 同一 `requestId` と同一 `idempotencyKey` の再送は、entry の状態にかかわらずカウンターを再変更せず、保存済みの最初の reserve 結果を返す。`idempotencyKey` が指定された場合は client × pool × UTC day 単位で重複排除し、異なる `requestId` に紐づく既存 entry（`reserved`・`uncertain`・`settled`・`reconciled`）の再送は `duplicate_idempotency_key` 理由で拒否する。`released` entry の key は新しい予約として再利用できる。Idempotency-Key の空文字・未指定は absent として扱い、指定値は UTF-8 255 bytes 以下に制限する。異なる requestId の重複再送は保存済み upstream response を再生せず、常に `409 Conflict` とする。`ok=false`（容量不足等）で失敗した reserve は状態を残さず、再送は新規として評価する。
   - `idempotencyKey` と `clientId` はいずれも任意の `string`。Worker は認証済みクライアントの `auth.id` を `clientId` として導出して渡す。Worker の受信境界では、未指定・`null`・空文字を absent（新規リクエスト）として扱い、非空の有効なキーは trim・大小文字変換などの正規化をせず、そのまま reserve に渡す。255 UTF-8 bytes を超えるキーは reserve や upstream の前に拒否する。Worker が常に `clientId` を渡すため、通常の重複排除範囲は client × pool × UTC day となる。
2. `settle(requestId, actualTokens) -> { ok }`
   - `reserved` から: `reservedTokens -= reserved`, `confirmedTokens += actual`, 状態を `settled` へ。
   - `uncertain` から（Usage API 確定より先に上流 usage が届いた遅延 settle）: `uncertainTokens -= reserved`, `confirmedTokens += actual`, 状態を `settled` へ。**予約量の二重減算はしない**（減算対象は遷移元バケットのみ）。
   - 既に `settled` / `reconciled` / `released` の場合は保存済み結果を返す no-op（二重精算防止、要件第 49 章）。
   - **超過精算（fail-closed）**: `actual > reserved` の場合でも超過分は `confirmedTokens` に正差分として計上する（課金は既に発生しており、カウントから落とす方が危険なため）。超過分を別途「債務」予約として扱う設計は採らない。代わりに、settle 後に `confirmedTokens + reservedTokens + uncertainTokens > limit` であれば、当該 DO（= 当日当該 pool）への以後の `reserve` を全て拒否し、超過額を `requests` / 観測メトリクス（要件第 40 章の `settlement overage`）へ記録する。実装上は `reservedTokens` が負にならないよう `max(0, …)` で防御し、負に遷移させない。
3. `markUncertain(requestId) -> { ok }`
   - 結果不明リクエストを `reserved -> uncertain` へ移動（`reservedTokens -= reserved`, `uncertainTokens += reserved`）。TTL では自動解放しない（要件第 14 章、第 36 章）。
   - 冪等性: 既に `uncertain` の場合は no-op。既に `settled` の場合は、両者が同一の最終 usage を知っているなら保存済み結果を返して no-op とし、異なる usage を主張する競合のみ監査記録のうえ既存状態（`settled`）を維持する。`released` / `reconciled` からの遷移は不可（no-op + 監査）。

いずれの RPC も「同一 requestId の再送では保存済みの元の結果を返し、カウンターを再変更しない」を共通契約とする。

### 4.4 ストレージ

SQLite-backed Durable Object Storage を使用し、read-modify-write をトランザクション内で実行する。DO の単一スレッド実行モデルにより、同一 pool への同時 reservation は構造的に直列化され、oversubscription は発生しない（要件第 42 章 Concurrency）。

### 4.5 過去日 DO のライフサイクル

過去日 DO はアイドル化による自然淘汰に任せず、以下の保持・削除ポリシーで管理する。

- **保持期間**: 当該 UTC 日の翌々日 00:00 UTC まで、request_id マップと `reserved` / `uncertain` 状態を永続化して保持する。これは Usage API の集計遅延（最大 ~24 時間を想定）と 1 回の reconciliation リトライを吸収するための最低保証であり、`D1 reconciliations` で当該日・pool の突合が完了（`reserved` / `uncertain` 件数 0）ステータスになった場合は、この期限を待たず早期に削除してよい。
- **削除手順**: Worker / Cron から当該 DO の `finalizeDay()` を呼び、(1) `reserved` / `uncertain` 状態が 0 件であることを確認 → (2) `deleteAll()` で request_id マップと PoolState を消去 → (3) D1 `utc_day × pool` に `deleted` を記録、の順で冪等に実行する。`reserved` または `uncertain` が残っている DO は `deleteAll()` してはならない。
- **削除後の遅延 settle**: 削除済み requestId に対する遅延 `settle` は、当該 DO が存在しないため受理不能となる。日次リセット後の pool は新しい DO に切り替わっているため課金の二重計上リスクはなく、worker は当該 settle を破棄し、D1 `requests.status = 'orphaned'` として記録したうえで成功（no-op）として扱う。**新しい日の quota を過去のリクエストで消費してはならない**。
- **reconciliation の再実行**: reconcile RPC は、`no_state`（削除済み）を「0 トークン」として冪等に扱う。削除後の再 reconcile は前回結果（D1 `reconciliations`）を返して no-op とし、過去日 quota を再変更しない。

## 5. Worker 処理設計

### 5.1 認証

- `Authorization: Bearer octg_sk_*` を検証。D1 `clients.key_hash`（keyed hash）と照合。
- 不一致は `401`。OpenAI API キーはクライアントに一切配布しない（要件第 24 章、第 38 章）。

### 5.2 ポリシー解決とモデル分類

- D1 `client_policies` / `model_registry` を Worker 内で短時間キャッシュ。DB を正とし、設定変更は DB 更新のみで反映する（要件第 44 章）。
- `requested_model` を STANDARD / MINI / NONE に分類。不明モデルは `complimentary = NONE`（Unknown = Paid、要件第 4 章）。MVP デフォルトポリシーは REJECT（要件第 27 章）。

### 5.3 Tool-use 判定

`tools` / `tool_choice` / built-in tool 設定が存在するリクエストは、クライアントポリシーの `tools_mode` に基づいて制御される。`tools_mode` は `"REJECT"`（MVP デフォルト）または `"ALLOW"`。

- `"REJECT"`: 無料枠 reservation を行わず、`model_not_allowed` で拒否（要件第 17 章、エラー契約は 5.7）。
- `"ALLOW"`: 既存の quota reservation / settlement フローへ進み、実 usage で精算する。

Admin API (`PUT /admin/clients/:id/policy`) で `tools_mode` を変更できる。PUT リクエストの `tools_mode` が未設定または `"REJECT"` / `"ALLOW"` 以外の無効な値の場合、HTTP 400 (`invalid_request`) で拒否する。DB から読み出したポリシーの `tools_mode` が未設定または無効な値の場合、実行時ポリシーは `"REJECT"` にフォールバックする。

### 5.4 トークン推定

要件第 11 章の二段階方式を、Gateway Worker と TokenizerController の責務に分けて実行する。

- Worker は入力を正規化し、`inputText`、`opaqueInputBytes`、`messageCount` を作る。`/v1/chat/completions` の `max_completion_tokens` は内部の `max_output_tokens` へ変換する。互換入力 `max_tokens` も同様に変換する。`max_tokens` と `max_completion_tokens` の両方が指定された場合は `max_completion_tokens` を優先し、**値が異なる場合は `invalid_request`（400, `param: "max_tokens"`）で拒否**して予約へ進まない。
- `MAX_INPUT_BYTES` は raw body と正規化済み入力に共通して適用する上限である。未設定・不正値時の既定値、および現行 deployment の値はともに 1,048,576 bytes（1 MiB）とする。解決値は `MAX_INPUT_TEXT_BYTES`（16 MiB - 65,536 bytes）を超えず、raw body は JSON parse 前に、正規化済み入力は Tokenizer RPC 前に検査する。超過時は HTTP 413 とし、reservation、in-flight admission、upstream を実行しない。
- `quota_get_state` の後、Worker は `TokenizerController` Durable Object を固定 ID `tokenizer:primary` で 1 回だけ RPC 呼び出しする。TokenizerController は同梱 WASM を使う `tiktoken/lite` で `o200k_base` の exact BPE を実行し、次の式で最終的な推定入力 token 数を返す：

  ```text
  base = o200k_base.encode(inputText).length
  estimated_input = base + opaqueInputBytes + (messageCount * 4) + 3
  ```

- TokenizerController の encoder 初期化または encode が通常の `Error` で失敗した場合だけ、同じ DO 内の conservative bytes path（UTF-8 byte 数を base とする）へ切り替える。算術異常、malformed RPC result、RPC failure、入力上限超過は fallback として扱わず fail-closed とする。Gateway Worker と `packages/shared` は BPE encoder を import しない。
- TokenizerController は RPC 専用であり、`ctx.storage` を使用せず、入力本文・Authorization・API key・tokenizer state を保存しない。`MAX_INPUT_TEXT_BYTES = 16 * 1024 * 1024 - 65_536`、`MAX_REQUEST_ID_BYTES` は 256 bytes、Worker 側の RPC preflight ceiling は 32 MiB とする。`inputText` の UTF-8 byte 数は `MAX_INPUT_TEXT_BYTES - 1` と `MAX_INPUT_TEXT_BYTES` を受け入れ、`MAX_INPUT_TEXT_BYTES + 1` を拒否する。
- 安全マージン（プール残量率で段階化）:
  - `remaining > 20%` : `max(256, estimatedInput * 0.02)`
  - `remaining <= 20%`: `max(512, estimatedInput * 0.05)`
  - `remaining <= 5%` : strict モード（要件第 28 章）
- 予約量 = `estimated_input + max_output_tokens + safety_margin`。
- **max_output_tokens の既定値と上流フィールド**: クライアントが max output を指定しない場合、`DEFAULT_MAX_OUTPUT_TOKENS = 4096` を既定値として適用する。`/v1/chat/completions` では内部値を上流の `max_completion_tokens` として、`/v1/responses` では上流の `max_output_tokens` として必ず注入する（未指定 = 実質無制限の出力は reservation 不可能なため、MVP では fail-closed 側に倒す）。予約値に使用する `max_output_tokens` と上流へ送信する出力上限値は、既定値および CLAMP 適用後を含め、両 endpoint で一致させる。テストでは両 endpoint についてこの一致と endpoint 固有のフィールド名を検証する。
- **非テキスト入力の扱い（MVP）**: `/v1/responses` および `/v1/chat/completions` の予約処理で `input_image`・`input_audio` など非テキストのモダリティを検出した場合、tokenizer 推定が成立しないため**予約前に明示的に拒否**する（エラー契約は 5.7 の `invalid_request` を使用）。将来対応としてモダリティ別の保守的上限を `estimated_input` へ加算する方式を採る場合は、モダリティごとの上限表を本書に追加し、過少計上を防ぐ。
- **Responses のテキスト・ツール履歴（OpenCode互換）**: `/v1/responses` は `input` の message item（`type` 省略または `message`）について、user/system/developer の `input_text` または汎用 `text`、assistant の `output_text` または汎用 `text` を受理する。`function_call` の `call_id`・`name`・`arguments`、`function_call_output` の `call_id`・文字列または `input_text` / `text` 配列の `output`、および reasoning の `summary_text` 配列と `encrypted_content` を受理する。これらの prompt-bearing な可視文字列は input token 推定へ含め、encrypted reasoning state は `opaqueInputBytes` として UTF-8 byte 数を保守的に加算する。複数 reasoning item の opaque bytes は合算する。
- **Responses の upstream wire normalization**: 受理した汎用 `text` content part は
  Gateway B へ転送する前に role 別の wire type へ正規化する。user/system/developer
  message は `input_text`、assistant message は `output_text`、
  `function_call_output.output` は `input_text` とする。したがって Gateway B へ
  generic `text` をそのまま送らず、token estimation と upstream body が同じ意味の
  入力を扱う。既知の unsupported nested part は従来どおり予約前に HTTP 400 で拒否する。
- **Responses の参照状態**: `item_reference`、`previous_response_id`、`conversation`、未知の top-level item、未知または不正な nested part は、参照先を取得して token 推定できないため、予約前に HTTP 400 (`invalid_request`, `param: null`) で拒否する。BYOK/OpenCode 側は `store: false` と必要履歴の再送を使用する。

### 5.5 Output 制御（要件第 12 章）

`推定 input + 要求 output + margin` が remaining を超える場合、ClientPolicy の `outputLimitMode` に従う：
  - Wire field `client_policies.output_limit_mode` は読み出し時に内部型 `ClientPolicy.outputLimitMode`（`"REJECT"` | `"CLAMP"`）へ変換される。
  - `PUT /admin/clients/:id/policy` で書き込まれた値は、上記内部型に正規化されて D1 `client_policies.output_limit_mode` に保存される。Admin API からの未設定または無効な値は HTTP 400 (`invalid_request`) で拒否する。D1 から読み出したポリシーの `output_limit_mode` が未設定または無効な値の場合、実行時ポリシーは `"REJECT"` にフォールバックする。
  - `tools_mode` についても同様に `"REJECT"` / `"ALLOW"` に正規化される。Admin API からの未設定または無効な値は HTTP 400 (`invalid_request`) で拒否する。D1 から読み出したポリシーの `tools_mode` が未設定または無効な値の場合、実行時ポリシーは `"REJECT"` にフォールバックする。
  - enforcement 時には `ClientPolicy.outputLimitMode` を `decideOutput` に渡し、以下の分岐で適用する。

- `REJECT`（デフォルト）: `429`（`complimentary_quota_exceeded`）で拒否。
- `CLAMP`（opt-in）: `candidate = remaining - estimated_input - safety_margin` を計算し、
  - `candidate > 0` の場合のみ `max_output_tokens = candidate` まで縮小して実行する（予約量が正であることを保証）。
  - `candidate <= 0` の場合は CLAMP せず `REJECT` と同じ `429`（`complimentary_quota_exceeded`）で拒否する。`max_output_tokens` が 0 または負のリクエストを上流へ送らない。

### 5.6 Reservation → 上流転送 → Settlement

1. `quota_get_state` の後に TokenizerController RPC を実行する。outcome は次のとおりである。
   - `work_limit`（BPE work limit 超過）は HTTP `413`、`invalid_request_error` / `request_too_large`、route `reject:request_too_large` とする。
   - `unavailable`（RPC failure、malformed result、RPC preflight ceiling 超過、Tokenizer RPC 境界での `MAX_INPUT_TEXT_BYTES` 超過）は HTTP `500`、`api_error` / `internal_error`、route `error:internal_error` とする。
   - Worker の HTTP 正規化で解決済み入力上限（`MAX_INPUT_TEXT_BYTES` 以下）を超過した場合は Tokenizer RPC より前に HTTP `413`、`invalid_request_error` / `request_too_large`、route `reject:request_too_large` とする。これは RPC unavailable とは別の入力拒否である。
   - token budget の `arithmetic_error` は HTTP `500`、`api_error` / `internal_error` とする。公開 HTTP route は `error:internal_error`、resource stage event の route は `error:arithmetic_error` とする。
   - 上記の全 outcome では `QuotaController.reserve`、in-flight admission、AI Gateway REST を呼び出さない。
2. `QuotaController.reserve(requestId: string, tokens: number, upperBoundTokens: number, idempotencyKey?: string, clientId?: string)` 成功後にのみ AI Gateway REST へ転送する（BYOK、Project A「shared-free」向け。認証は 7.1）。Worker は認証済みクライアントの `auth.id` を `clientId` として渡す。
   - Worker は有効な非空の受信 `Idempotency-Key` を `QuotaController.reserve()` および Gateway B への upstream 呼び出しへ、trim・大小文字変換なしで変更せず転送する。空文字・未指定は absent としてヘッダーを転送せず、新規リクエストとして扱う。255 UTF-8 bytes を超える値は reserve や upstream の前に HTTP 400 で拒否する。
   - 同一 key に対する再送は client × pool × UTC day 単位で Durable Object 内で重複排除され、同じ requestId の再送だけは保存済み reserve 結果を再返却する。異なる requestId による既存 entry への再送は、完了済み key を含めて `409 Conflict` で拒否する。
3. `reserve` 成功後、upstream 呼び出し前に pool 単位の in-flight lease を取得する。
   `MAX_IN_FLIGHT_REQUESTS` は未設定・不正値時に 2 を既定とし、現行 deployment も 2 とする。
   上限到達時は reservation を release して HTTP 429 `worker_concurrency_exceeded`
   （route `reject:worker_concurrency`）を返し、upstream へ到達しない。lease は generation
   と有効期限を持ち、release と renewal は両方が一致する場合だけ有効とする。SSE 中継では
   lease を定期更新し、`stale_generation` または `lease_not_found` を含む更新失敗時は
   stream を abort し、`markUncertain` と `releaseInFlight` を各1回だけ実行して `settle` は
   実行せず、fail-closed の精算経路へ進む。
4. 上流へ送出する際は、AI Gateway の request handling ヘッダーを以下の既定値で付与する。OCTG の Worker outbound は単一試行とし、隠れた再試行による usage の二重計上を防ぐ：
   - `cf-aig-request-timeout: 25000`（本リクエストの単一試行タイムアウト。ストリーミングは最初のチャンク受信までをタイムアウト判定とする AI Gateway 側の仕様に従う）
   - `cf-aig-max-attempts: 1`（Worker が固定して付与し、受信クライアントの同名ヘッダーは転送しない）
   - `cf-aig-collect-log-payload: false`
   - `Idempotency-Key` は受信値を変更せず、valid な場合のみ転送する。自動 retry は行わず、クライアント切断・usage 取得不能・upstream 通信失敗は `markUncertain` とする。
5. レスポンス / ストリームから最終 usage を抽出して `settle(request_id, actual)`。
6. 失敗・クライアント切断・usage 取得不能なら `markUncertain(request_id)`。**設定した全 attempt を使い切った後、または usage を信頼して取得できない場合は必ず `markUncertain`** とする。upstream が HTTP 4xx を返した場合も、上流で token 使用がなかったことを保証できない限り `markUncertain` とする。`release`（予約解放）は、AI Gateway への送信前エラー（例: request 構築失敗、認証前エラー）など、upstream 到達前と確定的に判明する場合に限る（要件第 36 章）。AI Gateway の最終 attempt は完了まで待機する挙動のため、タイムアウト後の成否は不確実として `uncertain` 側に倒す。`markUncertain` の配送に失敗した `reserved` entry は、後続 reconciliation が `consumed` / `unused` の証跡で解決できる状態として保持する。
7. streaming 中継でも reserve → SSE pass-through → final usage → settle の順序を維持する（要件第 13 章）。
8. settle の対象 DO は **reserve 時点の UTC 日**から解決する（settle 時に現在日付から再解決しない。UTC 0 時跨ぎのロングリクエストで quota を誤計上しないため）。

### 5.7 レスポンスとエラー

- 要件第 29 章の `X-OCTG-*` ヘッダを付加（pool, limit, used, remaining, reset, route, request-id）。エラー応答にも同じヘッダを付すが、**pool が確定する前のエラー**（401 認証エラー、および 5.2 のモデル分類で STANDARD / MINI に分類されず pool が確定しなかった 403 モデル不許可・400 バリデーションエラー等）では pool 系ヘッダ（pool, limit, used, remaining, reset, route）は付与せず、`X-OCTG-Request-Id` のみを返す。一方、pool 確定後のエラー（429 無料枠不足・413 リクエスト過大など quota 判定に至ったもの）では pool 系ヘッダを全て付与し、`X-OCTG-Quota-Used` は pool 全体の confirmed+reserved+uncertain とする。
- エラーコード（要件第 37 章。OpenAI SDK 互換の `{ error: { message, type, param, code } }` 形式に統一し、`request_id` は応答 body トップレベルに付与）：

| 状況 | HTTP | `error.message` | `error.type` / `error.code` | `param` | pool 系ヘッダ | 補足 |
|------|------|-------------------|------------------------------|---------|----------------|------|
| 無料枠不足 | `429` | `Complimentary quota exceeded for pool '{pool}'.` | `complimentary_quota_exceeded` / `insufficient_quota` | `null` | 付与 | 予約量が当日の `remaining` を超えるが、pool の `limit` 以下の場合。`error` 内に `pool` / `remaining_tokens` / `reset_at` を含める。 |
| リクエスト過大（`work_limit` / upper bound） | `413` | `Request exceeds the complimentary quota limit for pool '{pool}'.` | `invalid_request_error` / `request_too_large` | `null` | 付与 | TokenizerController の `work_limit`、または conservative upper bound が pool の `limit` 自体を超える場合。`remaining` 不足（limit 以下）は 429 とする。 |
| 入力本文上限超過（Worker 正規化） | `413` | `Request exceeds the configured input size limit.` | `invalid_request_error` / `request_too_large` | `null` | 付与しない | `inputText` / normalized input が Worker の解決済み上限（最大 `MAX_INPUT_TEXT_BYTES`）を超えた場合。Tokenizer RPC、reservation、in-flight、upstream の前に拒否する。 |
| モデル不許可 | `403` | `The requested model is not allowed for this client.` | `invalid_request_error` / `model_not_allowed` | `model` | pool 確定時のみ付与 | `tools` / `tool_choice` 等の PAID_ONLY リクエストを含む。pool を分類できない場合は `X-OCTG-Request-Id` のみ付与する。 |
| 不明モデルで paid 必須 | `403` | `The requested model requires paid mode, which is not enabled.` | `invalid_request_error` / `model_requires_paid` | `model` | 付与しない | `complimentary=NONE` で、paid mode が許可されていない場合。 |
| 非テキスト入力（MVP 未対応） | `400` | `Non-text input is not supported in the MVP.` | `invalid_request_error` / `invalid_request` | `input` | 付与しない | 5.4 の予約前拒否。 |
| `max_tokens` / `max_completion_tokens` 衝突 | `400` | `max_tokens and max_completion_tokens must match when both are provided.` | `invalid_request_error` / `invalid_request` | `max_tokens` | 付与しない | 5.4 の正規化規則。 |
| Tokenizer RPC unavailable | `500` | `An internal error occurred.` | `api_error` / `internal_error` | `null` | pool 確定後に付与 | RPC failure、malformed result、RPC preflight ceiling 超過、Tokenizer RPC 境界の `MAX_INPUT_TEXT_BYTES` 超過。reservation・in-flight・upstream は実行しない。 |
| Token budget 算術異常 | `500` | `An internal error occurred.` | `api_error` / `internal_error` | `null` | pool 確定後に付与 | 公開 HTTP route は `error:internal_error`、resource stage event の route は `error:arithmetic_error`。reservation・in-flight・upstream は実行しない。 |

- **エラー body の共通契約**: `message`、`type`、`param`、`code` は必須キーとし、`param` が対象外の場合も `null` を返す。`message` は上表の固定値を使用する。テスト・クライアントロジックは原則として `message` ではなく `error.type` / `error.code` / HTTP status を参照するが、固定値はログ・互換性確認用の契約として扱う。
- **pool 系ヘッダの値**: pool が確定したエラーでは、`X-OCTG-Pool` は小文字の `standard` / `mini`、`X-OCTG-Quota-Limit` は対象 DO の `limit`、`X-OCTG-Quota-Used` は `confirmedTokens + reservedTokens + uncertainTokens`、`X-OCTG-Quota-Remaining` は DO が返す `remaining`、`X-OCTG-Quota-Reset` は次の UTC 00:00 の RFC 3339 timestamp とする。`X-OCTG-Request-Id` は body の `request_id` と同一値にする。
- **エラー別 route**: `429` は `reject:complimentary_quota`、`413` は `reject:request_too_large`、Tokenizer RPC unavailable は `error:internal_error`、pool が確定した `403 model_not_allowed` は `reject:model_not_allowed` とする。算術異常は公開 HTTP route が `error:internal_error`、resource stage event が `error:arithmetic_error` である。pool が確定しないエラーでは `X-OCTG-Route` を含む pool 系ヘッダを付与しない。

4 条件の canonical response は以下のとおりとする（`request_id`、pool の残量、reset 時刻、ヘッダ値はリクエストごとの実値に置換する）。

```json
{
  "error": {
    "message": "Complimentary quota exceeded for pool 'standard'.",
    "type": "complimentary_quota_exceeded",
    "param": null,
    "code": "insufficient_quota",
    "pool": "standard",
    "remaining_tokens": 12500,
    "reset_at": "2026-08-10T00:00:00Z"
  },
  "request_id": "req_01J4ZK8M2E5KQ0W0A2N1F9P3B2"
}
```

```json
{
  "error": {
    "message": "Request exceeds the complimentary quota limit for pool 'standard'.",
    "type": "invalid_request_error",
    "param": null,
    "code": "request_too_large"
  },
  "request_id": "req_01J4ZK8M2E5KQ0W0A2N1F9P3C3"
}
```

```json
{
  "error": {
    "message": "The requested model is not allowed for this client.",
    "type": "invalid_request_error",
    "param": "model",
    "code": "model_not_allowed"
  },
  "request_id": "req_01J4ZK8M2E5KQ0W0A2N1F9P3D4"
}
```

```json
{
  "error": {
    "message": "The requested model requires paid mode, which is not enabled.",
    "type": "invalid_request_error",
    "param": "model",
    "code": "model_requires_paid"
  },
  "request_id": "req_01J4ZK8M2E5KQ0W0A2N1F9P3E5"
}
```

> **要件第 37 章との差分メモ**: 要件の例は `error.type` に具体的コードを置く形式で示しているが、本設計では OpenAI SDK のコード分類体系（`type` = 理由コード、`code` = カテゴリ）に統一した。要件どおり「SDK 互換性を考慮した最終決定」の結論である。要件が候補として示した `413 / 422` は `413`、`402 / 403` は `403` を採用する。

- いずれのエラーでも `request_id` を応答 body トップレベルと `X-OCTG-Request-Id` ヘッダに含める。pool 確定後のエラー応答では、加えて上記の pool 系 `X-OCTG-*` ヘッダを付与する。エラー body の `pool` / `remaining_tokens` / `reset_at` は 429 のみ必須とし、それぞれ `X-OCTG-Pool` / `X-OCTG-Quota-Remaining` / `X-OCTG-Quota-Reset` と同じ値にする。
- 監査ログの D1 への非同期書き込みは `ctx.waitUntil()` を用いた fire-and-forget とし、レスポンスレイテンシ目標 p50 < 50ms / p95 < 150ms（要件第 42 章）を阻害しない。**配送保証は best-effort とし、Worker 障害・同時実行制限超過時の監査ログ欠損を許容範囲として明示する**。authoritative な制御は DO が担い、監査は証跡用途に限定する（クォータ判定・課金制御を監査ログ到達に依存させない）。完全な配送保証が必要になった場合は、Cloudflare Queues 等の永続配送経路＋コンシューマでの重複排除（request_id 単位の idempotent upsert）への移行を、要件42章レイテンシ目標の再交渉とセットの設計判断として扱う。

## 6. データ永続化（D1）

D1 は authoritative quota には使用しない（要件第 32 章）。概念スキーマは要件第 33 章に準拠：

- `clients` — id, name, key_hash, enabled, created_at
- `client_policies` — client_id, overflow_mode, output_limit_mode, max_paid_usd_day, cache_enabled, tools_mode
- `model_registry` — model, provider, complimentary_pool, enabled, fallback_model, updated_at
- `requests` — request_id, utc_day, client_id, requested_model, upstream_model, pool, eligibility, reserved_tokens, input/output/total_tokens, status, billing_class, openai_request_id, started_at, completed_at
- `daily_usage` — utc_day, pool, confirmed_tokens, paid_tokens, request_count
- `reconciliations` — utc_day, pool, local_tokens, openai_tokens, difference, executed_at

request body / prompt / response content は D1 に保存しない（要件第 38 章）。

## 7. AI Gateway 連携

- OpenAI BYOK + Secrets Store。AI Gateway は quota の authoritative source としない（要件第 19 章）。

### 7.1 認証と Secret 管理

Worker → AI Gateway および管理系 API の認証は endpoint ごとに専用 Secret を使い分け、`octg_sk_*`（クライアント認証用）や BYOK 保管の OpenAI キーを流用しない。

| 用途 / endpoint | 認証方式 | 専用 Secret | 最小権限 |
|---|---|---|---|
| AI Gateway REST API（`api.cloudflare.com/client/v4/accounts/{id}/ai/v1`） | `Authorization: Bearer <token>` | Cloudflare API token（例: `CLOUDFLARE_AIG_API_TOKEN`）を Workers Secrets に保管 | `AI Gateway Run`（Read を付可、Edit は付与しない） |
| AI Gateway provider-native endpoint（`gateway.ai.cloudflare.com`） | `cf-aig-authorization` ヘッダー | 専用 Secret として分離保管（REST 用と共有しない） | `AI Gateway Run` |
| OpenAI provider キー | AI Gateway BYOK | AI Gateway Secrets Store へ保管（OCTG は値を保持しない。要件第 38 章） | OpenAI 側の project スコープ最小権限 |
| OpenAI Organization Usage API（reconciliation 用） | `Authorization: Bearer <admin key>` | 専用 Secret（例: `OPENAI_USAGE_API_KEY`）を Workers Secrets に保管 | Usage 読み取り用途 |
| `api.cloudflare.com` のその他管理 REST（Spend Limit 確認等） | `Authorization: Bearer <token>` | 上記 AIG token とは別の管理用 token（例: `CLOUDFLARE_MGMT_API_TOKEN`） | 必要な account/gateway read のみ |

ローテーション手順: 各 Secret は (1) 新規トークン発行 → (2) `wrangler secret put` で設定 → (3) デプロイ / 動作確認 → (4) 旧トークン失効、の順で実施する。Worker コード・ログ・`octg_sk_*` の鍵素材にこれらの値を含めない。

BYOK で Secrets Store に保管した OpenAI キーは、AI Gateway によるプロバイダー向け認証だけに使用され、他の認証用途へは転用しない。

- Custom metadata 5 項目を標準付与: `client_id, pool, eligibility, route, request_id`（要件第 23 章。観測・ログ用途に限定し、キャッシュ分離キーや制御ロジックの根拠にはしない）。
- Spend Limit は二次防御（eventually consistent なため authoritative ではない。要件第 20 章）。
- Cache は opt-in。tool 使用・user-specific・session-specific・privacy 敏感リクエストは原則無効。cache key の誤共有を防止する（要件第 41 章）。**キャッシュ分離の根拠として、観測用途のカスタムメタデータ（`cf-aig-metadata`）に依存しない**。有効化する場合は、worker が client / 明示的な session / ユーザーなどの分離単位から `cf-aig-cache-key` を生成して付与する。AI Gateway 既定のキャッシュキー（provider・endpoint・model・プロバイダー認証情報・request body）は、全クライアントが同一の共有 BYOK 経路を通る構成では client 境界を区別しないため、cross-client の誤共有防止にはカスタムキーが必須となる。`cache_enabled` が true のクライアントでも、安定した分離単位を導出できないリクエストでは `cf-aig-skip-cache: true`（またはカスタムキー未付与）としてキャッシュを無効化する。
- Custom cost による仮想 token meter（要件第 21 章）は任意機能。quota 判定には使用しない。

### 7.2 Custom Provider としての運用構成

OCTG 自体を Cloudflare AI Gateway の Custom Provider（Gateway A）として登録し、OCTG Worker から別の AI Gateway（Gateway B）を経由して OpenAI へ接続する構成をサポートする。

- 循環ルーティング防止のため、受信側（Gateway A）と送信側（Gateway B）で異なる AI Gateway インスタンスを使用する。
- Gateway A → Worker への送信時、`Authorization: Bearer octg_sk_*` ヘッダーが伝送される。
- Worker → Gateway B への送信時、`cf-aig-authorization: Bearer <Gateway B Run token>`
  ヘッダーを使用し、`cf-aig-collect-log-payload: false` で prompt / response の
  ログペイロードを保存しない。
- Production と Preview の Worker、D1、Durable Object、client/policy/model registry、
  監査・reconciliation state は分離する。Preview D1 の分離は upstream billing principal
  の分離を意味しない。billing principal を共有する場合は、Preview quota上限、Production
  配分、bounded coordination、監視、coordination障害時の fail-closed 条件を別途設定する。
- 詳細な設定手順は [docs/cloudflare-ai-gateway-custom-provider.md](./docs/cloudflare-ai-gateway-custom-provider.md) を参照。

## 8. Reconciliation

### 8.1 方式の決定

OpenAI Organization Usage API（および対応する project スコープの usage 集約）で得られるのは **project × モデル × 時刻帯の集約値**であり、OCTG 内部の `request_id` を直接突合できる粒度ではない。MVP では以下のどちらかの方式を運用として選択できるよう設計する：

- **方式 A（推奨・標準）**: route（`FREE_SHARED` / `PAID_SHARED`）ごとに OpenAI Project / API キーを分離する（要件第 18 章の Project A/B 分離）。これにより Usage API の project 単位集約と route が 1:1 で対応し、再現性のある突合が可能となる。Production と Preview の control-plane 分離とは別の軸であり、同じ FREE_SHARED billing principal を使う場合でも、Preview quota上限と bounded coordination を必須とする。
- **方式 B（許容・縮退運用）**: 単一 Project の集約突合に留める。ただし後述の不確実性ルールにより、`uncertain` は**個別に確定できない限り解放しない**（fail-closed 維持）。

### 8.2 実行スケジュールと UTC 境界

- Cron 実行は `05 0 * * *`（00:05 UTC = 09:05 JST。要件第 35 章の表現と一致）に加え、任意で 1 時間毎の補助実行を許可する。対象は **直前に完了した UTC 日**で、JST 表記に依存しない（UTC 日付の切替と独立に計算する）。
- Usage API の集計遅延を吸収するため、対象 UTC 日の範囲に加えて **後続 24 時間分を含む再取得（UTC 境界をまたいだ refetch）** を行い、最大 3 回までリトライ窓を設ける。
- Reconciliation 実行は **冪等**とし、同一 `utc_day × pool × route` への再実行では前回結果（D1 `reconciliations`）を返して再計上しない。DO 側の状態遷移も `settled` → `reconciled`、`uncertain` → `reconciled` / `released` への**単調（一方向）遷移**のみ許可する。後戻り遷移は不可とする。

### 8.3 uncertain の確定ポリシー（fail-closed）

- **解放の条件**: `released` への遷移は、該当 request が実際には無料枠で消費されていないことを Usage API 上で **request に相当する単位で肯定的に裏付けられる場合に限る**（方式 A で project/route 単位の集約が他の証拠と整合する場合の帰納的判断、または将来 OpenAI が request 粒度の usage を提供した場合）。**集約値の一致のみを根拠に uncertain を解放しない**（Usage API の遅延・欠損による見かけ上の一致を信じて解放することを防ぐ）。
- 裏付けが取れない `uncertain` は、4.5 の保持期限まで `uncertain` 状態を維持し、最終的に `reconciled`（confirmed 側）へ確定させて日次 quota を確定する。
- `FREE_SHARED` と `PAID_SHARED` は課金・データ共有ポリシーが異なるため、Usage 突合・`reconciliations` 記録ともに route 単位で分離して扱う。混合集約による見かけ上の整合に依存しない。
- `reserve` RPC の結果を確認できず `reserve_unknown` となった request は、集約 Usage API の差分から自動推論しない。Cloudflare Access で保護された `POST /admin/reconcile/:pool/:utcDay/:targetRequestId` で、canonical な QuotaController の `uncertain` かつ `reserve_unknown` entry だけを明示的に処理する。body は `{ "disposition": "consumed" | "unused", "evidence"?: string }` とし、`unused` には空白以外で 512 文字以下の evidence を必須とする。`consumed` は evidence を省略できる。同じ disposition の再送は冪等、異なる disposition または対象外 entry は変更せず 409、対象 request がない場合は 404 とする。

## 9. エンドポイント一覧（MVP）

```text
POST /v1/responses          # OpenAI 互換（予約・精算つき）
POST /v1/chat/completions   # OpenAI 互換（同上）
GET  /v1/models             # 互換 endpoint（registry から生成し client policy で絞る）
GET  /quota                 # pool 状態の可視化（要件第 30 章、認証は下記 9.1）
GET  /admin/quota           # 以下 Admin API（Cloudflare Access 必須、要件第 31 章）
GET  /admin/usage
GET  /admin/clients
GET  /admin/models
PUT  /admin/clients/:id/policy
PUT  /admin/models/:model
POST /admin/reconcile
POST /admin/reconcile/:pool/:utcDay/:targetRequestId
```

`/v1/embeddings`・`/v1/audio/*`・`/v1/images/*` は将来対応（要件第 25 章）。

### 9.1 GET /quota の認証・認可

`GET /quota` は **クライアントキー認証（`Authorization: Bearer octg_sk_*`）を必須**とし、Cloudflare Access は Admin API（`/admin/*`）に限定する（要件第 31 章との一貫性）。Cloudflare Access による二重防御は要件第 31 章で Admin API にのみ求められており、通常クライアントが credentialed に保持するアクセス経路を育てるため、本エンドポイントでは採らない。

- **返却スコープ**: STANDARD / MINI の**全クライアント共通 pool の集約値**（limit / confirmed / reserved / uncertain / remaining / usage_percent）を返す。クライアント個別の利用行跡（per-client の timestamps・model 内約・他クライアント存在の推測可能性）は含めない。per-client 可視化が必要になった場合は、pool 集約とは別の認可スコープ（例: 自分の `requests` 集約のみ）として別途設計する。
- **認可条件**: 有効な client key を持つこと（`clients.enabled = true`）。pool 状態は共有リソースの情報であり、特定クライアントの機密を含まないため、認証済みクライアントであれば参照を許可する。
- **エラー**: 未認証（missing/invalid key）は `401`（`authentication_error` / `invalid_api_key`）、認証済みだが無効化済みクライアントは `403`（`permission_error` / `client_disabled`）。これらの認可ケースを 12 章テスト戦略の必須テストに追加する。

### 9.2 Admin API の仕様と認証

- **認証方式**: `cf-access-jwt-assertion` ヘッダーによる Cloudflare Access JWT 検証（`verifyAccessJwt`）。Service Token 認証は廃止し、Access JWT 一本とする。JWT の検証要件は以下の通り：
  - ヘッダー `cf-access-jwt-assertion` が存在しない場合は `401` を返す。`Authorization: Bearer` は Admin API では使用しない。
  - 検証対象: `iss` は `ACCESS_TEAM_DOMAIN` と完全一致、`aud` は `ACCESS_AUD` と完全一致。いずれかが不一致の場合は `401`。
  - 署名検証: Cloudflare Access 標準の RS256 JWT とし、`ACCESS_JWT_PUBLIC_JWK` が設定されていればその JWK set を使用、未設定であれば `<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs` から JWKS を取得する。署名不正・ JWKS 取得失敗時は `401`。
  - 期限検証: `exp` は必須クレームとし、現在時刻を含まない未来の有効期限を要求する。`exp` 欠落・期限切れは `401`。
  - 上記いずれの検証失敗も共通して `401`（`authentication_error` / `invalid_api_key`）を返し、理由の詳細を応答 body に含めない（セキュリティ上の情報漏出防止）。
- **`GET /admin/clients`**: クライアント一覧に加え、`client_policies` テーブルからポリシー設定を取得。ポリシー未設定のクライアントにはデフォルト値（`overflow_mode: REJECT`, `output_limit_mode: REJECT`, `max_paid_usd_day: 0`, `cache_enabled: false`, `tools_mode: REJECT`）を適用した effective policy を返す。
- **`PUT /admin/clients/:id/policy`**: クライアントポリシーの作成・更新。
  - ボディ型: `{ overflow_mode: "REJECT" | "PAID_SHARED", output_limit_mode: "REJECT" | "CLAMP", max_paid_usd_day: number (>= 0), cache_enabled: boolean, tools_mode: "REJECT" | "ALLOW" }`
  - 無効な `tools_mode`（省略含む）または無効な値は HTTP 400 (`invalid_request`) で拒否する。

- **`PUT /admin/models/:model`**: モデルレジストリの作成・更新。
  - ボディ型: `{ complimentary_pool: "STANDARD" | "MINI" | "NONE", enabled: boolean, fallback_model: string | null }`
- **状態変更の Origin 検証**: 次の 4 endpoint は、`Origin` が存在する場合に
  request URL の origin と完全一致することを要求する。
  - `PUT /admin/clients/:id/policy`
  - `PUT /admin/models/:model`
  - `POST /admin/reconcile`
  - `POST /admin/reconcile/:pool/:utcDay/:targetRequestId`
  不一致は 403 `permission_error` / `origin_not_allowed` とし、mutation を実行しない。
  Origin がない有効な Access JWT request は、既存の管理 CLI との互換性のため許可する。
- **Admin Web UI（実装済み）**: Cloudflare Access で保護された `/admin/ui/*` を
  Worker-first の Workers Static Assets (`public/admin/ui/*`) として配信する。
  `/admin/ui` は `html_handling: "auto-trailing-slash"` により `/admin/ui/` へ正規化し、
  `/admin/ui/*` は `verifyAccessJwt()` 成功後にだけ `env.ASSETS.fetch(request)` へ渡す。
  `run_worker_first` は `/admin/*` に限定し、認証前の asset fallback は持たない。
  その他の `/admin/*` は既存 `handleAdmin` による JSON API として処理する。
  - Static Assets は `directory: "./public"`、`binding: "ASSETS"`、
    `not_found_handling: "none"` とする。HTML は `/admin/ui/app.js`、
    `/admin/ui/styles.css`、`/admin/ui/pico.min.css` を同一 origin から読み込む。
    Pico.css 2.1.1 は同梱し、外部 CDN は使用しない。
  - UI は Vanilla HTML/CSS/JavaScript の単一ページで、Quota / Usage / Clients /
    Models を表示する。Quota は STANDARD、MINI の固定順、Usage は `client_id` 昇順で
    表示する。Clients と Models はインライン編集し、保存成功後に該当 GET を再取得する。
    取得失敗は section 内の retry、保存失敗は入力値を保持した行内エラーで表示する。
  - Admin GET は `request_id` と `utc_day` を含む。Clients の policy payload は
    `overflow_mode`、`output_limit_mode`、`max_paid_usd_day`、`cache_enabled`、
    `tools_mode` の 5 フィールドを必須とする。

## 10. セキュリティとプライバシー

要件第 38-39 章に準拠：

- OpenAI キーは Secrets Store のみ。ソースコード・クライアントに保存・配布しない。
- Client API key は keyed hash で保存。
- Admin API は Cloudflare Access で分離保護。
- prompt / response content を独自ログ・D1 に保存しない。Usage metadata のみ永続化。
- AI Gateway Persistent Logs の運用（残すかどうか）は別途運用ポリシーとして決定する。
- Rate limiting、key rotation、audit trail を備える。
- route 分類: `FREE_SHARED` / `PAID_SHARED`（明示許可時のみ）/ `PAID_PRIVATE`（Data Sharing OFF の別 Project）。

## 11. 観測性（要件第 40 章）

- Global: STANDARD / MINI 利用率、requests/day、tokens/day、paid tokens、reject 数、uncertain tokens
- Client: requests、tokens、models、free/paid 比率
- Model: requests、input/output tokens、平均リクエストサイズ、quota 寄与
- Error: OpenAI 4xx/5xx、AI Gateway 障害、reservation / settlement 失敗、reconciliation 差異

## 12. テスト戦略

- 基盤: Vitest + Miniflare（Workers / DO / D1 をローカル再現）。
- 必須テスト（要件第 49 章）:
  - Quota 境界: `999,000 used + 2,000 reservation -> reject`、`950,000 used + 40,000 reservation -> permit`
  - Concurrent: `remaining=50k` で A/B が各 40k reserve -> 片方のみ permit
  - Settlement: `reserve 40k, actual 25k -> confirmed += 25k, reserved -= 40k`
  - Duplicate settlement: 同一 request の 2 回 settle は 1 回分のみ加算
  - Unknown model を Complimentary と判定しない
  - Tool-use リクエストを Complimentary Pool に入れない
  - Network failure: OpenAI 到達不明の reservation が消えない（uncertain 化）
  - Midnight: UTC 日替わり同時リクエストで前日/翌日 state が混在しない
  - reserve RPC 再送: 同一 `requestId` で再送した場合、最初の応答を返し `reservedTokens` を二重加算しない
  - settle 超過: `actual > reserved` の場合に `reservedTokens` が負とならず、pool 合計が limit を超過した場合は以後の reserve が拒否される
  - markUncertain 後の settle: `uncertain` からの settle では予約量の二重減算が発生しない
  - CLAMP 境界: `remaining <= estimated_input + safety_margin` の場合は CLAMP せず 429 で拒否され、`max_output_tokens <= 0` のリクエストが上流へ送出されない
  - 非テキスト入力: `input_image` / `input_audio` を含むリクエストが予約前に 400 で拒否される
  - GET /quota 認可: 未認証 401、無効化クライアント 403、認証済みクライアントは pool 集約のみ参照できること

## 13. ディレクトリ構成（モノレポ）

```text
octg/
├── apps/
│   └── gateway-worker/      # Worker エントリ、wrangler.jsonc
├── durable-objects/
│   └── quota-controller/    # QuotaController DO
├── packages/
│   └── shared/              # 型定義、モデル分類、推定ロジック等の共有コード
├── db/
│   ├── migrations/
│   └── schema.sql
├── config/                  # モデルレジストリ初期データ・デフォルトポリシー
└── tests/                   # quota / routing / streaming / integration
```

## 14. Acceptance Criteria 対応（要件第 50 章）

| AC | 実現手段 |
|----|---------|
| AC-01 base_url 変更のみで利用可 | OpenAI 互換 endpoint を Worker が提供 |
| AC-02 STANDARD/MINI 独立管理 | pool × 日の DO 分離 |
| AC-03 並列 request で quota 非超過 | DO 単一スレッド直列化 + reserve 前判定 |
| AC-04 actual usage で settlement | レスポンス usage 抽出 → settle RPC |
| AC-05 usage 不明は fail-closed | markUncertain + TTL 非解放 |
| AC-06 UTC 0 時で quota が切り替わる | DO ID に UTC 日付を含有 |
| AC-07 quota API | `GET /quota` |
| AC-08 超過時デフォルト non-call | REJECT デフォルト（要件第 27 章） |
| AC-09 Paid fallback は明示 opt-in | overflow_mode デフォルト REJECT |
| AC-10 OpenAI Key 非公開 | BYOK + Secrets Store、Client は octg_sk_* |
| AC-11 AI Gateway 観測 | custom metadata 5 項目 |
| AC-12 reconciliation | Cron + OpenAI Usage API 突合 |

## 15. 既知の限界

要件第 43 章の通り、課金 0 円の完全保証はしない。conservative reservation + fail-closed + OpenAI reconciliation の三重防御を採用する。

## 16. Worker リソース制限の観測と対策

Cloudflare Worker のリソース制限（CPU / memory / 並行負荷）による Error 1102 発生時に、原因確定前に恒久対策を導入しないための観測ゲートと、確認された原因に対応する最小限の対策を設計している。

### 16.0 実施済み CPU 対策（2026-09-04）

フリープランの 10ms CPU 制限による `exceededResources` が確認されたため、Cloudflare GraphQL API でインシデントを観測し、以下を特定・修正して本番デプロイ済み。

**確認された主要因**

| 原因 | 場所 | 影響 |
| --- | --- | --- |
| `crypto.subtle.importKey` を毎リクエスト実行 | `src/crypto.ts` | 認証ごとに重い非同期 crypto 操作が発生 |
| `normalizeChatCompletions` が `hasToolUse()` で全メッセージを 2 回走査 | `packages/shared/src/normalize.ts` | O(n messages) の二重スキャン |
| `normalizeChatCompletions` / `normalizeResponses` がフィールド列挙に一時配列を都度生成 | `packages/shared/src/normalize.ts` | GC 圧・一時 allocation |
| `finishResourceStage` で 14 個の `{}` spread を毎回生成 | `src/proxy.ts` | ステージ記録ごとの一時オブジェクト群 |
| SSE ストリームの全チャンクで `JSON.parse` | `src/stream.ts` | usage 無関係チャンクでの CPU 消費 |
| `new TextDecoder()` / `new TextEncoder()` を毎回生成 | `src/request-body.ts`、`src/crypto.ts` | per-request allocation |

**適用した修正**

1. `src/crypto.ts`: `importKey` 結果を pepper をキーに isolate スコープでキャッシュ（最重要）。`TextEncoder` をモジュールスコープ singleton に変更。hex encoding を tight loop に変更
2. `packages/shared/src/normalize.ts`: `isToolUse` 検出をメッセージループ内にインライン化し `hasToolUse()` の二重スキャンを廃止。フィールド null-check を直接 `if` 文に変更して一時配列を排除
3. `src/proxy.ts`: `finishResourceStage` の spread object 生成を直接 property 代入に変更
4. `src/stream.ts`: `"usage"` / `"response.completed"` を含まない SSE チャンクの `JSON.parse` をスキップ
5. `src/request-body.ts`: `TextDecoder` をモジュールスコープ singleton に変更
6. `src/stream.ts`: 巨大イベント（`response.completed` 等の全会話履歴を含む 1MB+ ペイロード）のフル `JSON.parse` を廃止し、`extractUsageFromEvent` による `"usage": {...}` ブロックのピンポイント抽出に変更。Responses API の `input_tokens` / `output_tokens` 監査記録に対応
7. `src/proxy.ts`: 非ストリーミング応答における `upstream.json()` + `JSON.stringify()` を廃止し、`rawText` を直接返却
8. `packages/shared/src/normalize.ts`: `utf8ByteLength` を追加し、`TextEncoder.encode(str).byteLength` による一時 TypedArray のヒープ確保を `Buffer.byteLength(str)` に置換

**結果**（version `80e50d58-f219-4ac3-84e6-b40bdebfe237`）

| メトリクス | 修正前 | 修正後 |
| --- | --- | --- |
| `exceededResources` | 多発（10ms cap 到達） | ゼロ |
| CPU P50 | 10ms（cap） | 2.7ms |
| CPU P90 | 10ms（cap） | 7.0ms |

`DENO_TOKENIZER_THRESHOLD_BYTES=1` により全トークン化を Deno Deploy へルーティングしており、BPE cutoff（§16.2）は適用していない。



### 16.1 観測ゲート

恒久対策を選ぶ前に、対象リクエストについて次を同じ request ID と revision に関連付ける。

- Worker deployment/version ID または commit SHA
- Workers プランと実効 `limits.cpu_ms` / memory limit
- raw body bytes、normalized input bytes、text bytes、opaque bytes
- exact BPE / conservative byte estimation の推定経路
- body read、parse、normalize、tokenize、Durable Object RPC、upstream の処理時間
- CPU time、wall time、invocation outcome
- canary 実行時の concurrency
- quota reserve の有無と upstream 到達有無

入力本文、tokenizer 対象文字列、認証素材は記録しない。D1 への監査書き込みは best-effort を維持し、書き込み失敗で quota 判定を変更しない。

対策の選択条件：

| 観測結果 | 適用候補 |
| --- | --- |
| `exceededCpu`、tokenize が主要因 | BPE cutoff と conservative byte estimation |
| `exceededMemory`、一時 allocation が主要因 | raw / normalized limit の分離 |
| 単発では成功し、並行時だけ失敗 | BPE 前 tokenization admission |
| 複数条件が確認された | 確認された分岐だけを組み合わせる |

### 16.2 CPU 対策（BPE cutoff）

CPU profiling で同期 BPE が主要因と確認された場合、normalized total bytes に対する `BPE_MAX_INPUT_BYTES` を導入する。

- `inputBytes < BPE_MAX_INPUT_BYTES` では、従来どおり `o200k_base` の exact BPE を使う。
- `inputBytes >= BPE_MAX_INPUT_BYTES` かつ hard limit 未満では、BPE を実行せず、`inputTextBytes` を text tokenizer token 数の保守的上限として使う。
- `opaqueInputBytes` と message overhead は一度だけ加算する。
- `inputBytes` は cutoff 判定に使えるが、byte-based 経路の text base としては使わない（Responses の `inputBytes` は opaque bytes を既に含むため）。

`BPE_MAX_INPUT_BYTES` は任意の固定値ではなく、入力サイズ別 CPU profile と concurrency 試験から決定する。

### 16.3 Memory 対策（raw / normalized limit の分離）

`exceededMemory` と memory profile が原因を示した場合、現在同じ値を共有している raw body と normalized input の上限を独立させる。

- raw body limit は body の読み取りと JSON parse 前の保護を担当する。
- normalized input limit は text と opaque data の正規化後サイズを保護する。
- 各 limit は同じ workload の memory profile と canary 結果から決定する。
- limit 超過は HTTP 413 `request_too_large` とし、reserve と upstream を実行しない。

加えて、request stream chunks、結合後 buffer、decoded string、JSON object、normalized text、encoded token 配列の生存期間を計測する。同時に保持する必要がない中間表現を早期に解放し、変更前後の peak allocation を比較する。

### 16.4 並行負荷対策（tokenization admission lease）

単発では成功し、複数リクエストが BPE へ同時進入した場合だけ失敗することが確認された場合、pool 単位の tokenization admission lease を追加する。

- model、policy、pool の解決後、BPE 前に lease を取得する。
- lease は quota reservation と別の state とし、取得・拒否で quota token を変更しない。
- lease state は少なくとも `{ requestId, leaseId, expiresAt }` を持ち、`leaseId` は acquire ごとに一意な値または単調増加する owner generation とする。
- 有効期限内に同じ `requestId` で再取得した場合だけ、同じ lease の保存済み結果を返す。
- release は `requestId` と取得時に返された `leaseId` / generation の両方が一致する場合だけ、期限確認と削除を同一 transaction 内で行う。
- Worker が Error 1102 で中断し解放処理を実行できない場合に備え、lease は期限を持つ。次回 acquire 時に期限切れ lease を除去する。
- TTL は受理する最大 payload の実測 BPE wall time より長く設定する。

admission を採用する場合は `MAX_TOKENIZATION_REQUESTS` と `TOKENIZATION_LEASE_TTL_MS` を導入する。production 値は単発の推測で決めず、受理する最大入力の tokenize wall time と concurrency profile から決定する。

tokenization admission の上限到達時は HTTP 429 `rate_limit_error`、code `tokenization_concurrency_exceeded`、route `reject:tokenization_concurrency` を返す。quota reserve と upstream 呼び出しは実行しない。

### 16.5 エラー契約（条件付き対策用）

| 条件 | HTTP / code | Quota | Upstream |
| --- | --- | --- | --- |
| raw / normalized hard limit 超過 | 413 / `request_too_large` | 予約しない | 到達しない |
| 未検証 payload 形状 | 400 / `invalid_request` | 予約しない | 到達しない |
| tokenization admission 飽和 | 429 / admission code | 予約しない | 到達しない |
| 推定処理の予期しない失敗 | 500 / `internal_error` | 予約しない | 到達しない |

### 16.6 解決判定

次の条件をすべて満たした場合だけ、インシデントを解決済みとする。

1. canary の deployment revision と実効 CPU / memory limit が記録されている。
2. 約 74,000-token 級の確認済み payload が想定 concurrency で成功する。
3. 対象 canary に `exceededCpu` と `exceededMemory` がない。
4. CPU time、wall time、memory profile が採用した limit 内に収まる。
5. 許可した全 payload 形状で、`estimatedInput + output.maxOutputTokens + margin` が upstream `usage.total_tokens` を下回らない。
6. 拒否経路で quota reserve と upstream 呼び出しが発生しない。
7. upstream 到達後の settle / uncertain / release 契約に回帰がない。
