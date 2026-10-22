import { strict as assert } from "node:assert";
import { test } from "node:test";
import { evaluateCpuSeries } from "./relay-cpu-evidence.mjs";

test("passes only complete unsampled series satisfying the 5/7/0 gate", () => {
  const records = [{ eventId: "e1", requestId: "platform-id", eventTimestampMs: 110, scriptName: "worker", scriptVersionId: "v1", cpuTimeMs: 5, outcome: "ok", eventType: "cpu", routeDiscriminator: "/v1/responses", executionModel: "stateless" }];
  const metadata = { version: 1, samplingVerified: true, normalizedInvocationCount: 1, paginationComplete: true, truncationObserved: false, queryComplete: true, windows: [{ windowStartMs: 100, windowEndMs: 200, paginationComplete: true, truncationObserved: false, sampleInterval: 1, platformInvocationCount: 1 }] };
  const expected = { candidateScriptVersion: "v1", invocationClass: "ingress", expectedSuccessfulInvocations: 1, calls: [{ callOrdinal: 1, timestampMs: 110, routeDiscriminator: "/v1/responses", outcomeHint: "success" }] };
  assert.equal(evaluateCpuSeries(records, metadata, expected).status, "PASS");
  assert.equal(evaluateCpuSeries(records, { ...metadata, samplingVerified: false }, expected).status, "BLOCKED");
});
