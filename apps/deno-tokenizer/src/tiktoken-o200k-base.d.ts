declare module "tiktoken/encoders/o200k_base" {
  const o200kBase: {
    readonly bpe_ranks: string;
    readonly special_tokens: Record<string, number>;
    readonly pat_str: string;
  };

  export default o200kBase;
}
