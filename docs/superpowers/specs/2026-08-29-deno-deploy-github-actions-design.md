# Deno Deploy GitHub Actions 設計

## 目的

`apps/deno-tokenizer` を GitHub Actions で検証後に Deno Deploy へデプロイする。既存の Cloudflare Worker 用 workflow とは分離し、Deno Deploy の Production プロジェクトを GitHub Environment で管理する。

## 方針

- Pull Request では Deno の型検査とテストだけを実行する。
- `master` への push では、同じ検証が成功した場合だけ Production デプロイを実行する。
- `apps/deno-tokenizer/**`、`packages/shared/**`、workflow 自身の変更だけをトリガーにする。
- Deno 2.x の `deno run -A jsr:@deno/deploy@...` CLI と `DENO_DEPLOY_TOKEN` を使用する。`deployctl` は Deno Deploy Classic 用のため使用しない。
- Deno Deploy の組織名とアプリ名は Environment Variables `DENO_DEPLOY_ORG` / `DENO_DEPLOY_APP` として保持する。
- `OCTG_TOKENIZER_AUTH_TOKEN` などの実行時 Secret は Deno Deploy 側で管理し、GitHub Actions へ渡さない。
- Production デプロイは repository root `deno.json` に基づく staging copy (`<repo>/.deno-deploy-source`) から実行される。
## 対象外

- Preview 用 Deno Deploy プロジェクトの自動デプロイ。Preview は Production と別 Environment・別プロジェクトで後から追加できる。
- Worker の `DENO_TOKENIZER_*` 設定や Secret の自動変更。
- Deno Deploy プロジェクトの作成や Deno 側の実行時環境変数設定。

## 成功条件

- PR で `deno task check` と `deno task test` が実行される。
- `master` push では検証成功後に `deno run -A jsr:@deno/deploy@...` が staging copy (`<repo>/.deno-deploy-source`) から Production アプリへデプロイする。
- Production の組織名、アプリ名、access token が未設定の場合、デプロイ前に明示的なエラーで停止する。
- GitHub Actions の権限は `contents: read` に限定し、Deno access token は `deno-production` Environment Secret で管理する。
