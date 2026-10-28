/**
 * Cross-site requests (WebSocket hijacking, CSRF on the session API) carry
 * another site's Origin. The page must come from the host being asked.
 */
export function originMatchesHost(
  origin: string | null | undefined,
  host: string | string[] | null | undefined,
) {
  if (!origin || typeof host !== "string") return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * DNS rebinding: a page on evil.example can point its name at 127.0.0.1 and
 * reach us as same-origin, so Origin checks pass. Its Host header still says
 * evil.example, so only answer to loopback names and tailnet (MagicDNS) ones.
 */
export function hostAllowed(host: string | string[] | undefined) {
  if (typeof host !== "string") return false;
  try {
    const name = new URL(`http://${host}`).hostname;
    return (
      ["127.0.0.1", "localhost", "[::1]"].includes(name) ||
      name.endsWith(".ts.net")
    );
  } catch {
    return false;
  }
}
