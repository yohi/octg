import { test } from "node:test";
import { strict as assert } from "node:assert";
import { resolvePreviewDatabaseId } from "./preview-d1-resolver.mjs";

const databases = JSON.stringify([
  { name: "other-db", uuid: "11111111-1111-4111-8111-111111111111" },
  { name: "octg-gateway-preview-db", uuid: "814c8fdb-dc9d-4a83-9065-001729ccd169" },
]);

test("resolves the UUID for a uniquely named preview database", () => {
  assert.equal(
    resolvePreviewDatabaseId(databases, "octg-gateway-preview-db"),
    "814c8fdb-dc9d-4a83-9065-001729ccd169",
  );
});

test("returns undefined when the preview database is absent", () => {
  assert.equal(resolvePreviewDatabaseId(databases, "missing-db"), undefined);
});

test("rejects duplicate preview database names", () => {
  assert.throws(
    () => resolvePreviewDatabaseId(JSON.stringify([
      { name: "duplicate", uuid: "11111111-1111-4111-8111-111111111111" },
      { name: "duplicate", uuid: "22222222-2222-4222-8222-222222222222" },
    ]), "duplicate"),
    /multiple databases named duplicate/,
  );
});
