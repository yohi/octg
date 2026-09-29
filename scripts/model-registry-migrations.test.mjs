import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const migrationsDirectory = join(root, "db/migrations");

test("D1 migrations register the current GPT-6 family in their quota pools", () => {
  const migrationSql = readdirSync(migrationsDirectory)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => readFileSync(join(migrationsDirectory, file), "utf8"))
    .join("\n");
  const rows = execFileSync("sqlite3", [
    "-json",
    ":memory:",
    `${migrationSql}\nSELECT COALESCE(json_group_array(json_object('model', model, 'provider', provider, 'complimentary_pool', complimentary_pool, 'enabled', enabled)), '[]') AS models FROM (SELECT model, provider, complimentary_pool, enabled FROM model_registry WHERE model LIKE 'gpt-6-%' ORDER BY model);`,
  ], { encoding: "utf8" });

  assert.deepEqual(JSON.parse(JSON.parse(rows)[0].models), [
    { model: "gpt-6-astra", provider: "openai", complimentary_pool: "STANDARD", enabled: 1 },
    { model: "gpt-6-luna", provider: "openai", complimentary_pool: "STANDARD", enabled: 1 },
    { model: "gpt-6-sol", provider: "openai", complimentary_pool: "STANDARD", enabled: 1 },
  ]);
});
