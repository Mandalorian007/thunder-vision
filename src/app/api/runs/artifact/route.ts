import { readFileSync } from "node:fs";
import path from "node:path";
import { ID, RUN_ID } from "@/lib/workflows";
import { error } from "@/server/http";
import { artifactPath } from "@/server/workflows";

/** Shown in the browser. Anything else downloads, HTML and SVG included:
 * served from this origin, they could script the app. */
const INLINE: Record<string, string> = {
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".json": "text/plain; charset=utf-8",
  ".diff": "text/plain; charset=utf-8",
  ".patch": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8",
  ".yml": "text/plain; charset=utf-8",
  ".yaml": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

/** ?workflow=&run=&path= → a file the run left in $TV_ARTIFACTS. */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const wf = params.get("workflow") ?? "";
  const run = params.get("run") ?? "";
  const rel = params.get("path") ?? "";
  const file =
    ID.test(wf) && RUN_ID.test(run) && rel ? artifactPath(wf, run, rel) : null;
  if (!file) return error(404, "No such file");
  const type = INLINE[path.extname(file).toLowerCase()];
  const name = encodeURIComponent(path.basename(file));
  return new Response(readFileSync(file), {
    headers: {
      "Content-Type": type ?? "application/octet-stream",
      "Content-Disposition": `${type ? "inline" : "attachment"}; filename*=UTF-8''${name}`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "no-store",
    },
  });
}
