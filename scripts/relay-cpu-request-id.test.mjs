import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createRequestId } from "./relay-cpu-request-id.mjs";

test("runner ULIDs encode the current timestamp in canonical big-endian order", () => {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const timestamp = Date.parse("2026-10-24T12:34:56Z");
  const id = createRequestId(timestamp);
  assert.match(id, /^req_[0-9A-HJKMNP-TV-Z]{26}$/);
  const decoded = [...id.slice(4, 14)].reduce((value, letter) => value * 32n + BigInt(alphabet.indexOf(letter)), 0n);
  assert.equal(Number(decoded), timestamp);
  assert.notEqual(createRequestId(timestamp), id);
});
