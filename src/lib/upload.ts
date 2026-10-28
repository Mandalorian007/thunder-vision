/**
 * Sends a file to this Mac and resolves with where it landed. XHR rather
 * than fetch, for upload progress (0–1).
 */
export function uploadFile(
  file: File,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/uploads");
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let json: { path?: string; error?: string } = {};
      try {
        json = JSON.parse(xhr.responseText);
      } catch {
        // Not ours; fall through to the status.
      }
      if (xhr.status === 200 && json.path) resolve(json.path);
      else reject(new Error(json.error ?? `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Upload failed: connection lost"));
    xhr.onabort = () => reject(new DOMException("Cancelled", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort());
    xhr.send(file);
  });
}

/** A path as typed into a shell or a prompt: quoted only if it needs it. */
export function shellPath(p: string) {
  return /^[\w./~+-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}
