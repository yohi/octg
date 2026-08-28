/// <reference path="./tiktoken-o200k-base.d.ts" />

import { init, Tiktoken } from "tiktoken/lite/init";
import o200kBase from "tiktoken/encoders/o200k_base";

const wasmUrl = import.meta.resolve(
  "tiktoken/lite/tiktoken_bg.wasm",
);
const wasm = await Deno.readFile(new URL(wasmUrl));
await init((imports) => WebAssembly.instantiate(wasm, imports));

const encoding = new Tiktoken(
  o200kBase.bpe_ranks,
  o200kBase.special_tokens,
  o200kBase.pat_str,
);

export interface ExactEncoder {
  readonly count: (inputText: string) => number;
}

export const exactEncoder: ExactEncoder = {
  count: (inputText) => encoding.encode(inputText).length,
};
