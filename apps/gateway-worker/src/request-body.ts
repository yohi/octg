type ReadJsonBodyResult =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly reason: "invalid_json" | "too_large" };

export async function readJsonBody(request: Request, maxBytes: number): Promise<ReadJsonBodyResult> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isSafeInteger(contentLength) && contentLength > maxBytes) {
    return { ok: false, reason: "too_large" };
  }

  if (!request.body) return { ok: false, reason: "invalid_json" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      return { ok: false, reason: "too_large" };
    }
    chunks.push(chunk.value);
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, body: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
}
