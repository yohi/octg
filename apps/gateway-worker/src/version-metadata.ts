export type WorkerVersionMetadataLike = {
  readonly id?: string;
};

export function workerVersionHeaders(
  metadata: WorkerVersionMetadataLike | undefined,
): Record<string, string> {
  const versionId = metadata?.id;
  return {
    "X-OCTG-Worker-Version": typeof versionId === "string" && versionId.length > 0 ? versionId : "local",
  };
}
