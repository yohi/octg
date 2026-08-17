# Free Plan OpenCode Compaction 対応設計

## 背景

OCTG は OpenAI の Free クレジットを複数クライアントで共有するため、通常の推論リクエストと OpenCode の Compaction リクエストを同じ OCTG 経由で処理する。現在の `MAX_INPUT_BYTES=131072` は、OpenCode の system prompt、tool schema、会話履歴を含む payload を許容できず、通常リクエストだけでなく Compaction リクエストも 413 になる。その結果、Compaction が同じ経路で再試行される。

この上限は、`gpt-5.6-luna` の長時間 SSE を複数並行実行した際の Cloudflare Workers Error 1102 を抑える目的で導入された。しかし、Cloudflare Workers の request body platform limit と、Free プランの CPU / memory / 同時実行負荷は別の制約である。入力サイズ上限だけで Worker resource limit を防ぐ設計は、OpenCode と両立しない。

## 目的

1. OpenCode の通常リクエストと Compaction リクエストを OCTG 経由で成功させる。
2. OpenAI Free クレジットの quota reservation / settlement / audit を全リクエストで維持する。
3. Free プランの CPU 10ms・memory 128MB 環境で、長時間 SSE の過剰並行実行を抑える。
4. 入力超過による 413 と、Worker 過負荷による 429 を別の契約として扱う。
5. 413 の Compaction 再試行ループを作らない。

## 採用方針

### 1. 入力サイズ上限を引き上げる

`MAX_INPUT_BYTES` の既定値を 1 MiB（`1_048_576` bytes）へ引き上げ、wrangler の本番設定も同じ値にする。これは Cloudflare の request body 最大値ではなく、OCTG が tokenizer・JSON 正規化・upstream 送信を許可する運用上限である。

この値は固定的なモデル context limit として扱わず、実際の OpenCode payload の serialized size と Free プランの負荷試験で検証する。1 MiB を超えるリクエストは従来通り 413 とし、quota reservation と upstream 呼び出しを行わない。

### 2. 入力上限検査を body parse より前へ移す

`Content-Length` が存在し、上限を超える場合は `request.json()` より前に 413 を返す。`Content-Length` がない chunked request については、request body を上限付きで読み取り、上限超過時に parse・tokenizer・quota reservation を行わず 413 とする。これにより、入力上限が実際の Worker memory protection として機能する。

### 3. Free プランの負荷制御を Durable Object に置く

quota pool ごとに in-flight request 数を Durable Object の authoritative state として管理する。初期値は pool ごとに 2 件とし、`MAX_IN_FLIGHT_REQUESTS` で変更可能にする。reserve 成功後、upstream 呼び出し前に in-flight を acquire し、非 streaming の完了・失敗、SSE の正常終了・切断・例外で必ず release する。

上限到達時は quota token を消費せず、HTTP 429 と `reject:worker_concurrency` を返す。入力サイズ超過の 413 と混同しない。SSE は接続時間中 in-flight として数えるため、長時間接続が別の長時間接続を無制限に増やさない。

### 4. quota accounting は維持する

Compaction を別 provider や別 gateway へ逃がさない。Compaction も通常リクエストと同じ reserve → upstream → settle / uncertain の経路を通す。失敗した Compaction の再試行で同じ quota を二重予約しないよう、既存の Idempotency-Key 契約を維持する。

### 5. エラー再試行を制限する

OCTG は入力超過を明確な 413 として返す。OpenCode 側で Compaction が 413 を受けた場合に無制限再試行しないことを、統合テストで確認する。OCTG は同一 request に対して追加の retry を行わない。

## 変更対象

- `packages/shared/src/normalize.ts`: 既定入力上限を 1 MiB に更新。
- `apps/gateway-worker/wrangler.jsonc`: `MAX_INPUT_BYTES` を 1 MiB に更新し、`MAX_IN_FLIGHT_REQUESTS` を追加。
- `apps/gateway-worker/src/proxy.ts`: body の上限付き読み取り、in-flight acquire / release、429 契約。
- `durable-objects/quota-controller/src/*`: pool ごとの in-flight state と acquire / release RPC。
- `packages/shared/src/errors.ts`: worker concurrency 用 429 error を追加。
- 既存の shared / Worker / Durable Object tests: 境界値、SSE lifecycle、quota 非消費の concurrency reject を追加。
- 運用ドキュメント: Free プランの入力上限、同時実行上限、413 / 429 の違いを記載。

## 検証方針

1. 1 MiB 未満の OpenCode 互換 Responses payload が upstream に到達する。
2. 1 MiB 超過 payload は JSON parse・tokenizer・reservation・upstream より前に 413 になる。
3. 同時実行上限超過は 429 になり、quota の reserved / confirmed / uncertain が変化しない。
4. SSE の正常終了、切断、upstream 5xx の全経路で in-flight が解放される。
5. Compaction 相当の payload が OCTG 経由で通り、413 の再試行ループを発生させない。
6. `npm test`、`npm run typecheck`、`npm run fmt`、`npm run validate` が成功する。

## 未確定事項

1 MiB と pool ごとの in-flight 2 件は初期運用値であり、Free プランの実データと CPU / memory metrics によって調整する。ただし、調整は入力上限の再縮小ではなく、まず concurrency と tokenizer 負荷を観測して行う。
