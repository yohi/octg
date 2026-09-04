// Cache the HMAC key per pepper value so that crypto.subtle.importKey is not
// called on every request.  The pepper is an env binding that is constant for
// the lifetime of the Worker isolate, so a single cached key suffices.
const UTF8_ENCODER = new TextEncoder();
let cachedPepper: string | undefined;
let cachedKey: CryptoKey | undefined;

async function getHmacKey(pepper: string): Promise<CryptoKey> {
  if (cachedKey && cachedPepper === pepper) return cachedKey;
  const key = await crypto.subtle.importKey(
    "raw",
    UTF8_ENCODER.encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  cachedPepper = pepper;
  cachedKey = key;
  return key;
}

const HEX_CHARS = "0123456789abcdef";

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += HEX_CHARS[b >> 4] + HEX_CHARS[b & 0xf];
  }
  return out;
}

export async function hashClientKey(rawKey: string, pepper: string): Promise<string> {
  const key = await getHmacKey(pepper);
  const signature = await crypto.subtle.sign("HMAC", key, UTF8_ENCODER.encode(rawKey));
  return toHex(new Uint8Array(signature));
}
