import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fetchRelayCpuTelemetry, INVOCATIONS_QUERY_ID, COMPLETENESS_QUERY_ID } from "./relay-cpu-telemetry.mjs";

function cpuEvent(overrides = {}) {
  return {
    $metadata: { id: "cursor", eventTimestampMs: 120, url: "https://host/v1/responses" },
    $workers: {
      scriptName: "octg-preview",
      scriptVersion: { id: "candidate-v1" },
      cpuTimeMs: 3,
      outcome: "ok",
      eventType: "cpu",
      executionModel: "stateless",
    },
    ...overrides,
  };
}

function invocationsResult(groups) {
  return { success: true, result: { run: { status: "COMPLETED" }, statistics: {}, invocations: Object.fromEntries(groups.map((events, index) => [`group-${events.find((event) => event.$workers?.cpuTimeMs !== undefined)?.$metadata?.id ?? index}`, events])) } };
}

function calculationsResult(value, sampleInterval = 1) {
  return { success: true, result: { run: { status: "COMPLETED" }, statistics: {}, calculations: [{ alias: "platform_invocation_count", calculation: "uniq", series: [], aggregates: [{ count: value, interval: sampleInterval, sampleInterval, value }] }] } };
}

const WINDOW = { windowStartMs: 100, windowEndMs: 200 };

function baseOptions(overrides = {}) {
  return {
    scriptName: "octg-preview",
    expectedScriptVersionId: "candidate-v1",
    expectedExecutionModel: "stateless",
    windows: [WINDOW],
    outputPath: undefined,
    metaOutputPath: undefined,
    env: { CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_API_TOKEN: "synthetic-token" },
    ...overrides,
  };
}

test("queries invocations and completeness with Bearer env auth and writes protected normalized exports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relay-cpu-"));
  try {
    const calls = [];
    const result = await fetchRelayCpuTelemetry(baseOptions({
      outputPath: join(directory, "records.jsonl"),
      metaOutputPath: join(directory, "meta.json"),
      fetchImpl: async (url, init) => {
        const body = JSON.parse(init.body);
        calls.push({ url: String(url), headers: init.headers, body });
        const resultBody = body.queryId.endsWith("invocations-v1")
          ? (body.offset ? invocationsResult([]) : invocationsResult([[cpuEvent()]]))
          : calculationsResult(1);
        return Response.json(resultBody);
      },
    }));
    assert.equal(calls.length, 3);
    assert.equal(calls[0].headers.Authorization, "Bearer synthetic-token");
    assert.equal(calls[0].headers["X-Auth-Key"], undefined);
    assert.equal(calls[0].headers["X-Auth-Email"], undefined);
    assert.equal(calls[0].body.queryId, INVOCATIONS_QUERY_ID);
    assert.equal(calls.at(-1).body.queryId, COMPLETENESS_QUERY_ID);
    assert.equal(calls.at(-1).body.chartType, "aggregate");
    assert.equal(calls.at(-1).body.ignoreSeries, true);
    assert.equal(calls.at(-1).body.calculationsMode, undefined);
    assert.equal(result.meta.samplingVerified, true);
    assert.equal(result.meta.paginationComplete, true);
    assert.equal(result.meta.truncationObserved, false);
    assert.equal(result.meta.queryComplete, true);
    assert.equal(result.meta.normalizedInvocationCount, 1);
    assert.equal((await stat(join(directory, "records.jsonl"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, "meta.json"))).mode & 0o777, 0o600);
    assert.equal(JSON.parse((await readFile(join(directory, "records.jsonl"), "utf8")).trim()).cpuTimeMs, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a repeated pagination page with zero new event IDs proves completion", async () => {
  const pages = [
    invocationsResult([[cpuEvent({ $metadata: { id: "cursor-1", eventTimestampMs: 120, url: "https://host/v1/responses" } })]]),
    invocationsResult([[cpuEvent({ $metadata: { id: "cursor-2", eventTimestampMs: 130, url: "https://host/v1/responses" } })]]),
    invocationsResult([[cpuEvent({ $metadata: { id: "cursor-2", eventTimestampMs: 130, url: "https://host/v1/responses" } })]]),
  ];
  let calculationsQueries = 0;
  const result = await fetchRelayCpuTelemetry(baseOptions({
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.queryId.endsWith("invocations-v1")) {
        // The final page can overlap a previous page. Completeness is proven by
        // the zero-new-event condition, even when its cursor repeats.
        return Response.json(pages.shift() ?? invocationsResult([]));
      }
      calculationsQueries += 1;
      return Response.json(calculationsResult(2));
    },
  }));
  assert.equal(calculationsQueries, 1);
  assert.equal(result.meta.paginationComplete, true);
  assert.equal(result.meta.samplingVerified, true);
  assert.equal(result.meta.normalizedInvocationCount, 2);
});

test("de-duplicates exact duplicate event ids once and rejects conflicting duplicates", async () => {
  const duplicate = cpuEvent();
  const result = await fetchRelayCpuTelemetry(baseOptions({
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.queryId.endsWith("invocations-v1")) {
        // Same event id in two different invocation groups: deduped to one record.
        return Response.json(body.offset
          ? invocationsResult([])
          : invocationsResult([[duplicate, duplicate]]));
      }
      return Response.json(calculationsResult(1));
    },
  }));
  assert.equal(result.meta.normalizedInvocationCount, 1);
  assert.equal(result.records.length, 1);

  await assert.rejects(
    fetchRelayCpuTelemetry(baseOptions({
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body);
        if (body.queryId.endsWith("invocations-v1")) {
          return Response.json(body.offset
            ? invocationsResult([])
            : invocationsResult([[duplicate, cpuEvent({ $workers: cpuEvent().$workers, $metadata: { id: "cursor", eventTimestampMs: 190, url: "https://host/v1/responses" } })]]));
        }
        return Response.json(calculationsResult(2));
      },
    })),
    /Conflicting duplicate/,
  );
});

test("rejects marker identity contradictions and missing required CPU fields", async () => {
  for (const event of [
    cpuEvent({ $metadata: { ...cpuEvent().$metadata, id: "marker", requestId: "wrong" }, $workers: { ...cpuEvent().$workers, cpuTimeMs: undefined } }),
    cpuEvent({ $workers: { ...cpuEvent().$workers, scriptVersion: undefined } }),
    cpuEvent({ $workers: { ...cpuEvent().$workers, executionModel: undefined } }),
    cpuEvent({ $workers: { ...cpuEvent().$workers, cpuTimeMs: NaN } }),
    cpuEvent({ $metadata: { ...cpuEvent().$metadata, id: undefined } }),
  ]) {
    await assert.rejects(fetchRelayCpuTelemetry(baseOptions({
      fetchImpl: async (_url, init) => Response.json(JSON.parse(init.body).view === "invocations"
        ? invocationsResult([[event, cpuEvent()]]) : calculationsResult(1)),
    })));
  }
});

const outsideScopes = [
  ["before the window", { timestamp: 99 }],
  ["at the exclusive window end", { timestamp: 200 }],
  ["another script", { $workers: { scriptName: "other-worker" } }],
  ["another version", { $workers: { scriptVersion: { id: "other-version" } } }],
  ["another execution model", { $workers: { executionModel: "durableObject" } }],
];

function outsideMarker(overrides, identityField, requestId) {
  const marker = cpuEvent({ ...overrides,
    $metadata: { ...cpuEvent().$metadata, id: "outside-marker" },
    $workers: { ...cpuEvent().$workers, ...overrides.$workers, cpuTimeMs: undefined },
  });
  if (identityField) marker[identityField].requestId = requestId;
  return marker;
}

for (const [scope, overrides] of outsideScopes) {
  for (const identityField of ["$metadata", "$workers"]) {
    test(`rejects ${identityField} identity contradictions on markers ${scope}`, async () => {
      const marker = outsideMarker(overrides, identityField, "wrong-group");
      await assert.rejects(fetchRelayCpuTelemetry(baseOptions({
        fetchImpl: async (_url, init) => Response.json(JSON.parse(init.body).view === "invocations"
          ? invocationsResult([[cpuEvent(), marker]]) : calculationsResult(1)),
      })), /Invocation request identity contradiction/);
    });
  }
}

test("still filters out-of-scope markers with absent or consistent identity", async () => {
  for (const [, overrides] of outsideScopes) {
    for (const identityField of [undefined, "$metadata", "$workers"]) {
      const marker = outsideMarker(overrides, identityField, "group-cursor");
      const result = await fetchRelayCpuTelemetry(baseOptions({
        fetchImpl: async (_url, init) => {
          const query = JSON.parse(init.body);
          return Response.json(query.view === "invocations"
            ? invocationsResult(query.offset ? [] : [[cpuEvent(), marker]]) : calculationsResult(1));
        },
      }));
      assert.equal(result.records.length, 1);
      assert.equal(result.meta.queryComplete, true);
      assert.equal(result.meta.samplingVerified, true);
    }
  }
});

test("rejects unknown CLI arguments instead of accepting token arguments", async () => {
  const { runTelemetryCli } = await import("./relay-cpu-telemetry.mjs");
  await assert.rejects(runTelemetryCli(["--token=synthetic"]), /Unknown/);
});

test("rejects conflicting CPU events split across pages of the same invocation group", async () => {
  await assert.rejects(fetchRelayCpuTelemetry(baseOptions({
    fetchImpl: async (_url, init) => {
      const query = JSON.parse(init.body);
      const event = query.offset ? cpuEvent({ $metadata: { ...cpuEvent().$metadata, id: "second-cpu" } }) : cpuEvent();
      return Response.json({ ...invocationsResult([]), result: { ...invocationsResult([]).result, invocations: { oneInvocation: [event] } } });
    },
  })), /CPU event/);
});

test("detects $workers.truncated on any in-scope event, not only the chosen CPU event", async () => {
  const pages = [
    invocationsResult([[
      // In-scope non-CPU marker event carrying the truncation fact.
      cpuEvent({ $workers: { scriptName: "octg-preview", scriptVersion: { id: "candidate-v1" }, eventType: "fetch", outcome: "ok", executionModel: "stateless", truncated: true }, $metadata: { id: "cursor-truncated", eventTimestampMs: 150, url: "https://host/v1/responses" } }),
      cpuEvent(),
    ]]),
  ];
  const result = await fetchRelayCpuTelemetry(baseOptions({
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.queryId.endsWith("invocations-v1")) {
        return Response.json(body.offset ? invocationsResult([]) : pages[0]);
      }
      return Response.json(calculationsResult(1));
    },
  }));
  assert.equal(result.meta.truncationObserved, true);
  assert.equal(result.meta.windows[0].truncationObserved, true);
  assert.equal(result.meta.samplingVerified, false);
  // The truncated CPU event itself is also detected.
  const truncatedSelf = await fetchRelayCpuTelemetry(baseOptions({
    fetchImpl: async () => Response.json(invocationsResult([[
      cpuEvent({ $workers: { ...cpuEvent().$workers, truncated: true } }),
    ]])),
  }));
  assert.equal(truncatedSelf.meta.truncationObserved, true);
});

test("rejects a page without a usable final event ID instead of silently passing", async () => {
  // A page that returns new events without a usable final cursor cannot prove
  // complete retrieval: the sidecar must report paginationComplete=false.
  const firstPage = {
    success: true,
    result: { run: { status: "COMPLETED" }, statistics: {}, invocations: { group: [
      cpuEvent(),
      // The FINAL event of the page has no usable $metadata.id cursor.
      cpuEvent({ $metadata: { eventTimestampMs: 150, url: "https://host/v1/responses" } }),
    ] } },
  };
  await assert.rejects(fetchRelayCpuTelemetry(baseOptions({
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.queryId.endsWith("invocations-v1")) return Response.json(firstPage);
      return Response.json(calculationsResult(1));
    },
  })), /event ID unavailable/);
});

test("blocks sampled or unverifiable platform counts via queryComplete", async () => {
  const sampled = await fetchRelayCpuTelemetry(baseOptions({
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      return Response.json(body.queryId.endsWith("invocations-v1")
        ? invocationsResult([[cpuEvent()]])
        : calculationsResult(1, 2));
    },
  }));
  assert.equal(sampled.meta.windows[0].sampleInterval, 2);
  assert.equal(sampled.meta.samplingVerified, false);

  const unverifiable = await fetchRelayCpuTelemetry(baseOptions({
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      return Response.json(body.queryId.endsWith("invocations-v1")
        ? invocationsResult([[cpuEvent()]])
        : calculationsResult(null));
    },
  }));
  assert.equal(unverifiable.meta.queryComplete, false);
  assert.equal(unverifiable.meta.windows[0].platformInvocationCount, null);
  assert.equal(unverifiable.meta.samplingVerified, false);
});

test("matches per-window platform Invocation counts across two windows", async () => {
  const result = await fetchRelayCpuTelemetry(baseOptions({
    windows: [{ windowStartMs: 100, windowEndMs: 200 }, { windowStartMs: 200, windowEndMs: 300 }],
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.queryId.endsWith("invocations-v1")) {
        if (!body.offset) {
          return Response.json(invocationsResult([[cpuEvent({ $metadata: { id: "c1", eventTimestampMs: 120, url: "https://host/v1/responses" } })]]));
        }
        if (body.offset === "c1") {
          return Response.json(invocationsResult([[cpuEvent({ $metadata: { id: "c2", eventTimestampMs: 250, url: "https://host/v1/responses" } })]]));
        }
        return Response.json(invocationsResult([]));
      }
      return Response.json(calculationsResult(1));
    },
  }));
  assert.equal(result.meta.windows[0].platformInvocationCount, 1);
  assert.equal(result.meta.windows[1].platformInvocationCount, 1);
  assert.equal(result.meta.normalizedInvocationCount, 2);
  assert.equal(result.meta.samplingVerified, true);
});

test("unfinished queries and adaptive database sampling cannot establish complete telemetry", async () => {
  for (const changes of [
    { run: { status: "STARTED" } }, { run: undefined },
    { statistics: { abr_level: 2 } }, { statistics: undefined },
  ]) {
    await assert.rejects(fetchRelayCpuTelemetry(baseOptions({
      fetchImpl: async () => Response.json({ success: true, result: { ...invocationsResult([]).result, ...changes } }),
    })), /incomplete|sampled/);
  }
});

test("uses the Cloudflare query wire contract and nested calculation aggregates", async () => {
  const queries = [];
  const event = cpuEvent();
  delete event.$metadata.eventTimestampMs;
  event.timestamp = 120;
  const result = await fetchRelayCpuTelemetry(baseOptions({
    fetchImpl: async (_url, init) => {
      const query = JSON.parse(init.body);
      queries.push(query);
      assert.deepEqual(query.timeframe, { from: 100, to: 200 });
      assert.deepEqual(query.parameters.datasets, ["cloudflare-workers"]);
      assert.ok(query.parameters.filters.every((filter) => filter.type === "string"));
      assert.equal(query.parameters.timeFilter, undefined);
      assert.equal(query.parameters.offset, undefined);
      if (query.view === "invocations") {
        assert.equal(query.limit, 2000);
        if (query.offset) {
          assert.equal(query.offset, "cursor");
          assert.equal(query.offsetDirection, "next");
        }
        return Response.json(invocationsResult(query.offset ? [] : [[event]]));
      }
      return Response.json({ success: true, result: {
        run: { status: "COMPLETED" }, statistics: { abr_level: 1 },
        calculations: [{ alias: "platform_invocation_count", calculation: "uniq", series: [],
          aggregates: [{ count: 1, interval: 1, sampleInterval: 1, value: 1 }] }],
      } });
    },
  }));
  assert.equal(queries.length, 3);
  assert.equal(result.records[0].eventTimestampMs, 120);
  assert.equal(result.meta.samplingVerified, true);
});
