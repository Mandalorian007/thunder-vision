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
