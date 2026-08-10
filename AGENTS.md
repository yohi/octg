# OCTG — Agent Guide

OCTG は、OpenAI Data Sharing Program の無料枠を複数クライアントで共有する OpenAI 互換 API Gateway です。

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

## 設計・運用の正確性

詳細なアーキテクチャ・API 仕様・エラー契約は [SPEC.md](./SPEC.md) を読むこと。

運用手順（デプロイ、Secret 管理、ローテーション）は [README.md](./README.md) を読むこと。

## 重要な制約

- authoritative なクォータ制御は Durable Object が担う。D1 は監査・証跡用途のみ。
- `octg_sk_*` などの認証素材は keyed hash で保存し、生値をコード・ログに残さない。
- 監査ログの D1 書き込みは best-effort。課金判定を監査ログ到達に依存させない。
