import { describe, expect, it } from "vitest";
import {
  relayDecisionShardName,
  relayGrantLifecycleShardName,
  relayRequestUtcDayOf,
  relayShardIndex,
} from "../src/relay-routing";

describe("relay routing", () => {
  it("uses the fixed 64-way FNV-1a shard contract", () => {
    // Given: stable request identifiers used by the Decision Controller.
    // When: their shard indexes are derived.
    // Then: the shared helper preserves the existing padded indexes.
    expect(relayShardIndex("req_01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe("37");
    expect(relayShardIndex("req_01ARZ3NDEKTSV4RRFFQ69G5FAW")).toBe("18");
    expect(relayShardIndex("req_01ARZ3NDEKTSV4RRFFQ69G5FCV")).toMatch(/^\d{2}$/);
  });

  it("preserves the UTF-16 shard assignment for supplementary Unicode IDs", () => {
    // Given: a client identifier containing a supplementary Unicode character.
    // When: its stable FNV shard is calculated.
    // Then: both UTF-16 code units retain the existing shard contract.
    expect(relayShardIndex("client-😀-id")).toBe("54");
  });

  it("uses separate exact decision and lifecycle shard names", () => {
    // Given: a request routed in each relay environment.
    // When: names are generated for both controller namespaces.
    // Then: they share the shard and retain the exact namespace/version form.
    const requestId = "req_01ARZ3NDEKTSV4RRFFQ69G5FAV";
    expect(relayDecisionShardName("preview", requestId)).toBe("relay-decision:v1:preview:37");
    expect(relayGrantLifecycleShardName("preview", requestId)).toBe("relay-grant-lifecycle:v1:preview:37");
    expect(relayDecisionShardName("production", requestId)).toBe("relay-decision:v1:production:37");
    expect(relayGrantLifecycleShardName("production", requestId)).toBe("relay-grant-lifecycle:v1:production:37");
  });

  it("returns the embedded ULID timestamp as a UTC calendar day", () => {
    // Given: a canonical request ID with the known ULID timestamp.
    // When: its embedded timestamp is decoded.
    // Then: the exact UTC day is returned.
    expect(relayRequestUtcDayOf("req_01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe("2016-07-30");
  });

  it("accepts the zero ULID timestamp as the Unix epoch", () => {
    // Given: a canonical request ID with the earliest representable timestamp.
    // When: its embedded timestamp is decoded.
    // Then: the epoch day is returned.
    expect(relayRequestUtcDayOf("req_00000000000000000000000000")).toBe("1970-01-01");
  });

  it.each([
    "req_short",
    "req_81ARZ3NDEKTSV4RRFFQ69G5FAV",
    "req_8ZZZZZZZZZZZZZZZZZZZZZZZZZ",
    "req_7ZZZZZZZZZZZZZZZZZZZZZZZZZ",
  ])("returns no day for invalid or out-of-range request ID %s", (requestId) => {
    // Given: a malformed, overflow, impossible, or out-of-Date-range ULID.
    // When: its timestamp day is requested.
    // Then: no day is produced.
    expect(relayRequestUtcDayOf(requestId)).toBeUndefined();
  });
});
