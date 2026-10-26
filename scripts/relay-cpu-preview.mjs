import { withPreviewSecretsFile } from "./relay-cpu-protection.mjs";

export async function runPreviewLifecycle({ bearer, adapters }) {
  let candidateVersion;
  let secretlessVersion;
  let failed = false;
  let cleanupVerified = false;
  try {
    await withPreviewSecretsFile({ token: bearer, upload: async (secretsPath) => {
      try {
        const uploaded = await adapters.uploadCandidate({ secretsPath, secretName: "OCTG_RELAY_CPU_GATE_AUTH_TOKEN" });
        candidateVersion = uploaded?.versionId;
        if (typeof candidateVersion !== "string" || !candidateVersion) throw new Error("Candidate version unavailable");
        await adapters.deployCandidate({ versionId: candidateVersion });
        if ((await adapters.observeCandidate({ versionId: candidateVersion }))?.observed !== true) throw new Error("Candidate not observed");
        if ((await adapters.preflight({ versionId: candidateVersion, bearer }))?.ready !== true) throw new Error("Preview preflight failed");
        await adapters.measure?.({ versionId: candidateVersion });
      } catch { failed = true; }
      finally {
        // Preserve recovery access while an authoritative operation may be live.
        let closed = false;
        try { closed = (await adapters.beforeTeardown?.())?.closed === true; } catch { failed = true; }
        if (!closed) failed = true;
        if (candidateVersion && closed) {
          try {
            // Versioned deletion itself creates the new secretless version.
            const deleted = await adapters.deleteVersionSecret({ versionId: candidateVersion, secretName: "OCTG_RELAY_CPU_GATE_AUTH_TOKEN" });
            secretlessVersion = deleted?.versionId;
            if (typeof secretlessVersion !== "string" || !secretlessVersion || secretlessVersion === candidateVersion) throw new Error("Secretless version unavailable");
            await adapters.setTraffic({ versionId: secretlessVersion, percent: 100 });
            const metadata = await adapters.verifyMetadata({ versionId: secretlessVersion, candidateVersionId: candidateVersion });
            if (metadata?.secretAbsent !== true || metadata.bindingsUnchanged !== true || metadata.deployedPercent !== 100) throw new Error("Secretless deployment not proven");
            if ((await adapters.verifyExactVersion({ versionId: secretlessVersion }))?.status !== 404) throw new Error("Control surface still enabled");
            cleanupVerified = true;
          } catch { failed = true; }
        }
      }
    } });
  } catch { failed = true; }
  return { kind: failed ? "blocked" : "complete", ...(candidateVersion ? { versionId: candidateVersion } : {}),
    ...(secretlessVersion ? { secretlessVersion } : {}), cleanupVerified };
}
