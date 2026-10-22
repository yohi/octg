import { strict as assert } from "node:assert";
import { test } from "node:test";
import { WORKLOAD_CLASSES, CONCURRENCIES, buildWorkload, requiredSeriesMatrix } from "./relay-cpu-workloads.mjs";

test("builds deterministic credential-free workload classes", () => {
  assert.deepEqual(WORKLOAD_CLASSES, ["baseline-small", "baseline-large", "incident-regression-stream", "incident-regression-nonstream"]);
  for (const workloadClass of WORKLOAD_CLASSES) {
    const first = buildWorkload(workloadClass);
    assert.deepEqual(first, buildWorkload(workloadClass));
    assert.equal(JSON.stringify(first).includes("Authorization"), false);
    assert.equal(JSON.stringify(first).includes("octg_sk_"), false);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(buildWorkload("baseline-large"))) >= 700 * 1024);
  assert.equal(buildWorkload("incident-regression-stream").stream, true);
  assert.equal(buildWorkload("incident-regression-nonstream").stream, false);
});

test("defines concurrency and the full required series matrix", () => {
  assert.deepEqual(CONCURRENCIES, [1, 2, 3]);
  assert.equal(requiredSeriesMatrix().length, 68);
});
