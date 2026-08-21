export const MAX_IDEMPOTENCY_KEY_BYTES = 255;

const UTF8_ENCODER = new TextEncoder();

export type ParsedIdempotencyKey =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | { readonly kind: "valid"; readonly value: string };

export function parseIdempotencyKey(value: unknown): ParsedIdempotencyKey {
  if (value === undefined || value === null || value === "") {
    return { kind: "absent" };
  }
  if (typeof value !== "string") return { kind: "invalid" };
  if (UTF8_ENCODER.encode(value).byteLength > MAX_IDEMPOTENCY_KEY_BYTES) {
    return { kind: "invalid" };
  }
  return { kind: "valid", value };
}
