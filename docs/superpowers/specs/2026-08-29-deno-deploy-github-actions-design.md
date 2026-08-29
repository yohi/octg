# Deno Deploy GitHub Actions 設計

## 目的

`apps/deno-tokenizer` を GitHub Actions で検証後に Deno Deploy へデプロイする。既存の Cloudflare Worker 用 workflow とは分離し、Deno Deploy の Production プロジェクトを GitHub Environment で管理する。

## 方針

- Pull Request では Deno の型検査とテストだけを実行する。
- `master` への push では、同じ検証が成功した場合だけ Production デプロイを実行する。
- `apps/deno-tokenizer/**`、`packages/shared/**`、workflow 自身の変更だけをトリガーにする。
- `denoland/deployctl@v1` と GitHub OIDC (`id-token: write`) を使用し、長期保存する Deno API token は使用しない。
- Deno Deploy のプロジェクト名は Environment Variable `DENO_DEPLOY_PROJECT` として保持する。
- `OCTG_TOKENIZER_AUTH_TOKEN` などの実行時 Secret は Deno Deploy 側で管理し、GitHub Actions へ渡さない。
- リポジトリルートを upload root とし、Deno app から参照する `packages/shared/src` を deploy payload に含める。

## 対象外

- Preview 用 Deno Deploy プロジェクトの自動デプロイ。Preview は Production と別 Environment・別プロジェクトで後から追加できる。
- Worker の `DENO_TOKENIZER_*` 設定や Secret の自動変更。
- Deno Deploy プロジェクトの作成や Deno 側の実行時環境変数設定。

## 成功条件

- PR で `deno task check` と `deno task test` が実行される。
- `master` push では検証成功後に `denoland/deployctl@v1` が `apps/deno-tokenizer/src/main.ts` をデプロイする。
- Production プロジェクト名が未設定の場合、デプロイ前に明示的なエラーで停止する。
- GitHub Actions の権限は `contents: read` とデプロイ job の `id-token: write` に限定される。
