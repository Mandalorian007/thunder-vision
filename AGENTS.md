<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Thunder Vision — notes for agents

A Next.js + shadcn UI over tmux, served to a tailnet. Read `README.md` first:
it covers setup, features, layout, the API and the security model. Local
settings live in `.env` (see `.env.example`); never commit `.env`, and keep
machine-specific values (paths, logins, hostnames) out of tracked files.

## The running app may be live

If the launchd agent is installed in dev mode, it runs `pnpm dev` from this
folder, so every save goes straight to the app the user has open right now
(often on an iPad or a phone):

- UI edits (`src/app`, `src/components`, `src/lib`) hot-reload in place.
- `server.ts`, `src/server/**`, `next.config.ts` and `.env` restart the
  server. Open terminals reconnect and pages reload themselves (they watch the
  `X-TV-Boot` header), but it's still a visible blip, so batch server edits.
- A half-finished edit that doesn't compile replaces the app with Next's error
  overlay. Write whole files or coherent changes, not broken intermediate steps.
- Logs: `~/Library/Logs/thunder-vision.log`. Restart:
  `launchctl kickstart -k gui/$(id -u)/$TV_LAUNCHD_LABEL` (the label is in
  `.env`; default `local.thunder-vision`).

## Checks before calling something done

```sh
npx prettier --write src server.ts
npx tsc --noEmit     # TS6053 on .next/dev/types = dev server mid-regen; rerun
pnpm lint
pnpm build           # must be warning-free; safe alongside dev (.next vs .next/dev)
```

Then exercise it through the tailnet URL, not just localhost: the
origin checks key off `x-forwarded-host`, so curl calls need a matching
`Origin` header. Clean up any test sessions (`tmux kill-session -t =name`) and
folders you made.

## Conventions and gotchas

- pnpm only. Don't commit unless asked.
- Plan usage comes from the Agent SDK (`src/server/usage.ts`), which lets
  Claude Code use its own login. Don't read the Claude login token or call the
  undocumented `/api/oauth/usage` endpoint: Anthropic's terms bar third-party
  tools from using those credentials. Don't add a status line or hooks to the
  user's Claude sessions to collect data either.
- The SDK spawns its own `claude` binary, so it stays in
  `serverExternalPackages` (`next.config.ts`). Client components import only
  types from `src/server/usage.ts` (`import type`); a value import would pull
  the SDK into the browser bundle.
- Never move it off `127.0.0.1` or onto a Tailscale Funnel port. Keep the
  same-origin checks on WebSocket upgrades and mutating API calls.
- tmux targets: `=name` for exact session match, `=name:` for `send-keys`.
  Strip `TMUX` / `TMUX_PANE` from the env (`cleanEnv()` in `src/server/tmux.ts`)
  so commands work when the server itself runs inside tmux.
- Session naming lives in `src/lib/names.ts` and is shared by client and
  server; change it there, never in one place only.
- Runtime filesystem paths in server code need `/*turbopackIgnore: true*/`,
  or the build tries to trace the home folder (see `src/server/repos.ts`).
- Touch matters as much as desktop: size with the `pointer-coarse:` variant,
  don't hide controls behind hover only, and don't steal focus into the
  terminal on touch devices (it pops the iOS keyboard).
- shadcn components in `src/components/ui/` are generated; when adding one with
  the CLI, decline overwrites of existing files.
