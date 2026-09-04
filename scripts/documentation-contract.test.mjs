import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));

function read(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

test("configuration catalog exposes the documented six-column shape and operating sections", () => {
  const configuration = read("docs/CONFIGURATION.md");

  assert.match(
    configuration,
    /\| Name \| Kind \| Consumer \| Set in \| Obtain or decide \| Apply \|/,
  );
  for (const heading of [
    "## Production/Preview boundary",
    "## Rotation and recovery",
    "## Troubleshooting",
    "## Related procedures",
  ]) {
    assert.match(configuration, new RegExp(`^${heading}$`, "m"));
  }
});

test("Deno local testing command grants the environment permission used by the service", () => {
  const denoDocumentation = read("docs/deno-tokenizer.md");

  assert.doesNotMatch(denoDocumentation, /deno task dev/);
  assert.match(denoDocumentation, /deno run --allow-env --allow-net src\/main\.ts/);
});

test("reader-facing documentation keeps relative links resolvable", () => {
  const documentationFiles = [
    "README.md",
    "docs/CONFIGURATION.md",
    "docs/DEPLOY_FROM_TEMPLATE.md",
    "docs/deno-tokenizer.md",
  ];
  const unresolved = [];

  for (const relativePath of documentationFiles) {
    const content = read(relativePath);
    for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1].split(/[?#]/, 1)[0];
      if (!target || target.startsWith("http://") || target.startsWith("https://") || target.startsWith("mailto:")) {
        continue;
      }

      const targetPath = join(root, relativePath, "..");
      const resolvedPath = join(targetPath, target);
      if (!existsSync(resolvedPath)) {
        unresolved.push(`${relativePath} -> ${target}`);
      }
    }
  }

  assert.deepEqual(unresolved, []);
});
