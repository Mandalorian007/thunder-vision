// Shared by the palette (to preview names) and the server (to apply them).

/** tmux silently rewrites "." and ":" in session names; do it up front. */
export function toSessionName(raw: string) {
  return raw.trim().replace(/[.:\s]+/g, "_");
}

/** "a/b" under the root → "a-b"; anything else → its last folder name. */
export function sessionNameForRel(rel: string, rootName: string) {
  const clean = rel.replace(/^\/+|\/+$/g, "");
  return toSessionName(clean === "" ? rootName : clean.replaceAll("/", "-"));
}

export function basename(p: string) {
  return p.replace(/\/+$/, "").split("/").pop() ?? "";
}

/** https/ssh git remotes, e.g. https://github.com/a/b(.git) or git@github.com:a/b.git. */
export const GIT_URL = /^(https?:\/\/|ssh:\/\/|git@)\S+\/\S+$/;

/** "git@github.com:me/my-app.git" → "my-app". */
export function repoName(url: string) {
  return basename(url.replace(/\.git\/?$/, "").replace(/:/g, "/"));
}
