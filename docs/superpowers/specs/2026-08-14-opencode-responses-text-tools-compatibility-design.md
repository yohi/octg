# OpenCode Responses テキスト・ツール互換性設計

## 目的

BYOK プラグイン経由で OpenCode から OCTG の `/v1/responses` を利用する際、テキスト入力とツール呼び出し履歴を正しく受理できるようにする。OCTG の MVP が対象外とする画像・音声・ファイル入力の拒否契約は維持する。

## 背景

OCTG は予約前に入力 token 数を推定するため、`packages/shared/src/normalize.ts` で content part をテキストに限定している。BYOK プラグインはツール利用時に Responses API を選択するため、OpenCode の通常のコーディング操作では Responses の入力配列にテキストメッセージと function call 履歴が含まれる。

現在の正規化処理は `function_call` と `function_call_output` を入力項目単位でスキップするが、AI SDK が assistant の履歴に使用する `output_text` と、推論モデルのツール継続に含まれる `reasoning` item を受理しない。そのため、合法なテキスト＋ツール履歴が `non_text` として扱われる互換性リスクがある。

## 非目標

- 画像、音声、動画、ファイルの token 推定や quota 予約を実装しない。
- OCTG リポジトリ内で BYOK プラグインの実装変更は行わない。ただし、`store: false` を使用し、`item_reference`、`previous_response_id`、`conversation` を送らず必要な履歴を再送する設定を BYOK 側の前提条件とする。
- ツール利用を無料枠で許可するポリシー変更を行わない。`tools_mode` の既存契約に従う。
- モデル名の alias や `medium` のような推論設定を OCTG 側で解釈しない。

## 採用方針

`normalizeResponses` の既存責務を維持し、Responses の以下の入力だけを成功条件として明示する。

1. `input` が文字列。
2. `input` が配列で、`type` が省略または `message` の各通常 itemの`content`が文字列またはroleに応じたテキストpart配列。assistant itemでは`output_text`、user/system/developer itemでは`input_text`を許可する。
3. `function_call` と `function_call_output` item は通常のmessage本文とは分離して処理し、`isToolUse` を true にする。`arguments` と文字列または検査済み`input_text` partの`output`は推定対象へ含める。
4. `reasoning` itemは`summary_text`配列と`encrypted_content`を必須とする構造itemとして受理する。summaryは可視テキスト推定、encrypted contentは`opaqueInputBytes`としてUTF-8 byte数を保守的に加算する。
5. `instructions`、tool定義、function itemのprompt-bearingな文字列は推定対象に含める。

上記以外のcontent part、特に`input_image`、`input_audio`、`input_file`、`file`、`video`は従来通り`non_text`として予約前に拒否する。`function_call_output.output`が配列の場合も同じ規則で走査する。未知の構造item、`item_reference`、`previous_response_id`、`conversation`は、参照先の実データを取得してtoken推定できないため`invalid_body`として拒否する。

## データフロー

1. Worker が `/v1/responses` を `handleProxy` に渡す。
2. `normalizeResponses` が入力形状を検証し、visible prompt text、opaque reasoning byte数、item countを抽出する。
3. 非テキスト入力は quota reservation 前に `errNonTextInput` で HTTP 400 を返す。
4. テキスト＋ツール履歴は既存の model registry、client policy、Durable Object reservation に進む。
5. upstream へは元の request body を送信し、出力上限だけ既存仕様に従って注入する。

## エラー契約

非テキスト入力の既存契約を変更しない。

```text
HTTP 400
error.type = invalid_request_error
error.param = input
error.code = invalid_request
message = Non-text input is not supported in the MVP.
```

入力形状が不正な場合は既存の `invalid_request` 契約を使用する。ツール利用が policy で拒否される場合は既存の `model_not_allowed` を使用する。

## テスト設計

`packages/shared/test/normalize.test.ts` に次の境界を追加または明示する。

- Responses のrole別許可に従い、input_text / output_text partを含む複数itemがtextとして連結される。
- Responses の function_call / function_call_output item が文字列化されず、tool-use と判定される。
- Responses の reasoning summaryがtext推定へ、encrypted contentがopaque byte推定へ含まれる。
- function call arguments、文字列tool output、instructions、tool定義が推定対象へ含まれる。
- OpenCode 相当のテキスト＋ツール履歴が `non_text` にならない。
- function output内を含むinput_image、input_audio、input_file、file、videoは引き続き`non_text`になる。
- item_reference、previous_response_id、conversation、未知のtop-level item / nested partは拒否される。
- tools_mode=REJECTではreservation/upstream前にmodel_not_allowed、ALLOWでは元のinputを保持してupstreamへ送る。

テストはまず現在の実装で失敗する形状を確認し、その後に最小修正を行う。既存の chat、quota、upstream body の契約は維持し、`opaqueInputBytes` や新しいResponses履歴の期待値だけを更新する。

## 成功条件

- OpenCode のテキスト＋ツール Responses リクエストが `non_text` で拒否されない。
- assistant `output_text` と reasoning itemを含む GPT-5.6 Luna 相当の履歴が、prompt-bearingな内容とopaque reasoning stateを過少計上せずに処理される。
- 非テキスト入力の既存拒否テストが通る。
- `npm test` と `npm run typecheck` が成功する。
- 実際の Gateway surface で、単純な Responses テキストリクエストと非テキスト拒否を確認できる。
