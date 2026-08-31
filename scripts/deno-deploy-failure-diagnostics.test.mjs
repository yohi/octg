import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  classifyBuildLogs,
  extractRevision,
} from "./deno-deploy-failure-diagnostics.mjs";

test("extracts a revision from the structured Deno Deploy error hint", () => {
  const output = [
    "Download https://jsr.io/@deno/deploy/meta.json",
    JSON.stringify({
      error: {
        code: "REVISION_FAILED",
        hint: "View https://console.deno.com/yohi/octg/builds/opaque-id._~+ for details.",
      },
    }),
  ].join("\n");

  assert.equal(extractRevision(output), "opaque-id._~+");
});

test("ignores unstructured URLs and non-console hints", () => {
  const output = [
    "https://console.deno.com/yohi/octg/builds/not-structured",
    JSON.stringify({
      error: {
        hint: "View https://example.test/yohi/octg/builds/not-allowed for details.",
      },
    }),
  ].join("\n");

  assert.equal(extractRevision(output), undefined);
});

test("classifies bounded build logs without returning their contents", async () => {
  let requestedUrl;
  let requestedAuthorization;
  let requestedOrganization;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        "build failed: Cannot find module in node_modules\n",
      ));
      controller.close();
    },
  });

  const result = await classifyBuildLogs({
    revision: "opaque-id._~+",
    token: "test-token",
    organization: "yohi",
    fetchImpl: async (url, init) => {
      requestedUrl = url;
      requestedAuthorization = init?.headers?.authorization;
      requestedOrganization = init?.headers?.["x-deno-org"];
      return new Response(body, {
        headers: { "content-type": "application/x-ndjson" },
      });
    },
  });

  assert.deepEqual(result, {
    categories: ["node_modules", "module_resolution"],
    truncated: false,
  });
  assert.equal(
    requestedUrl,
    "https://console.deno.com/api/v2/revisions/opaque-id._~%2B/build_logs",
  );
  assert.equal(requestedAuthorization, "Bearer test-token");
  assert.equal(requestedOrganization, "yohi");
  assert.equal("logs" in result, false);
});

test("limits build-log reads to one mebibyte", async () => {
  const result = await classifyBuildLogs({
    revision: "revision-id",
    token: "test-token",
    fetchImpl: async () => new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024));
          controller.enqueue(new Uint8Array(1));
          controller.close();
        },
      }),
    ),
  });

  assert.equal(result.truncated, true);
});
