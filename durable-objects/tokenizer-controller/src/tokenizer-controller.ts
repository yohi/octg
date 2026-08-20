import { DurableObject } from "cloudflare:workers";
import { TokenizerEstimator } from "./estimator";
import { parseTokenizeRequest, type TokenizeRequest, type TokenizeResult } from "./contracts";
import { emitTokenizerStage } from "./observation";

export interface TokenizerControllerEnv {
  readonly CF_VERSION_METADATA?: WorkerVersionMetadata;
}

export class TokenizerController extends DurableObject<TokenizerControllerEnv> {
  private readonly estimator = new TokenizerEstimator();

  public async tokenize(request: TokenizeRequest): Promise<TokenizeResult>;

  public async tokenize(request: unknown): Promise<TokenizeResult> {
    const parsed = parseTokenizeRequest(request);
    const revisionId = this.env.CF_VERSION_METADATA?.id;
    return this.estimator.estimate(parsed, {
      requestId: parsed.requestId,
      revisionId: typeof revisionId === "string" && revisionId.length > 0 ? revisionId : "local",
      emit: emitTokenizerStage,
    });
  }
}
