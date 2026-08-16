#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new TypeError(`${name} is required`);
  return value;
};

const parsePositiveSafeIntegers = (name, raw) => {
  const values = raw.split(",").map((value) => Number(value.trim()));
  if (values.length === 0 || values.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new TypeError(`${name} must contain positive safe integers`);
  }
  return values;
};

async function main() {
  let url;
  try {
    url = new URL(required("OCTG_CANARY_URL"));
  } catch {
    throw new TypeError("OCTG_CANARY_URL must be a valid URL");
  }

  const allowedHosts = required("OCTG_CANARY_ALLOWED_HOSTS")
    .split(",")
    .map((host) => host.trim().toLowerCase());
  if (
    allowedHosts.length === 0 ||
    allowedHosts.some((host) => host.length === 0 || host.includes("*"))
  ) {
    throw new TypeError("OCTG_CANARY_ALLOWED_HOSTS must contain exact host names");
  }
  const allowedHostSet = new Set(allowedHosts);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    !allowedHostSet.has(url.hostname.toLowerCase())
  ) {
    throw new TypeError("OCTG_CANARY_URL must use an allowed HTTPS host");
  }

  const apiKey = required("OCTG_CANARY_CLIENT_KEY");
  let payload;
  try {
    payload = await readFile(required("CANARY_PAYLOAD_PATH"), "utf8");
    JSON.parse(payload);
  } catch {
    throw new TypeError("CANARY_PAYLOAD_PATH must contain readable valid JSON");
  }

  const concurrencies = parsePositiveSafeIntegers(
    "CANARY_CONCURRENCY",
    required("CANARY_CONCURRENCY"),
  );
  const requestTimeoutMs = Number(required("CANARY_REQUEST_TIMEOUT_MS"));
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new TypeError("CANARY_REQUEST_TIMEOUT_MS must be a positive safe integer");
  }

  for (const concurrency of concurrencies) {
    const results = await Promise.all(
      Array.from({ length: concurrency }, async (_, ordinal) => {
        const startedAt = performance.now();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
        try {
          const response = await fetch(url, {
            method: "POST",
            headers: {
              authorization: `Bearer ${apiKey}`,
              "content-type": "application/json",
            },
            body: payload,
            signal: controller.signal,
            redirect: "error",
          });
          return {
            event: "octg.canary.result",
            concurrency,
            ordinal,
            outcome: "response",
            status: response.status,
            durationMs: performance.now() - startedAt,
            requestId: response.headers.get("X-OCTG-Request-Id"),
          };
        } catch (error) {
          const outcome = error instanceof DOMException && error.name === "AbortError"
            ? "timeout"
            : "fetch_error";
          return {
            event: "octg.canary.result",
            concurrency,
            ordinal,
            outcome,
            status: null,
            durationMs: performance.now() - startedAt,
            requestId: null,
          };
        } finally {
          clearTimeout(timeout);
        }
      }),
    );
    for (const result of results) console.log(JSON.stringify(result));
  }
}

try {
  await main();
} catch {
  console.error("octg.canary.config_error");
  process.exitCode = 1;
}
