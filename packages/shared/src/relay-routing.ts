import type { RelayEnvironment } from "./relay.ts";
import { RELAY_REQUEST_ID_PATTERN } from "./relay.ts";

const SHARD_MASK = 63;
const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;
const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_ULID_TIMESTAMP = 281_474_976_710_655;

export const RELAY_INGRESS_ROUTE = "/relay/v1/responses";

export function relayShardIndex(requestId: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < requestId.length; index += 1) {
    hash = Math.imul(hash ^ requestId.charCodeAt(index), FNV_PRIME) >>> 0;
  }
  return String(hash & SHARD_MASK).padStart(2, "0");
}

export function relayDecisionShardName(environment: RelayEnvironment, requestId: string): string {
  return `relay-decision:v1:${environment}:${relayShardIndex(requestId)}`;
}

export function relayGrantLifecycleShardName(environment: RelayEnvironment, requestId: string): string {
  return `relay-grant-lifecycle:v1:${environment}:${relayShardIndex(requestId)}`;
}

export function relayRequestUtcDayOf(requestId: string): string | undefined {
  if (!RELAY_REQUEST_ID_PATTERN.test(requestId)) return undefined;
  const encodedTimestamp = requestId.slice(4, 14);
  if (encodedTimestamp[0] === undefined || CROCKFORD_BASE32.indexOf(encodedTimestamp[0]) > 7) {
    return undefined;
  }

  let timestamp = 0;
  for (const character of encodedTimestamp) {
    const digit = CROCKFORD_BASE32.indexOf(character);
    if (digit < 0) return undefined;
    timestamp = timestamp * 32 + digit;
  }
  if (!Number.isSafeInteger(timestamp) || timestamp > MAX_ULID_TIMESTAMP) return undefined;

  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return undefined;
  const year = date.getUTCFullYear();
  if (year > 9999) return undefined;
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${String(year).padStart(4, "0")}-${month}-${day}`;
}
