import { DurableObject } from "cloudflare:workers";

export interface QuotaControllerEnv {
  readonly QUOTA_LIMIT_STANDARD?: string;
  readonly QUOTA_LIMIT_MINI?: string;
}

export class QuotaController extends DurableObject<QuotaControllerEnv> {
  async getState(): Promise<{ readonly pool: string; readonly utcDay: string; readonly limit: number }> {
    const [, pool = "", day = ""] = this.ctx.id.name?.split(":") ?? [];
    const configuredLimit = Number(
      pool === "STANDARD" ? this.env.QUOTA_LIMIT_STANDARD : this.env.QUOTA_LIMIT_MINI,
    );
    const limit = configuredLimit > 0 ? configuredLimit : pool === "STANDARD" ? 1_000_000 : 10_000_000;

    return { pool, utcDay: day, limit };
  }
}
