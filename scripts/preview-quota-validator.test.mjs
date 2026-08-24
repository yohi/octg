import { test } from "node:test";
import { strict as assert } from "node:assert";
import { assertPreviewQuotaAllocation } from "./preview-quota-validator.mjs";

test("accepts bounded production and preview allocations", () => {
  assert.doesNotThrow(() => assertPreviewQuotaAllocation({
    production: { STANDARD: 1_000_000, MINI: 9_950_000 },
    preview: { STANDARD: 0, MINI: 50_000 },
  }));
});

test("rejects an allocation above the STANDARD provider ceiling", () => {
  assert.throws(
    () => assertPreviewQuotaAllocation({
      production: { STANDARD: 1_000_000, MINI: 9_950_000 },
      preview: { STANDARD: 1, MINI: 50_000 },
    }),
    /STANDARD quota allocation exceeds provider ceiling/,
  );
});

test("rejects an allocation above the MINI provider ceiling", () => {
  assert.throws(
    () => assertPreviewQuotaAllocation({
      production: { STANDARD: 1_000_000, MINI: 9_950_000 },
      preview: { STANDARD: 0, MINI: 50_001 },
    }),
    /MINI quota allocation exceeds provider ceiling/,
  );
});
