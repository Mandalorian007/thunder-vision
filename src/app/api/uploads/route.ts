import { crossSite, error, noStore } from "@/server/http";
import { MAX_UPLOAD_BYTES, saveUpload } from "@/server/uploads";

const tooBig = () =>
  error(413, `Over the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit`);

/**
 * The file itself as the body, its name in X-File-Name (URI-encoded) →
 * { path } on this Mac, for typing into a session.
 */
export async function POST(req: Request) {
  if (crossSite(req)) return error(403, "cross-site request");
  if (Number(req.headers.get("content-length")) > MAX_UPLOAD_BYTES) {
    return tooBig();
  }
  let name = "upload";
  try {
    name = decodeURIComponent(req.headers.get("x-file-name") ?? "") || name;
  } catch {
    // Keep the fallback.
  }
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length > MAX_UPLOAD_BYTES) return tooBig();
  if (bytes.length === 0) return error(400, "Empty file");
  return Response.json({ path: saveUpload(name, bytes) }, { headers: noStore });
}
