/** Small request helpers shared by API routes. */

export type JsonBodyResult =
  | { ok: true; data: unknown }
  | { ok: false; status: number; code: string; error: string };

/** Read the body as text with a hard size cap, then parse JSON. */
export async function readJsonBody(req: Request, maxBytes: number): Promise<JsonBodyResult> {
  const contentType = (req.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("application/json")) {
    return { ok: false, status: 415, code: "unsupported_media_type", error: "Send the request as JSON." };
  }
  const declared = Number(req.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, status: 413, code: "payload_too_large", error: "Request is too large." };
  }
  let text: string;
  try {
    text = await req.text();
  } catch {
    return { ok: false, status: 400, code: "invalid_request", error: "Invalid request." };
  }
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    return { ok: false, status: 413, code: "payload_too_large", error: "Request is too large." };
  }
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, code: "invalid_request", error: "Invalid request." };
  }
}
