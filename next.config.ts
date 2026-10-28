import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lets the dev server be used over `tailscale serve` (*.ts.net).
  allowedDevOrigins: ["**.ts.net"],
  // No Next logo badge over the terminal; compile errors still show.
  devIndicators: false,
  // Native / spawned binaries: load from node_modules, don't bundle.
  serverExternalPackages: ["node-pty", "@anthropic-ai/claude-agent-sdk"],
  // Every open tab polls this every 2s; keep it out of the dev log.
  logging: { incomingRequests: { ignore: [/^\/api\/sessions/] } },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
