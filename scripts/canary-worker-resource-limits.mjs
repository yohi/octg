#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const MAX_CANARY_CONCURRENCY = 64;
const MAX_CANARY_REQUEST_TIMEOUT_MS = 2_147_483_647;
const MAX_RESPONSE_METADATA_BYTES = 16 * 1024;
const OCTG_REQUEST_ID = /^req_[0-9A-HJKMNP-TV-Z]{26}$/;
const SAFE_RESPONSE_VALUE = /^[A-Za-z0-9_.:-]{1,128}$/;
const AWS_ACCESS_KEY_ID = /^(?:AKIA|ASIA)[0-9A-Z]{16}$/;
const SAFE_ERROR_NAMES = new Set(["AbortError", "Error", "TypeError"]);
const SAFE_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ERR_NETWORK",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new TypeError(`${name} is required`);
  return value;
};

const parsePositiveSafeIntegers = (name, raw) => {
  const values = raw.split(",").map((value) => Number(value.trim()));
  if (values.length === 0 || values.some((value) => !Number.isSafeInteger(value) || value <= 0 || value > MAX_CANARY_CONCURRENCY)) {
    throw new TypeError(`${name} must contain positive safe integers`);
  }
  return values;
};

const sanitizeErrorValue = (value, allowlist) => (
  typeof value === "string" && allowlist.has(value) ? value : null
);

const safeErrorMetadata = (error) => {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) {
    return { errorName: null, errorCode: null };
  }
  try {
    return {
      errorName: sanitizeErrorValue(error.name, SAFE_ERROR_NAMES),
      errorCode: sanitizeErrorValue(error.code, SAFE_ERROR_CODES),
    };
  } catch {
    return { errorName: null, errorCode: null };
  }
};

const sanitizeResponseValue = (value) => (
  typeof value === "string" &&
  SAFE_RESPONSE_VALUE.test(value) &&
  !value.startsWith("octg_sk_") &&
  !value.startsWith("sk-") &&
  !AWS_ACCESS_KEY_ID.test(value)
    ? value
    : null
);

const safeResponseMetadata = (response, body) => {
  let parsedBody;
  if (body !== null) {
    try {
      parsedBody = JSON.parse(new TextDecoder().decode(body));
    } catch {
      parsedBody = undefined;
    }
  }
  const responseError = parsedBody && typeof parsedBody === "object" && parsedBody !== null
    ? parsedBody.error
    : undefined;
  return {
    route: sanitizeResponseValue(response.headers.get("X-OCTG-Route")),
    workerVersion: sanitizeResponseValue(response.headers.get("X-OCTG-Worker-Version")),
    responseErrorType: sanitizeResponseValue(responseError?.type),
    responseErrorCode: sanitizeResponseValue(responseError?.code),
    responseErrorParam: sanitizeResponseValue(responseError?.param),
  };
};

const readResponseBody = async (response) => {
  if (response.body === null || response.body === undefined) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new TypeError("invalid response body");
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_METADATA_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The response is already being discarded.
        }
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

export async function requestCanary({
  url,
  apiKey,
  payload,
  concurrency,
  ordinal,
  requestTimeoutMs,
  fetchImpl = fetch,
  now = () => performance.now(),
}) {
  const startedAt = now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: payload,
      signal: controller.signal,
      redirect: "error",
    });
    const responseBody = await readResponseBody(response);
    return {
      event: "octg.canary.result",
      concurrency,
      ordinal,
      outcome: "response",
      status: response.status,
      durationMs: now() - startedAt,
      requestId: response.headers.get("X-OCTG-Request-Id")?.match(OCTG_REQUEST_ID)?.[0] ?? null,
      ...safeResponseMetadata(response, responseBody),
    };
  } catch (error) {
    const metadata = safeErrorMetadata(error);
    const outcome = controller.signal.aborted || metadata.errorName === "AbortError"
      ? "timeout"
      : "fetch_error";
    return {
      event: "octg.canary.result",
      concurrency,
      ordinal,
      outcome,
      status: null,
      durationMs: now() - startedAt,
      requestId: null,
      errorName: outcome === "fetch_error" ? metadata.errorName : null,
      errorCode: outcome === "fetch_error" ? metadata.errorCode : null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

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
  if (!concurrencies.includes(1) || !concurrencies.includes(2)) {
    throw new TypeError("CANARY_CONCURRENCY must include concurrency levels 1 and 2");
  }
  const requestTimeoutMs = Number(required("CANARY_REQUEST_TIMEOUT_MS"));
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0 || requestTimeoutMs > MAX_CANARY_REQUEST_TIMEOUT_MS) {
    throw new TypeError("CANARY_REQUEST_TIMEOUT_MS must be a positive safe integer");
  }

  for (const concurrency of concurrencies) {
    const results = await Promise.all(
      Array.from({ length: concurrency }, (_, ordinal) =>
        requestCanary({ url, apiKey, payload, concurrency, ordinal, requestTimeoutMs }),
      ),
    );
    for (const result of results) console.log(JSON.stringify(result));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch {
    console.error("octg.canary.config_error");
    process.exitCode = 1;
  }
}
