import "./src/server/env";
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import next from "next";
import { WebSocketServer } from "ws";
import { attachLog } from "./src/server/log-tail";
import { hostAllowed, originMatchesHost } from "./src/server/origin";
import { attachPty } from "./src/server/pty-bridge";
import { startScheduler } from "./src/server/scheduler";

const dev = process.env.NODE_ENV !== "production";
// Loopback only, on purpose: tailscale serve is the way in. Not configurable,
// so a HOST=0.0.0.0 exported for some other project can't expose a shell.
const hostname = "127.0.0.1";
const port = Number(process.env.PORT || 7700);
/** Optional comma-separated Tailscale logins allowed in, e.g. "you@github". */
const allowedLogins = (process.env.TV_ALLOWED_LOGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** Changes on every restart; open pages reload when they see a new one. */
const BOOT_ID = Date.now().toString(36);

// On the first request, Next attaches its "upgrade" listener (dev HMR) to
// whatever server it is given. Hand it a stand-in so /ws/pty upgrades stay
// ours, and forward the rest to it. (app.getUpgradeHandler() is not that
// listener: in dev it never answers HMR.)
const nextUpgrades = new EventEmitter();
const app = next({
  dev,
  hostname,
  port,
  httpServer: nextUpgrades as unknown as Server,
});

/** This is a remote shell: refuse anything that isn't you on your tailnet. */
function rejectReason(req: IncomingMessage): string | null {
  const forwarded = req.headers["x-forwarded-host"];
  if (!hostAllowed(req.headers.host) || (forwarded && !hostAllowed(forwarded)))
    return "unknown host";
  // Another site's page loading our scripts or Next's dev endpoints (a public
  // *.ts.net Funnel page passes Next's allowedDevOrigins). Following a link
  // here is fine.
  const site = req.headers["sec-fetch-site"];
  if (
    site &&
    site !== "same-origin" &&
    site !== "none" &&
    req.headers["sec-fetch-mode"] !== "navigate"
  )
    return "cross-site request";
  // tailscale serve stamps this on requests that arrive from the public internet.
  if (req.headers["tailscale-funnel-request"])
    return "funnel requests are not allowed";
  if (allowedLogins.length) {
    const login = req.headers["tailscale-user-login"];
    if (typeof login !== "string" || !allowedLogins.includes(login)) {
      return "tailscale login not allowed";
    }
  }
  return null;
}

function sameOrigin(req: IncomingMessage) {
  return originMatchesHost(
    req.headers.origin,
    req.headers["x-forwarded-host"] ?? req.headers.host,
  );
}

async function main() {
  await app.prepare();
  const handle = app.getRequestHandler();
  const wss = new WebSocketServer({ noServer: true });

  const server = createServer((req, res) => {
    const reason = rejectReason(req);
    if (reason) {
      res.writeHead(403).end(reason);
      return;
    }
    res.setHeader("X-TV-Boot", BOOT_ID);
    handle(req, res);
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const reason = rejectReason(req) ?? (sameOrigin(req) ? null : "bad origin");
    if (reason) {
      console.warn(
        `[thunder-vision] rejected ws ${url.pathname}: ${reason} (origin=${req.headers.origin})`,
      );
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    if (url.pathname === "/ws/log") {
      wss.handleUpgrade(req, socket, head, (ws) =>
        attachLog(ws, url.searchParams),
      );
      return;
    }
    if (url.pathname !== "/ws/pty") {
      // No listener in production, or before the first page request.
      if (!nextUpgrades.emit("upgrade", req, socket, head)) socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      attachPty(ws, url.searchParams).catch((err) => {
        console.error("[thunder-vision] attach failed", err);
        ws.close(1011, "attach failed");
      });
    });
  });

  server.listen(port, hostname, () => {
    console.log(
      `⚡ Thunder Vision on http://${hostname}:${port} (${dev ? "dev" : "production"})`,
    );
    startScheduler();
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
