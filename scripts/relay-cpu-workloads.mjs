import { pathToFileURL } from "node:url";

export const WORKLOAD_CLASSES = Object.freeze(["baseline-small", "baseline-large", "incident-regression-stream", "incident-regression-nonstream"]);
export const CONCURRENCIES = Object.freeze([1, 2, 3]);
const INVOCATION_CLASSES = Object.freeze(["ingress", "decision", "activation_normal", "activation_replay", "renewal_normal", "terminal_normal", "terminal_replay"]);
const SMALL = "Synthetic CPU gate measurement input. ".repeat(8);
const LARGE = "Synthetic CPU gate measurement input with representative history. ".repeat(14000);
const INCIDENT_MESSAGES = Object.freeze([
  { role: "user", content: "Synthetic structural incident fixture; no customer content." },
  { role: "assistant", content: "Synthetic response history." },
  { role: "assistant", tool_calls: [{ id: "call_fixture", type: "function", function: { name: "synthetic_tool", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "call_fixture", content: "Synthetic tool result." },
]);

export function buildWorkload(workloadClass) {
  switch (workloadClass) {
    case "baseline-small": return { model: "octg-cpu-measurement", input: [{ role: "user", content: SMALL }], stream: false };
    case "baseline-large": return { model: "octg-cpu-measurement", input: [{ role: "user", content: LARGE }], stream: false };
    case "incident-regression-stream": return { model: "octg-cpu-measurement", input: INCIDENT_MESSAGES, stream: true };
    case "incident-regression-nonstream": return { model: "octg-cpu-measurement", input: INCIDENT_MESSAGES, stream: false };
    default: throw new TypeError("Unknown relay CPU workload class");
  }
}

export function requiredSeriesMatrix() {
  const rows = [];
  for (const invocationClass of INVOCATION_CLASSES) {
    for (const workloadClass of WORKLOAD_CLASSES) {
      const concurrencySet = invocationClass === "activation_normal" || invocationClass === "terminal_normal" ? [1] : CONCURRENCIES;
      for (const concurrency of concurrencySet) rows.push({ invocationClass, workloadClass, concurrency });
    }
  }
  return rows;
}

export function runWorkloadCli(argv = process.argv.slice(2)) {
  if (argv.includes("--help")) {
    console.log("Usage: node scripts/relay-cpu-workloads.mjs <workload-class>");
    return 0;
  }
  const workload = buildWorkload(argv[0]);
  process.stdout.write(`${JSON.stringify(workload)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = runWorkloadCli();
