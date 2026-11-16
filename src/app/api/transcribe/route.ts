import { crossSite, error, noStore } from "@/server/http";
import {
  MAX_CLIP_BYTES,
  TranscribeError,
  transcribe,
  warmUp,
} from "@/server/transcribe";

/**
 * One recorded phrase as the body (its mime type as Content-Type) → { text },
 * transcribed by whisper.cpp on this Mac. `?draft=1`: a quick rough pass of
 * the phrase so far. `?warm=1`, no body: load the models now.
 */
export async function POST(req: Request) {
  if (crossSite(req)) return error(403, "cross-site request");
  const params = new URL(req.url).searchParams;
  if (params.has("warm")) {
    warmUp();
    return new Response(null, { status: 204 });
  }
  if (Number(req.headers.get("content-length")) > MAX_CLIP_BYTES) {
    return error(413, "Clip too long");
  }
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length > MAX_CLIP_BYTES) return error(413, "Clip too long");
  if (bytes.length === 0) return error(400, "Empty clip");
  try {
    const text = await transcribe(
      bytes,
      req.headers.get("content-type") ?? "",
      {
        draft: params.has("draft"),
      },
    );
    return Response.json({ text }, { headers: noStore });
  } catch (err) {
    if (err instanceof TranscribeError) return error(err.status, err.message);
    throw err;
  }
}
