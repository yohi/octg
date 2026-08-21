import type { TokenizerController, TokenizerControllerEnv } from "../src/tokenizer-controller";

declare global {
  namespace Cloudflare {
    interface Env extends TokenizerControllerEnv {
      readonly TOKENIZER_CONTROLLER: DurableObjectNamespace<TokenizerController>;
    }
  }
}

export {};
