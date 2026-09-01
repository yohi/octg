import { test } from "node:test";
import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import {
  classifyBuildLogs,
  classifyCliOutput,
  classifyRuntimeLogs,
  extractRevision,
  readDiagnosticFile,
  summarizeDeploymentFailure,
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

test("classifies a missing tokenizer runtime secret without returning build logs", async () => {
  const result = await classifyBuildLogs({
    revision: "revision-id",
    token: "test-token",
    fetchImpl: async () => new Response(
      "Invalid Deno tokenizer configuration: OCTG_TOKENIZER_AUTH_TOKEN is missing\n",
    ),
  });

  assert.deepEqual(result, {
    categories: ["runtime_configuration"],
    truncated: false,
  });
});

test("classifies an import-map resolution failure", async () => {
  const result = await classifyBuildLogs({
    revision: "revision-id",
    token: "test-token",
    fetchImpl: async () => new Response(
      'Relative import path "@octg/shared" not in import map\n',
    ),
  });

  assert.deepEqual(result, {
    categories: ["module_resolution"],
    truncated: false,
  });
});

test("summarizes a matching revision failure reason without returning it", () => {
  const result = summarizeDeploymentFailure({
    revision: "revision-id",
    output: JSON.stringify({
      revisions: [{
        id: "revision-id",
        status: "failed",
        failure_reason: 'Relative import path "@octg/shared" not in import map',
      }],
    }),
  });

  assert.deepEqual(result, {
    status: "failed",
    categories: ["module_resolution"],
  });
  assert.equal("failure_reason" in result, false);
});

test("summarizes the deployments API item shape", () => {
  const result = summarizeDeploymentFailure({
    revision: "revision-id",
    output: JSON.stringify({
      items: [{
        revision: "revision-id",
        status: "failed",
        failureReason: "entrypoint could not be resolved",
      }],
    }),
  });

  assert.deepEqual(result, {
    status: "failed",
    categories: ["entrypoint"],
  });
});

test("classifies CLI failure output without returning the output", () => {
  const result = classifyCliOutput(JSON.stringify({
    error: { message: "permission denied while collecting source files" },
  }));

  assert.deepEqual(result, { categories: ["permission"] });
});

test("restricts CLI diagnostic files to trusted working directories", () => {
  assert.match(readDiagnosticFile(resolve("package.json")), /"name": "octg"/);
  assert.throws(
    () => readDiagnosticFile(resolve("/")),
    /outside an allowed directory/,
  );
});

test("classifies only runtime logs for the failed revision", () => {
  const result = classifyRuntimeLogs({
    revision: "revision-id",
    output: [
      JSON.stringify({
        revision: "other-revision",
        body: "Invalid Deno tokenizer configuration: OCTG_TOKENIZER_AUTH_TOKEN is missing",
      }),
      JSON.stringify({
        revision: "revision-id",
        body: "Invalid Deno tokenizer configuration: OCTG_TOKENIZER_AUTH_TOKEN is missing",
      }),
    ].join("\n"),
  });

  assert.deepEqual(result, {
    categories: ["runtime_configuration"],
    truncated: false,
  });
  assert.equal("output" in result, false);
});

test("classifies documented runtime log fields for the failed revision", () => {
  const result = classifyRuntimeLogs({
    revision: "revision-id",
    output: JSON.stringify({
      revision_id: "revision-id",
      message: "Invalid Deno tokenizer configuration: OCTG_TOKENIZER_AUTH_TOKEN is missing",
    }),
  });

  assert.deepEqual(result, {
    categories: ["runtime_configuration"],
    truncated: false,
  });
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
