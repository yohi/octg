# Secrets and Variables Documentation Design

## Context

OCTGのSecretsとVariablesに関する情報が、`README.md`、
`docs/CONFIGURATION.md`、`docs/DEPLOY_FROM_TEMPLATE.md`、
`docs/deno-tokenizer.md`へ分散している。同じ設定名について、設定先、利用者、
取得方法、反映方法の説明が複数箇所に存在し、初回デプロイ担当者が設定順序と
Production/Previewの境界を判断しにくい。

## Audience and Goal

主な読者は初回デプロイ担当者とする。読者が次の事項を追加調査せずに判断できる
ことを成功条件とする。

- その値がSecretか通常のVariableか
- どのサービスまたはスコープへ設定するか
- 値をどこから取得または生成するか
- どの順番で設定・デプロイ・client seedを行うか
- ProductionとPreviewで何を共有してはいけないか

## Source of Truth

`docs/CONFIGURATION.md`をSecrets/Variablesの完全な一覧と初回設定手順のSSOTとする。
他の文書は、固有のデプロイ手順やサービスの詳細を説明する場合に限り、必要な要点を
記載し、設定名の完全な一覧を複製しない。

## Information Architecture

`docs/CONFIGURATION.md`は次の順序に整理する。

1. 最初に読むルール: SecretとVariableの違い、値をコード・ログ・CLI引数へ置かない
2. Quick start: 初回デプロイで実行する設定順序
3. Configuration catalog: スコープごとの完全な一覧
4. Production/Preview boundary: 専用リソース、prefix、共有禁止
5. Rotation and recovery: client pepper、runtime token、upstream tokenの更新順序
6. Troubleshooting: 設定不足、Secret不一致、反映漏れの確認方法
7. Related procedures: canary、Gateway A/B、Deno tokenizerの詳細へのリンク

各カタログ表は次の列を使用する。

| 列 | 説明 |
| --- | --- |
| Name | 実際に使用する環境変数またはSecret名 |
| Kind | `Secret`または`Variable` |
| Consumer | その値を読むサービス、workflow、またはCLI |
| Set in | Dashboard、Worker、Deno Deploy、GitHub、process environmentなど |
| Obtain or decide | 取得元、生成方法、既定値、または固定値 |
| Apply | Secret更新、deploy、seedなど反映に必要な操作 |

## Canonical Ownership

カタログには、次の境界を必ず一度だけ説明する。

- Cloudflare deploy authentication:
  `CLOUDFLARE_ACCOUNT_ID`はVariable、
  `CLOUDFLARE_API_TOKEN`はSecret。どちらもWrangler用。
- Production Worker runtime:
  `OCTG_KEY_PEPPER`、`OCTG_UPSTREAM_API_TOKEN`、
  `OPENAI_USAGE_API_KEY`はWorker Secret。
- Production Worker Deno integration:
  `DENO_TOKENIZER_ENDPOINT`、`DENO_TOKENIZER_THRESHOLD_BYTES`、
  `DENO_TOKENIZER_TIMEOUT_MS`はWorker Variable。
- Shared input ceiling:
  `MAX_INPUT_BYTES`はVariable。ConsumerはGateway WorkerおよびDeno tokenizerで、
  Set inはWorker varsおよびDeno Deploy runtime environment、Applyは各runtimeのdeployとする。
  両runtimeへ同じraw値を設定し、`resolveMaxInputBytes`でresolved valueを照合する。
- Shared Deno authentication:
  `DENO_TOKENIZER_AUTH_TOKEN`はWorker Secret、
  `OCTG_TOKENIZER_AUTH_TOKEN`はDeno Deploy runtime Secret。
  値は同じだが、名前と設定先は異なる。
- Deno Deploy CI:
  `DENO_DEPLOY_ORG`と`DENO_DEPLOY_APP`はVariable、
  `DENO_DEPLOY_TOKEN`はSecret。GitHub Environment
  `deno-production`だけで使用する。
- Production canary:
  `OCTG_CANARY_URL`、`OCTG_CANARY_ALLOWED_HOSTS`、
  `OCTG_CANARY_CLIENT_KEY`は一時的なprocess environment。
- Preview:
  `CLOUDFLARE_PREVIEW_*`と`OCTG_PREVIEW_*`を使い、
  Account、Worker、D1、Gateway、pepper、client keyをProductionと分離する。

特に次の2つのtokenを混同しない。

- `DENO_DEPLOY_TOKEN`: Deno Deploy APIを操作するCI/管理用Secret。tokenizer HTTP認証には使わない。
- `DENO_TOKENIZER_AUTH_TOKEN` / `OCTG_TOKENIZER_AUTH_TOKEN`:
  Gateway WorkerとDeno tokenizer間のruntime通信専用Secret。

## First-Deploy Flow

初回デプロイ手順は、Deno無効のbaseline canaryとDeno経路canaryを分けた次の一本道として記載する。

1. Production用のCloudflare Account IDとAPI tokenを用意する。
2. Worker runtime Secretと通常Variablesを設定し、`MAX_INPUT_BYTES`のraw値を決める。
3. Deno integrationの4設定を未設定にしたbaseline configでinactive versionをuploadし、
   `versions secret put`でWorker Secretを揃える。既存の`DENO_TOKENIZER_AUTH_TOKEN`は
   `versions secret delete`で除去してから`versions deploy`で一度だけactiveにする。
4. Productionの既存`OCTG_KEY_PEPPER`を使ってclientをseedし、Deno無効の初回canaryを実行する。
   `cloudflare_do`のtokenization、Worker resource limit、quota reserve/settle、upstream到達を確認する。
5. 初回canary合格後、Deno Deploy applicationをdeployし、runtime Secret
   `OCTG_TOKENIZER_AUTH_TOKEN`、Worker vars、matching Secret `DENO_TOKENIZER_AUTH_TOKEN`を設定する。
   `MAX_INPUT_BYTES`はDeno runtimeにも同じraw値を設定する。
6. Deno integrationのWorker varsをinactive versionへuploadし、`versions secret put`で
   `DENO_TOKENIZER_AUTH_TOKEN`を同じversionへ追加してから`versions deploy`で反映する。
7. 両runtimeのresolved `MAX_INPUT_BYTES`を照合し、Deno経路canaryを実行する。
   `deno` provider、Deno stage、exact token count、quota lifecycle、upstream到達を確認する。

`DENO_TOKENIZER_*`の一部だけを設定した場合はfail-closedになるため、Deno連携を有効に
する場合はendpoint、auth token、threshold、timeoutを同じ変更として扱う。

## Cross-Document Rules

- `README.md`は設定カタログを複製せず、初回導線と`CONFIGURATION.md`へのリンクを提供する。
- `docs/DEPLOY_FROM_TEMPLATE.md`はテンプレート固有の作成順序だけを説明し、Secret/Variableの完全な一覧は参照する。
- `docs/deno-tokenizer.md`はDeno runtimeの契約、health check、障害対応など
  Deno固有の内容に限定し、共通カタログを参照する。
- 同じ設定名の表を複数文書へ置かない。
- コマンド例には実Secret、raw client key、固定された個人アカウント値を含めない。

## Acceptance Criteria

- 初回デプロイ担当者が各値のSecret/Variable区分と設定先を一つの表で確認できる。
- `DENO_DEPLOY_TOKEN`とruntime tokenizer tokenの用途が明確に分離される。
- `DENO_TOKENIZER_AUTH_TOKEN`と`OCTG_TOKENIZER_AUTH_TOKEN`が同一値・別設定先であることが明示される。
- `MAX_INPUT_BYTES`のConsumer、設定先、各runtime deployでのApply、raw値とresolved valueの照合方法が明示される。
- 既存WorkerのSecret更新がinactive versionで完結し、設定未完了のversionをactiveにしない。
- ProductionとPreviewの共有禁止が、設定名・リソース・pepper・client keyの全てに適用される。
- 設定変更後に必要なdeploy、seed、canaryの順序が一度だけ記載される。
- Preview quotaのprovider ceiling、共有billing principal時の合算判定、quota受け入れ時のreserve/upstream条件が確認できる。
- 4文書間に重複した完全一覧、古いコマンド、相互矛盾が残らない。
- markdownlintとリンクチェックが通過する。
