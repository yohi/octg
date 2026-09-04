// Cache the HMAC key per pepper value so that crypto.subtle.importKey is not
// called on every request.  The pepper is an env binding that is constant for
// the lifetime of the Worker isolate, so a single cached key suffices.
const UTF8_ENCODER = new TextEncoder();
let cachedKey: {
  readonly pepper: string;
  readonly promise: Promise<CryptoKey>;
} | undefined;

function getHmacKey(pepper: string): Promise<CryptoKey> {
  if (cachedKey?.pepper === pepper) return cachedKey.promise;
  const promise = crypto.subtle.importKey(
    "raw",
    UTF8_ENCODER.encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  cachedKey = { pepper, promise };
  void promise.then(undefined, () => {
    if (cachedKey?.promise === promise) {
      cachedKey = undefined;
    }
  });
  return promise;
}

const HEX_CHARS = "0123456789abcdef";

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) {
    out += HEX_CHARS.charAt(b >> 4) + HEX_CHARS.charAt(b & 0xf);
  }
  return out;
}

export async function hashClientKey(rawKey: string, pepper: string): Promise<string> {
  const key = await getHmacKey(pepper);
  const signature = await crypto.subtle.sign("HMAC", key, UTF8_ENCODER.encode(rawKey));
  return toHex(new Uint8Array(signature));
}
