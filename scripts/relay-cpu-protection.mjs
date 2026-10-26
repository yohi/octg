import { randomBytes } from "node:crypto";
import { mkdtemp, chmod, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function generateCpuGateBearer() { return randomBytes(32).toString("base64url"); }

export async function withPreviewSecretsFile({ token, directoryParent = tmpdir(), upload }) {
  if (typeof token !== "string" || token.length === 0) {
    throw new TypeError("Invalid Preview secret bundle");
  }
  const directory = await mkdtemp(join(directoryParent, "octg-preview-cpu-gate-"));
  try {
    await chmod(directory, 0o700);
    const secretsPath = join(directory, "secrets.json");
    const secrets = { OCTG_RELAY_CPU_GATE_AUTH_TOKEN: token };
    await writeFile(secretsPath, JSON.stringify(secrets), { mode: 0o600 });
    return await upload(secretsPath);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export function assertNoCredentialLeak({ credentials, surfaces }) {
  const serialized = JSON.stringify(surfaces);
  if (credentials.some((credential) => typeof credential === "string" && credential.length > 0 && serialized.includes(credential))) {
    throw new Error("credential leak detected in output surfaces");
  }
}
