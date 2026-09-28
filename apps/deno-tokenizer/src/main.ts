import { resolveRelayConfig, resolveServiceConfig } from "./config.ts";
import { exactEncoder } from "./encoder.ts";
import { createTokenizerHandler } from "./http.ts";
import { createRelayHandler } from "./relay.ts";

const readEnv = (name: string): string | undefined => Deno.env.get(name);

const config = resolveServiceConfig(readEnv);

function resolveRelayHandler():
  | ((request: Request) => Promise<Response>)
  | undefined {
  if (readEnv("OCTG_RELAY_ENABLED") !== "true") {
    return undefined;
  }
  const relayConfig = resolveRelayConfig(readEnv);
  return createRelayHandler({
    config: relayConfig,
    encoder: exactEncoder,
    fetchImpl: fetch,
  });
}

Deno.serve(
  createTokenizerHandler({
    config,
    encoder: exactEncoder,
    relayHandler: resolveRelayHandler(),
  }),
);
