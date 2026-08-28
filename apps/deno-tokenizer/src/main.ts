import { resolveServiceConfig } from "./config.ts";
import { exactEncoder } from "./encoder.ts";
import { createTokenizerHandler } from "./http.ts";

const config = resolveServiceConfig((name) => Deno.env.get(name));

Deno.serve(createTokenizerHandler({ config, encoder: exactEncoder }));
