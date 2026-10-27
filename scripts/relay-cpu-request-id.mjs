import { randomBytes } from "node:crypto";

export function createRequestId(timestamp = Date.now()) {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 281_474_976_710_655) throw new TypeError("Invalid ULID timestamp");
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let time = BigInt(timestamp);
  let prefix = "";
  for (let index = 0; index < 10; index += 1) { prefix = alphabet[Number(time & 31n)] + prefix; time >>= 5n; }
  let entropy = BigInt(`0x${randomBytes(10).toString("hex")}`);
  let suffix = "";
  for (let index = 0; index < 16; index += 1) { suffix = alphabet[Number(entropy & 31n)] + suffix; entropy >>= 5n; }
  return `req_${prefix}${suffix}`;
}
