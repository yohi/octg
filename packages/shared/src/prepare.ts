/**
 * Transport-neutral prepare metadata and error contracts.
 *
 * Only shared types live here. Base64url encoding/decoding and runtime
 * validation are Worker-side concerns; marker generation is Deno-side.
 */

export interface PrepareMetadata {
  readonly version: 1;
  readonly model: string;
  readonly rawBodyBytes: number;
  readonly inputBytes: number;
  readonly inputTextBytes: number;
  readonly opaqueInputBytes: number;
  readonly messageCount: number;
  readonly estimatedInputTokens: number;
  readonly estimationPath: "exact_bpe";
  readonly maxOutputTokens: number;
  readonly stream: boolean;
  readonly isToolUse: boolean;
  readonly outputMarker: string;
}

export type PrepareErrorCode =
  | "invalid_body"
  | "non_text"
  | "max_tokens_conflict"
  | "input_too_large"
  | "request_too_large";

export interface PrepareErrorBody {
  readonly code: PrepareErrorCode;
}