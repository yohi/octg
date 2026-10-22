import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fetchRelayCpuTelemetry } from "./relay-cpu-telemetry.mjs";

test("queries invocations and completeness with Bearer env auth and writes protected normalized exports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relay-cpu-"));
  try {
    const calls = [];
    const result = await fetchRelayCpuTelemetry({
      scriptName: "octg-preview",
      expectedScriptVersionId: "candidate-v1",
      expectedExecutionModel: "stateless",
      windows: [{ windowStartMs: 100, windowEndMs: 200 }],
      outputPath: join(directory, "records.jsonl"),
      metaOutputPath: join(directory, "meta.json"),
      env: { CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_API_TOKEN: "synthetic-token" },
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body);
        calls.push({ url: String(_url), headers: init.headers, body });
        const resultBody = body.queryId.endsWith("invocations-v1")
          ? (body.parameters.offset ? { invocations: {} } : { invocations: { group: [{
              $metadata: { id: "cursor", eventTimestampMs: 120, url: "https://host/v1/responses" },
              $workers: { scriptName: "octg-preview", scriptVersion: { id: "candidate-v1" }, cpuTimeMs: 3, outcome: "ok", eventType: "cpu", executionModel: "stateless" },
            }] } })
          : { calculations: [{ alias: "platform_invocation_count", sampleInterval: 1, value: 1 }] };
        return Response.json({ success: true, result: resultBody });
      },
    });
    assert.equal(calls.length, 3);
    assert.equal(calls[0].headers.Authorization, "Bearer synthetic-token");
    assert.equal(calls[0].headers["X-Auth-Key"], undefined);
    assert.equal(calls[0].body.view, "invocations");
    assert.equal(calls.at(-1).body.view, "calculations");
    assert.equal(result.meta.samplingVerified, true);
    assert.equal((await stat(join(directory, "records.jsonl"))).mode & 0o777, 0o600);
    assert.equal(JSON.parse((await readFile(join(directory, "records.jsonl"), "utf8")).trim()).cpuTimeMs, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
