import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const MAX_BUILD_LOG_BYTES = 1024 * 1024;

const CONSOLE_ORIGIN = "https://console.deno.com";

export function extractRevision(output) {
  let revision;

  for (const line of output.split(/\r?\n/)) {
    let envelope;
    try {
      envelope = JSON.parse(line);
    } catch {
      continue;
    }

    const candidate = extractRevisionFromHint(envelope?.error?.hint);
    if (candidate !== undefined) {
      revision = candidate;
    }
  }

  return revision;
}

function extractRevisionFromHint(hint) {
  if (typeof hint !== "string") return undefined;

  const urlMatch = hint.match(/https:\/\/console\.deno\.com\/[^\s]+/);
  if (urlMatch === null) return undefined;

  try {
    const url = new URL(urlMatch[0].replace(/[),.;]+$/, ""));
    if (url.origin !== CONSOLE_ORIGIN) return undefined;

    const segments = url.pathname.split("/").filter(Boolean);
    const buildIndex = segments.lastIndexOf("builds");
    if (buildIndex < 0 || buildIndex !== segments.length - 2) {
      return undefined;
    }

    const revision = decodeURIComponent(segments.at(-1));
    return isValidRevision(revision) ? revision : undefined;
  } catch {
    return undefined;
  }
}

function isValidRevision(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    !/[\u0000-\u001f\u007f\\/]/.test(value);
}

export async function classifyBuildLogs({
  revision,
  token,
  fetchImpl = fetch,
  maxBytes = MAX_BUILD_LOG_BYTES,
}) {
  if (!isValidRevision(revision ?? "") || typeof token !== "string" || token.length === 0) {
    return { categories: [], skipped: true, truncated: false };
  }

  let response;
  try {
    response = await fetchImpl(
      `https://api.deno.com/v2/revisions/${encodeURIComponent(revision)}/build_logs`,
      {
        headers: {
          accept: "application/x-ndjson",
          authorization: `Bearer ${token}`,
        },
        redirect: "error",
      },
    );
  } catch {
    return { categories: [], error: "network", truncated: false };
  }

  if (!response.ok || response.body === null) {
    return {
      categories: [],
      error: `http_${response.status}`,
      truncated: false,
    };
  }

  const readResult = await readBoundedText(response.body, maxBytes);
  if (readResult.error !== undefined) {
    return { categories: [], error: "read", truncated: false };
  }

  return {
    categories: classifyText(readResult.text),
    truncated: readResult.truncated,
  };
}

async function readBoundedText(body, maxBytes) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      const length = Math.min(value.byteLength, maxBytes - received);
      if (length > 0) {
        text += decoder.decode(value.subarray(0, length), { stream: true });
        received += length;
      }
      if (length < value.byteLength) {
        await reader.cancel().catch(() => undefined);
        return { text, truncated: true };
      }
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return { error: "read" };
  }

  return { text: text + decoder.decode(), truncated: false };
}

function classifyText(text) {
  return [
    ["node_modules", /node_modules/i],
    ["npm", /npm:|\btiktoken\b/i],
    ["module_resolution", /could not find|cannot find|module not found|failed to resolve/i],
    ["entrypoint", /entrypoint/i],
    ["lockfile", /lockfile/i],
    ["permission", /permission/i],
    ["network", /network|timeout|timed out|dns/i],
  ]
    .filter(([, pattern]) => pattern.test(text))
    .map(([name]) => name);
}

async function main() {
  const mode = process.argv[2];

  if (mode === "extract") {
    const outputPath = process.argv[3];
    if (outputPath === undefined) return;

    const revision = extractRevision(readFileSync(outputPath, "utf8"));
    const githubOutput = process.env.GITHUB_OUTPUT;
    if (revision !== undefined && githubOutput !== undefined) {
      appendFileSync(githubOutput, `revision=${revision}\n`);
    } else if (revision === undefined) {
      console.warn("Deno Deploy failure did not include a revision ID for build-log classification.");
    }
    return;
  }

  if (mode === "classify") {
    const result = await classifyBuildLogs({
      revision: process.env.DENO_DEPLOY_REVISION,
      token: process.env.DENO_DEPLOY_TOKEN,
    });

    if (result.skipped === true) {
      console.warn("Deno Deploy build-log classifier skipped because its inputs are invalid.");
    } else if (result.error !== undefined) {
      console.warn(`Deno Deploy build-log classifier unavailable: ${result.error}.`);
    } else {
      console.log(`Deno Deploy build-log categories: ${result.categories.join(", ") || "none"}`);
      if (result.truncated) {
        console.log(`Deno Deploy build-log classifier truncated after ${MAX_BUILD_LOG_BYTES} bytes.`);
      }
    }
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
