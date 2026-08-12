# OCTG — Agent Guide

OCTG は、OpenAI Data Sharing Program（Tier 3）の無料枠を複数クライアントで共有する
OpenAI 互換 API Gateway です。

## 技術スタック

- TypeScript（strict）
- Cloudflare Workers + Durable Objects（SQLite-backed）+ D1
- npm workspaces
- Vitest + `@cloudflare/vitest-pool-workers`

## 基本コマンド

```bash
npm install
npm test            # 全ワークスペースでテスト実行
npm run typecheck   # 全ワークスペースで型検査
npm run dev -w apps/gateway-worker
```

## プロジェクト構造

```text
octg/
├── apps/gateway-worker/      # Worker エントリ（認証・プロキシ・Admin API）
├── durable-objects/
│   └── quota-controller/    # QuotaController Durable Object
├── packages/shared/         # 型定義・モデル分類・推定ロジック
├── db/migrations/           # D1 マイグレーション
└── docs/                    # 運用・設計ドキュメント
```

## 重要な制約

- authoritative なクォータ制御は Durable Object が担う。D1 は監査・証跡用途のみ。
- `octg_sk_*` などの認証素材は keyed hash で保存し、生値をコード・ログに残さない。
- 監査ログの D1 書き込みは best-effort。課金判定を監査ログ到達に依存させない。

## 詳細ドキュメント

- アーキテクチャ・API 仕様・エラー契約: [SPEC.md](./SPEC.md)
- デプロイ・Secret 管理・ローテーション・運用手順: [README.md](./README.md)
- Cloudflare AI Gateway Custom Provider 経由の公開手順: [docs/cloudflare-ai-gateway-custom-provider.md](./docs/cloudflare-ai-gateway-custom-provider.md)
- テンプレートからの新規構築手順: [docs/DEPLOY_FROM_TEMPLATE.md](./docs/DEPLOY_FROM_TEMPLATE.md)
