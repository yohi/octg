<!-- markdownlint-disable MD013 -->

# 環境設定とセットアップの統合設計

## 目的

OCTG の設定値を一つのテンプレートと一つの設定カタログに集約し、利用者が設定値の用途・取得場所・設定先・Production/Preview の境界を迷わず確認できるようにする。Local と Production のセットアップは、既存リソースを対象に、手元にない値だけを入力すれば完了する形にする。

## 対象範囲

- ルートの `.env.example` に Local、Production、Preview、Deno tokenizer、Worker canary、OpenCode の設定例をまとめる。
- 既存の `preview.env.example` は削除し、Preview setup は統合テンプレートを入力源として使用する。
- `docs/CONFIGURATION.md` に設定値のカタログを作り、README は各利用者向けの入口と短い実行例に整理する。
- `setup:local` と `setup:deploy` は維持し、`--env-file` と `--dry-run` を追加する。既存の明示的なコマンド名は変更しない。
- Local setup は安全な開発用既定値を使い、`.dev.vars`、local D1 migration、開発用 client seed を自動化する。
- Deploy setup は D1、AI Gateway、Access application の新規作成を行わず、既存リソースの設定、Secret 登録、remote migration、deploy を行う。
- Preview と Production の account、Worker、D1、Durable Object、client/policy/model registry、監査状態、credential は混在させない。

## 設定ファイルの役割

### `.env.example`

コミットする説明用テンプレート。実Secret、実client key、実アカウント固有値は含めない。各セクションに次の情報をコメントで記載する。

- `LOCAL`: `.dev.vars`へ反映する開発用値と、入力不要な既定値
- `PRODUCTION`: `wrangler.jsonc`へ反映する vars と、Cloudflare secretへ登録する値
- `PREVIEW`: `setup-preview.zsh`とGitHub `preview` Environmentへ渡す値
- `DENO`: Deno Deploy app と Worker の別々の設定値
- `CANARY`: Production Workerを呼ぶ専用client key、URL、timeout、concurrency
- `OPENCODE`: Gateway A Custom Providerを利用するクライアント側の環境変数

利用者は `.env.example` を `.env` へコピーする。`.env` は `.gitignore` 対象で、セットアップスクリプトは許可された変数だけを読み込む。既存の `admin.env` など他ツール用ファイルは自動入力源にしない。

### `docs/CONFIGURATION.md`

設定のSSOT。変数ごとに `scope`、`secret`、`consumer`、`where to set`、`how to obtain`、`default`、`safety note` を説明する。特に次の境界を明示する。

- Gateway A（利用者からOCTGへ入るCustom Provider）と Gateway B（Workerからupstreamへ出るAI Gateway）
- Production と Preview の control plane
- `wrangler.jsonc`の公開varsと、Cloudflare/Deno/GitHubへ登録するSecret
- Workerのcanary client keyと通常利用者のclient key

### 既存ドキュメント

`README.md`、`docs/DEPLOY_FROM_TEMPLATE.md`、`docs/deno-tokenizer.md` は詳細を重複記載せず、設定カタログへのリンクと役割別の最短手順を提供する。`preview.env.example`への参照は`.env.example`へ置換する。

## セットアップCLI

### 入力の優先順位

各セットアップは次の順で値を解決する。

1. コマンドラインの明示オプション
2. process environment
3. `--env-file`で指定したファイル
4. 既定値
5. 対話プロンプト

env file は shell として実行せず、`KEY=value`、`export KEY=value`、コメント、単引用符、二重引用符だけを解析する。未許可の変数は無視し、構文エラーは対象変数だけを明示して停止する。Secret値、client key、入力本文、exception messageはログに出さない。

### Local

```text
npm run setup:local [-- --env-file=.env --force]
```

入力がなければ開発用の安全な既定値を使用する。process environmentまたは`.env`に値があればそれを優先し、既存の`.dev.vars`は`--force`なしでは上書きしない。client keyを自動生成した場合は、既存どおり完了メッセージで一度だけ表示する。

### Production

```text
npm run setup:deploy [-- --env-file=.env --dry-run]
npm run setup:deploy [-- --env-file=.env]
```

`CLOUDFLARE_ACCOUNT_ID`、D1 database ID、Gateway B URL、Access team domain、Access AUD は `.env`または既存の `wrangler.jsonc` から解決し、不足分だけ尋ねる。Cloudflare認証済み環境から account ID や D1 ID を安全に取得できる場合は自動検出し、曖昧な複数候補は勝手に選ばず入力を求める。

3つのWorker Secretは、環境変数から非対話的に渡せる場合も含め、コマンドライン引数へ値を置かず、wranglerのstdinまたは対話入力へ渡す。Secretをファイルへ書き戻さない。`--dry-run`ではconfig変更、Secret登録、D1 migration、deployを一切行わず、変更対象の名前と実行予定手順だけを表示する。

### Preview

Preview setupは `.env` を既定入力ファイルとし、Preview用の許可変数だけを使用する。Production用の account ID、API token、D1 ID、Worker URLは読み取らず、Preview用の不足値で停止する。既存の `--dry-run` と `--github` の動作は維持する。

### Deno tokenizer、canary、OpenCode

これらは外部サービスまたは利用者側設定であり、Worker Production setupに自動混入させない。`.env.example`と`docs/CONFIGURATION.md`で取得方法と設定先を示し、個別の既存コマンド・GitHub Environment・Deno Deploy Secretを使用する。

## エラーと安全性

- 未設定値は変数名と取得先だけを表示する。
- `<...>`形式のプレースホルダーをProductionへ適用しない。
- `.env`、`.dev.vars`、一時SQL、一時Wrangler configは0600で作成し、gitignore対象にする。
- Production setupは既存の `wrangler.jsonc` を更新する前に全入力を検証する。
- Preview setupはProduction configのD1 bindingを変更しない。
- Secretやclient keyをREADME、ログ、コマンドライン引数、コミットへ出さない。

## テスト方針

- env parserがshell構文を実行せず、許可変数だけを読み込むことをテストする。
- Local setupの既定値、既存`.dev.vars`保護、`--force`、client key生成をテストする。
- Deploy setupが不足値だけを尋ね、placeholderを拒否し、`--dry-run`で副作用を起こさないことをテストする。
- Secret値、client key、入力本文が出力に含まれないことをテストする。
- Preview setupの統合テンプレート読み込みとProduction値の分離をテストする。
- 既存のcanary、Preview workflow、Deno workflow、全workspaceのtest/typecheckを実行する。

## 受け入れ条件

- 新規利用者は `.env.example` と `docs/CONFIGURATION.md` だけで、各設定値の取得場所と登録場所を判断できる。
- Localは必須入力なしでセットアップできる。
- Productionは既存リソースを前提に、入力済みの値を再入力せず、欠落値だけの入力でセットアップできる。
- Preview用テンプレートは独立ファイルとして残らず、統合テンプレートから安全に実行できる。
- `--dry-run`で本番リソースへ書き込みが発生しない。
- ProductionとPreviewのcredential/resourceが自動処理で混ざらない。
- 全既存テストと新規テストが成功する。
