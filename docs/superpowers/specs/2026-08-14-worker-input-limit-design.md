# Worker 入力サイズ上限設計

## 背景

Cloudflare AI Gateway の `my-gateway` で、`gpt-5.6-luna` の Responses リクエストが複数の長時間 SSE と並行した際に Cloudflare Error 1102（Worker exceeded resource limits）で失敗した。直前の入力は約 60k〜65k tokens だった。

## 目的

過大な Responses / Chat Completions 入力を JSON parse・tokenizer・upstream 処理より前に拒否しつつ、OpenCode の通常リクエストと Compaction を許可する。Free プランの Worker resource limit は pool ごとの同時実行数で制御する。

## 設計

- `MAX_INPUT_BYTES` を Worker 環境変数として追加する。
- 既定値は 1,048,576 bytes（1 MiB）とする。
- `Content-Length` が上限を超える場合と、chunked body の累積 byte 数が上限を超える場合は、JSON parse 前に HTTP 413 を返す。
- 正規化済みの `inputText` の UTF-8 byte 数と `opaqueInputBytes` の合計も、tokenizer 実行前に検査する。
- 上限超過時は予約・Durable Object RPC・upstream 呼び出しを行わない。
- pool ごとの in-flight request 数は Durable Object で管理し、既定値2件を超える場合は quota を消費せず HTTP 429 `worker_concurrency_exceeded` を返す。
- `MAX_INPUT_BYTES` が未設定・整数でない・0以下の場合は既定値へフォールバックする。
- Worker isolate 間で共有されないグローバル semaphore は実装しない。正確な同時実行制御には Durable Object の状態機械変更が必要であり、今回のログから必要性を確定できないため対象外とする。

## エラー契約

既存の `request_too_large` エラーを再利用し、quota snapshot と `X-OCTG-Route: reject:request_too_large` を返す。入力サイズ超過は無料枠の残量超過とは異なるため、エラーメッセージは入力サイズ上限を示す文言に分離する。

## テスト

- `Content-Length` と chunked body の双方で、上限超過が JSON parse 前に HTTP 413 になること。
- Chat Completions の UTF-8 byte 数が上限を超える場合、正規化結果が明示的な `input_too_large` になること。
- Responses の `opaqueInputBytes` を含む合計が上限を超える場合、同じ拒否になること。
- Worker 経路では超過リクエストが 413 になり、upstream が呼ばれず、quota reservation が増えないこと。
- in-flight 上限超過が HTTP 429 になり、upstream が呼ばれず、quota reservation が増えないこと。
- 既存の正常系・quota 超過・非テキスト入力契約を維持すること。
