import {
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./jobs";

/** Files sent from a phone or tablet, so a session on this Mac can read them. */
export const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** Uploads are handed straight to Claude; a week is plenty to come back to one. */
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A name that's safe in a shell and in a prompt: no spaces, no quotes, and
 * a timestamp so two "image.png"s from the camera don't collide.
 */
function fileName(original: string, now: Date) {
  const base = path.basename(original).normalize("NFKD");
  const ext = path
    .extname(base)
    .replace(/[^\w.]/g, "")
    .slice(0, 10);
  const stem =
    base
      .slice(0, base.length - path.extname(base).length)
      .replace(/[^\w.-]+/g, "-")
      .replace(/^[-.]+|-+$/g, "")
      .slice(0, 60) || "upload";
  const stamp = now.toISOString().replace(/\D/g, "").slice(0, 14);
  return `${stamp}-${stem}${ext}`;
}

/** Saves the file and returns its absolute path. */
export function saveUpload(original: string, bytes: Uint8Array) {
  mkdirSync(UPLOADS_DIR, { recursive: true });
  pruneUploads();
  const now = new Date();
  let name = fileName(original, now);
  for (let n = 2; existsIn(name); n++) {
    name = fileName(original, now).replace(/(\.[^.]*)?$/, `-${n}$1`);
  }
  const file = path.join(UPLOADS_DIR, name);
  writeFileSync(file, bytes, { flag: "wx" });
  return file;
}

function existsIn(name: string) {
  try {
    statSync(path.join(UPLOADS_DIR, name));
    return true;
  } catch {
    return false;
  }
}

function pruneUploads() {
  const cutoff = Date.now() - KEEP_MS;
  for (const name of readdirSync(UPLOADS_DIR)) {
    const file = path.join(UPLOADS_DIR, name);
    try {
      if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true });
    } catch {
      // Gone already.
    }
  }
}
