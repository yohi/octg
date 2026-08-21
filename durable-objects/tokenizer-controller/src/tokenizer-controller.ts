import { DurableObject } from "cloudflare:workers";
import { TokenizerEstimator, TokenizerWorkLimitError } from "./estimator";
import { parseTokenizeRequest, type TokenizeRequest, type TokenizeRpcResult } from "./contracts";
import { emitTokenizerStage } from "./observation";

export interface TokenizerControllerEnv {
  readonly CF_VERSION_METADATA?: WorkerVersionMetadata;
}

export class TokenizerController extends DurableObject<TokenizerControllerEnv> {
  private readonly estimator = new TokenizerEstimator();

  public async tokenize(request: TokenizeRequest): Promise<TokenizeRpcResult>;

  public async tokenize(request: unknown): Promise<TokenizeRpcResult> {
    const parsed = parseTokenizeRequest(request);
    const revisionId = this.env.CF_VERSION_METADATA?.id;
    try {
      return this.estimator.estimate(parsed, {
        requestId: parsed.requestId,
        revisionId: typeof revisionId === "string" && revisionId.length > 0 ? revisionId : "local",
        emit: emitTokenizerStage,
      });
    } catch (error) {
      if (error instanceof TokenizerWorkLimitError) return { kind: "work_limit" };
      throw error;
    }
  }
}
