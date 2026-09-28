import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import type { RelayTerminalV1 } from "@octg/shared";
import {
  relayUpstreamResponse,
  RelayUpstreamDeliveryError,
  type RelayGrantSession,
} from "../src/relay-usage.ts";

const grantId = "0123abcd-0000-4000-8000-000000000001";
const leaseGeneration = "0123abcd-0000-4000-8000-000000000002";

const eventStreamContentType = "text/event-stream";
const jsonContentType = "application/json";

/** Interval large enough that renewal never fires inside a test unless 1 ms is chosen. */
const quiescentRenewalIntervalMs = 60_000;

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  const { promise, resolve } = Promise.withResolvers<T>();
  return { promise, resolve };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function sseBody(chunks: readonly string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

/** Held-open source that records cancellation and closes only on demand. */
function heldSseBody(): {
  readonly source: ReadableStream<Uint8Array>;
  readonly close: () => void;
  readonly cancelled: Promise<void>;
} {
  const cancelled = deferred<void>();
  const controllerHolder: { controller?: ReadableStreamDefaultController<Uint8Array> } = {};
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerHolder.controller = controller;
      controller.enqueue(encoder.encode("event: response.created\ndata: {\"type\":\"response.created\"}\n\n"));
    },
    cancel() {
      cancelled.resolve();
    },
  });
  return {
    source,
    close: () => controllerHolder.controller?.close(),
    cancelled: cancelled.promise,
  };
}

interface RecordedReport {
  readonly report: RelayTerminalV1;
}

function sessionFixture(overrides: {
  readonly renewLease?: () => Promise<void>;
  readonly renewalIntervalMs?: number;
} = {}): RelayGrantSession {
  return {
    grantId,
    leaseGeneration,
    renewLease: overrides.renewLease ?? (() => Promise.resolve()),
    renewalIntervalMs: overrides.renewalIntervalMs ?? quiescentRenewalIntervalMs,
  };
}

function collector(reports: RecordedReport[], onTerminalThrows = false): (report: RelayTerminalV1) => Promise<void> {
  return (report) => {
    reports.push({ report });
    if (onTerminalThrows) return Promise.reject(new Error("terminal callback transport down"));
    return Promise.resolve();
  };
}

function completedEvent(totalTokens: number): string {
  return `event: response.completed\ndata: ${JSON.stringify({
    type: "response.completed",
    response: { id: "resp_1", usage: { input_tokens: 11, output_tokens: totalTokens - 11, total_tokens: totalTokens } },
  })}\n\n`;
}

async function drainBytes(response: Response): Promise<string> {
  return decoder.decode(await response.arrayBuffer());
}

async function readOneChunk(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("response has no body");
  const chunk = await reader.read();
  if (chunk.done) throw new Error("stream ended before the first chunk");
  await reader.cancel();
  return decoder.decode(chunk.value);
}

Deno.test("forwards SSE bytes unchanged and settles fragmented usage exactly once", async () => {
  const completed = completedEvent(33);
  const cut = Math.floor(completed.length / 2);
  const chunks = [
    "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n",
    completed.slice(0, cut),
    completed.slice(cut),
  ];
  const expectedBytes = chunks.join("");
  const reports: RecordedReport[] = [];
  const upstream = new Response(sseBody(chunks), {
    status: 200,
    headers: { "content-type": eventStreamContentType },
  });

  const response = await relayUpstreamResponse(upstream, collector(reports), sessionFixture());

  assertEquals(response.status, 200);
  assertEquals(response.headers.get("content-type"), eventStreamContentType);
  assertEquals(await drainBytes(response), expectedBytes);
  assertEquals(reports.length, 1);
  assertEquals(reports[0]?.report, {
    version: 1,
    grantId,
    leaseGeneration,
    outcome: "settle",
    totalTokens: 33,
  });
});

Deno.test("settles usage after a large non-usage event scrolls out of the bounded tail", async () => {
  const largeDelta = `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"${"x".repeat(40_000)}"}\n\n`;
  const chunks = [largeDelta, completedEvent(44)];
  const reports: RecordedReport[] = [];
  const upstream = new Response(sseBody(chunks), {
    status: 200,
    headers: { "content-type": eventStreamContentType },
  });

  const response = await relayUpstreamResponse(upstream, collector(reports), sessionFixture());

  assertEquals((await drainBytes(response)).length, chunks.join("").length);
  assertEquals(reports.length, 1);
  assertEquals(reports[0]?.report.outcome, "settle");
  assertEquals(reports[0]?.report.totalTokens, 44);
});

Deno.test("reports uncertain when usage is fragmented beyond the bounded tail", async () => {
  const completed = completedEvent(55);
  // Split inside the usage object so no complete snippet survives the gap.
  const cut = completed.indexOf('"usage":') + 12;
  const chunks = [completed.slice(0, cut), `data: ${"y".repeat(32_768)}\n\n`, completed.slice(cut)];
  const reports: RecordedReport[] = [];
  const upstream = new Response(sseBody(chunks), {
    status: 200,
    headers: { "content-type": eventStreamContentType },
  });

  const response = await relayUpstreamResponse(upstream, collector(reports), sessionFixture());

  assertEquals(await drainBytes(response), chunks.join(""));
  assertEquals(reports.length, 1);
  assertEquals(reports[0]?.report, {
    version: 1,
    grantId,
    leaseGeneration,
    outcome: "uncertain",
    totalTokens: null,
  });
});

Deno.test("reports uncertain when the stream ends without final usage", async () => {
  const chunks = [
    "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n",
    "data: [DONE]\n\n",
  ];
  const reports: RecordedReport[] = [];
  const upstream = new Response(sseBody(chunks), {
    status: 200,
    headers: { "content-type": eventStreamContentType },
  });

  const response = await relayUpstreamResponse(upstream, collector(reports), sessionFixture());

  await drainBytes(response);
  assertEquals(reports.length, 1);
  assertEquals(reports[0]?.report.outcome, "uncertain");
  assertEquals(reports[0]?.report.totalTokens, null);
});

Deno.test("reports uncertain when extracted usage is not a safe non-negative integer", async () => {
  const invalidUsageValues: readonly unknown[] = [-5, 1.5, "30"];
  for (const totalTokens of invalidUsageValues) {
    const reports: RecordedReport[] = [];
    const event = `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: { usage: { total_tokens: totalTokens } },
    })}\n\n`;
    const upstream = new Response(sseBody([event]), {
      status: 200,
      headers: { "content-type": eventStreamContentType },
    });

    const response = await relayUpstreamResponse(upstream, collector(reports), sessionFixture());

    await drainBytes(response);
    assertEquals(reports.length, 1);
    assertEquals(reports[0]?.report.outcome, "uncertain");
  }
});

Deno.test("streams bytes before the upstream closes instead of full-buffering", async () => {
  const held = heldSseBody();
  const reports: RecordedReport[] = [];
  const upstream = new Response(held.source, {
    status: 200,
    headers: { "content-type": eventStreamContentType },
  });

  const response = await relayUpstreamResponse(upstream, collector(reports), sessionFixture());
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("response has no body");
  const firstChunk = await reader.read();

  assertEquals(decoder.decode(firstChunk.value ?? new Uint8Array()).includes("response.created"), true);
  assertEquals(reports.length, 0);
  held.close();
  while (!(await reader.read()).done) {
    // drain the forwarded stream
  }
  assertEquals(reports.length, 1);
  assertEquals(reports[0]?.report.outcome, "uncertain");
});

Deno.test("reports uncertain once on client disconnect without cancelling the reservation", async () => {
  const held = heldSseBody();
  const reports: RecordedReport[] = [];
  const upstream = new Response(held.source, {
    status: 200,
    headers: { "content-type": eventStreamContentType },
  });

  const response = await relayUpstreamResponse(upstream, collector(reports), sessionFixture());
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("response has no body");
  await reader.read();
  await reader.cancel();

  await held.cancelled;
  assertEquals(reports.length, 1);
  assertEquals(reports[0]?.report, {
    version: 1,
    grantId,
    leaseGeneration,
    outcome: "uncertain",
    totalTokens: null,
  });
});

Deno.test("aborts the upstream stream and reports uncertain once when lease renewal fails", async () => {
  const held = heldSseBody();
  const reports: RecordedReport[] = [];
  const upstream = new Response(held.source, {
    status: 200,
    headers: { "content-type": eventStreamContentType },
  });

  const response = await relayUpstreamResponse(
    upstream,
    collector(reports),
    sessionFixture({
      renewLease: () => Promise.reject(new Error("renewal callback failed")),
      renewalIntervalMs: 1,
    }),
  );

  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("response has no body");
  await reader.read();
  await assertRejects(() => reader.read());
  await held.cancelled;

  assertEquals(reports.length, 1);
  assertEquals(reports[0]?.report, {
    version: 1,
    grantId,
    leaseGeneration,
    outcome: "uncertain",
    totalTokens: null,
  });
});

Deno.test("renews the lease while the upstream stream stays open and settles once on completion", async () => {
  const held = heldSseBody();
  const firstRenewal = deferred<void>();
  let renewalCount = 0;
  const reports: RecordedReport[] = [];
  const upstream = new Response(held.source, {
    status: 200,
    headers: { "content-type": eventStreamContentType },
  });

  const response = await relayUpstreamResponse(
    upstream,
    collector(reports),
    sessionFixture({
      renewLease: () => {
        renewalCount += 1;
        firstRenewal.resolve();
        return Promise.resolve();
      },
      renewalIntervalMs: 1,
    }),
  );

  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("response has no body");
  await reader.read();
  await firstRenewal.promise;
  held.close();
  while (!(await reader.read()).done) {
    // drain the forwarded stream
  }
  assertEquals(renewalCount >= 1, true);
  assertEquals(reports.length, 1);
  assertEquals(reports[0]?.report.outcome, "uncertain");
});

Deno.test("keeps the response intact when the terminal callback fails", async () => {
  const chunks = [completedEvent(66)];
  const reports: RecordedReport[] = [];
  const upstream = new Response(sseBody(chunks), {
    status: 200,
    headers: { "content-type": eventStreamContentType },
  });

  const response = await relayUpstreamResponse(
    upstream,
    collector(reports, true),
    sessionFixture(),
  );

  assertEquals(await drainBytes(response), chunks.join(""));
  assertEquals(reports.length, 1);
  assertEquals(reports[0]?.report.outcome, "settle");
});

Deno.test("settles non-stream usage before the response is returned and preserves bytes", async () => {
  const body = JSON.stringify({ id: "resp_1", usage: { total_tokens: 77 } });
  const reports: RecordedReport[] = [];
  const upstream = new Response(body, {
    status: 200,
    headers: { "content-type": jsonContentType },
  });

  const response = await relayUpstreamResponse(upstream, collector(reports), sessionFixture());

  assertEquals(reports.length, 1);
  assertEquals(reports[0]?.report, {
    version: 1,
    grantId,
    leaseGeneration,
    outcome: "settle",
    totalTokens: 77,
  });
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("content-type"), jsonContentType);
  assertEquals(await drainBytes(response), body);
});

Deno.test("reports uncertain for a non-stream response without usage", async () => {
  const body = JSON.stringify({ id: "resp_1" });
  const reports: RecordedReport[] = [];
  const upstream = new Response(body, {
    status: 200,
    headers: { "content-type": jsonContentType },
  });

  const response = await relayUpstreamResponse(upstream, collector(reports), sessionFixture());

  assertEquals(await drainBytes(response), body);
  assertEquals(reports.length, 1);
  assertEquals(reports[0]?.report.outcome, "uncertain");
});

Deno.test("fails the non-stream response closed when the bounded read is exceeded", async () => {
  const oversized = "z".repeat(1_048_577);
  const reports: RecordedReport[] = [];
  const upstream = new Response(oversized, {
    status: 200,
    headers: { "content-type": jsonContentType },
  });

  await assertRejects(
    () => relayUpstreamResponse(upstream, collector(reports), sessionFixture()),
    RelayUpstreamDeliveryError,
  );
  assertEquals(reports.length, 1);
  assertEquals(reports[0]?.report.outcome, "uncertain");
});

Deno.test("passes upstream non-2xx through unchanged and reports uncertain once", async () => {
  const body = JSON.stringify({ error: { message: "upstream said no" } });
  const reports: RecordedReport[] = [];
  const upstream = new Response(body, {
    status: 429,
    headers: { "content-type": jsonContentType },
  });

  const response = await relayUpstreamResponse(upstream, collector(reports), sessionFixture());

  assertEquals(response.status, 429);
  assertEquals(response.headers.get("content-type"), jsonContentType);
  assertEquals(await drainBytes(response), body);
  assertEquals(reports.length, 1);
  assertEquals(reports[0]?.report, {
    version: 1,
    grantId,
    leaseGeneration,
    outcome: "uncertain",
    totalTokens: null,
  });
});
