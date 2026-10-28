# ⚡ Thunder Vision

Your tmux sessions as browser tabs, over Tailscale. Every `tmux list-sessions`
entry becomes a vertical tab; opening one runs `tmux attach` in a pty
(node-pty) and streams it to xterm.js over a WebSocket. Closing the browser just
detaches, so whatever runs inside (Claude Code, usually) keeps going.

Built for driving long-running Claude sessions from a desk, an iPad or an
iPhone without a terminal app.

## What it does

- **Tabs are tmux sessions.** New sessions made anywhere (`tmux new -s x`) show
  up within 2s; killed ones disappear. The selected tab lives in the URL hash
  (`#my-app`), so tabs are bookmarkable.
- **Busy dots.** A tab's dot pulses while its window printed output in the last
  5s, which for Claude Code means it's mid-turn.
- **New session palette** (⌘K or **+**). Type to filter folders under
  `TV_ROOT` (two levels deep), or enter:
  - a new name → **Create** it under `TV_ROOT`, optionally with `git init`
  - a `~/…` or `/…` path → start there (created if missing)
  - a git URL (`https://…`, `git@…`, `ssh://…`) → **Clone** into
    `TV_ROOT/<repo>` and start there

  Press **Tab** on any row (the sliders button on touch) for options: session
  name, a start command (chips for recent ones plus `claude`,
  `claude --resume`, `claude --continue`) and `git init`. If the name is
  taken, you're offered a switch to the existing session instead.

- **Rename and kill** from a tab's ⋯ menu, or right-click / long-press the tab.
  Kill asks first.
- **Plan usage.** The sidebar footer shows your Claude plan and login email,
  and how much of the session (5-hour) and weekly caps you've used, with when
  each resets: the same numbers as `/usage`. See [Plan usage](#plan-usage).
- **Settings** (the sliders button by the title): text size, the key bar and
  the theme. The button beside it collapses the sidebar to icons. All of it is
  remembered per device.
- **Touch friendly.** On phones the sidebar is a drawer, a key bar adds the
  keys iOS lacks (esc, tab, ⇧tab, ^C, arrows, enter, and a sticky ctrl), and
  hit targets grow on touch screens.
- **Self-healing.** Terminals reconnect with backoff after a network blip or a
  server restart. Open pages reload themselves when the server restarts, so a
  backgrounded iPad tab doesn't keep showing stale UI.

### Keyboard

| Keys    | Does                                                 |
| ------- | ---------------------------------------------------- |
| ⌘K      | New session palette                                  |
| ⌥1 – ⌥9 | Jump to tab 1–9                                      |
| ↵       | In the palette: start the highlighted row            |
| Tab     | In the palette: options for the highlighted row      |
| Esc     | Back out of the options card, then close the palette |

Everything else goes to the terminal, including tmux's own prefix keys.

## Setup

### 1. Requirements

On the machine that will host your sessions:

- macOS for the launchd script (the app itself isn't Mac-specific; on Linux,
  run `pnpm build && pnpm start` under systemd or similar)
- Node 22+, [pnpm](https://pnpm.io/installation), tmux and git
  (`brew install node pnpm tmux git`)
- [Tailscale](https://tailscale.com/download), signed in. Your iPad, phone or
  laptop need Tailscale too, on the same tailnet.
- Optional: [Claude Code](https://code.claude.com), logged in as the same user
  the server runs as, for the plan usage meters

### 2. Install

```sh
git clone <this repo> thunder-vision
cd thunder-vision
pnpm install
cp .env.example .env
```

### 3. Configure

Everything specific to your machine goes in `.env`, which git ignores. Every
setting is optional; the defaults suit most setups. The ones worth a look:

- `TV_ROOT`: where your projects live (default `~/repos`). The palette lists
  this folder two levels deep, and new folders and clones land here.
- `TV_ALLOWED_LOGINS`: lock it to your own Tailscale login if other people
  share your tailnet.
- `TV_LAUNCHD_LABEL`: the launchd agent's name, if you want your own
  (`com.you.thunder-vision`).

All settings:

| Variable            | Default                | Purpose                                                   |
| ------------------- | ---------------------- | --------------------------------------------------------- |
| `TV_ROOT`           | `~/repos`              | Folders the palette lists; relative names land here       |
| `HOST`              | `127.0.0.1`            | Listen address. Leave it; see [Security](#security-model) |
| `PORT`              | `7700`                 | Listen port                                               |
| `TV_ALLOWED_LOGINS` | _(anyone on tailnet)_  | Comma-separated Tailscale logins allowed in               |
| `TMUX_BIN`          | `tmux`                 | tmux binary (set when PATH is minimal, e.g. launchd)      |
| `CLAUDE_BIN`        | _(SDK's bundled one)_  | `claude` binary for the plan usage check                  |
| `TV_LAUNCHD_LABEL`  | `local.thunder-vision` | launchd label used by `scripts/install-launchd.sh`        |

Variables already set in the environment win over `.env`. The server reads it
at startup, and `pnpm dev` restarts when you save it.

### 4. Try it

```sh
pnpm dev                     # or: pnpm build && pnpm start
```

Open <http://127.0.0.1:7700> on the host. Your tmux sessions should be listed;
start one with **+** if you have none.

### 5. Reach it over Tailscale

In the Tailscale admin console, under
[DNS](https://login.tailscale.com/admin/dns), turn on MagicDNS and HTTPS
certificates (once per tailnet). Then on the host:

```sh
tailscale serve --bg --https=7700 http://127.0.0.1:7700
tailscale serve status       # must say "(tailnet only)" for this port
```

Open `https://<machine>.<tailnet>.ts.net:7700` from any device on your tailnet
(`tailscale status` lists the machine name; the tailnet name is on the DNS
page). On an iPad or iPhone, **Share → Add to Home Screen** gives it a
full-screen icon.

The serve setting survives reboots. Use `--https=<PORT>` with your own port
if you changed it, and never use `tailscale funnel`, which makes the port
public.

### 6. Keep it running (macOS)

`scripts/install-launchd.sh` installs a per-user launchd agent that starts at
login and restarts on crash. It reads `.env` for the label and port.

```sh
./scripts/install-launchd.sh                      # dev mode: live reload (default)
pnpm build && ./scripts/install-launchd.sh prod   # stable build; rerun after each build
tail -f ~/Library/Logs/thunder-vision.log
launchctl kickstart -k gui/$(id -u)/local.thunder-vision   # restart
launchctl bootout gui/$(id -u)/local.thunder-vision        # stop / uninstall
```

Use your `TV_LAUNCHD_LABEL` in place of `local.thunder-vision` if you set one;
the script prints the exact commands. Rerun it after changing the label or
switching modes. It bakes the current `node` and `tmux` paths into the plist,
since launchd's PATH is minimal. Other `.env` changes only need a restart (in
dev mode, saving `.env` restarts it).

### Updating

```sh
git pull && pnpm install
pnpm build && launchctl kickstart -k gui/$(id -u)/local.thunder-vision   # prod mode; your TV_LAUNCHD_LABEL if set
```

Dev mode picks up the pull on its own.

## Plan usage

The sidebar footer shows what `/usage` shows: the plan, the login email, and
the session (rolling 5-hour) and weekly caps, each with when it resets. Reset
times are in the viewing device's time zone. Bars turn amber at 75% and red at
90%. In the collapsed sidebar they become two rings, with details in a tooltip.

The server gets the numbers from Claude Code itself, through the
[Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)
(`usage_EXPERIMENTAL…()` and `accountInfo()`):

- It starts `claude` (the SDK's bundled copy, or `CLAUDE_BIN`) with no prompt,
  so nothing goes to a model, no session is saved and no settings or hooks
  load. Claude Code uses its own login; Thunder Vision never sees the token.
- A check takes about half a second and runs at most once an hour, only while
  a page is open. Every open page shares the answer, so the numbers can be up
  to an hour behind `/usage`; the header says when they were checked.
- The refresh button by the plan name checks straight away (at most once
  every 30 seconds, however many pages ask). So does restarting the server.
- A failed check retries after a minute. Meanwhile the last numbers stay up,
  and the "checked … ago" turns amber once they're over 70 minutes old. A
  window whose reset time passes drops to 0% within 30 seconds.

Nothing to set up beyond being logged in to Claude Code (`claude` → `/login`).
API-key logins have no plan caps, so the footer says so. The SDK marks the
call experimental: if an update breaks it, the footer says it couldn't get
usage and everything else keeps working.

## Security model

This is a remote shell with no login of its own, so access is Tailscale's job:

- The server binds `127.0.0.1` only; `tailscale serve` is the way in. **Don't
  set `HOST=0.0.0.0`** (or any other address): anyone who can reach the port
  gets a shell as you, with no password.
- **Never expose it with Tailscale Funnel.** Funnel makes a port public on the
  internet. Requests carrying `Tailscale-Funnel-Request` are refused anyway,
  but don't rely on that. Check with `tailscale serve status`.
- WebSocket upgrades and every POST / PATCH / DELETE must come from the app's
  own origin, so other sites open in your browser can't drive it.
- `TV_ALLOWED_LOGINS` narrows access to specific tailnet users. It checks the
  `Tailscale-User-Login` header that `tailscale serve` adds, so it only means
  something while the server listens on `127.0.0.1` behind `tailscale serve`;
  anyone reaching the port directly could forge the header.

Inside those limits there are no others: the palette will start a session in
any folder and type any start command you give it.

## Development

`pnpm dev` (and the launchd dev mode) runs `server.ts` under `tsx watch`:

| You edit                                        | What happens                                                  |
| ----------------------------------------------- | ------------------------------------------------------------- |
| `src/app/**`, `src/components/**`, `src/lib/**` | Next HMR updates open pages in place                          |
| `server.ts`, `src/server/**`, `next.config.ts`  | Server restarts; terminals reconnect, pages reload themselves |

A compile error shows Next's error overlay instead of the app, so keep another
way in (a `prod` install on another port, or plain ssh) while working on the
UI.

Before calling a change done:

```sh
npx prettier --write src server.ts
npx tsc --noEmit
pnpm lint
pnpm build        # safe while dev runs: dev uses .next/dev, build uses .next
```

### How it fits together

```
browser ──https──▶ tailscale serve ──▶ server.ts (127.0.0.1:7700)
                                        ├─ /ws/pty         → pty-bridge: tmux attach in node-pty
                                        ├─ /_next/hmr      → Next dev (HMR)
                                        └─ everything else → Next app + /api routes
```

- `server.ts` — custom Node server: Next.js, the `/ws/pty` upgrade, origin and
  Funnel guards, and the `X-TV-Boot` header pages use to spot a restart
- `src/server/pty-bridge.ts` — one `tmux attach` pty per WebSocket
- `src/server/tmux.ts` — `list-sessions` parsing; new / rename / kill; start
  commands via `send-keys`
- `src/server/repos.ts` — folder listing under `TV_ROOT`, path resolution,
  mkdir / `git init` / `git clone`
- `src/lib/names.ts` — session naming, shared by the palette preview and the
  server; `src/lib/protocol.ts` — WebSocket messages and close codes
- `src/server/usage.ts` — plan usage and account, via the Agent SDK
- `src/app/api/` — `sessions` (GET list, POST create, PATCH rename, DELETE
  kill), `dirs` (GET folders for the palette) and `usage` (GET plan usage)
- `src/components/` — `thunder-vision.tsx` (shell, polling, dialogs),
  `session-sidebar.tsx`, `settings-menu.tsx`, `usage-meters.tsx`,
  `new-session-palette.tsx`, `rename-dialog.tsx`, `terminal-pane.tsx`,
  `key-bar.tsx`; `ui/` is shadcn

### API

Mutating calls take JSON and need a same-origin `Origin` header.

| Call                   | Body                                            | Returns                 |
| ---------------------- | ----------------------------------------------- | ----------------------- |
| `GET /api/sessions`    |                                                 | `TmuxSession[]`         |
| `POST /api/sessions`   | `{dir, create?, git?, clone?, name?, command?}` | 201 `{name, sessions}`  |
| `PATCH /api/sessions`  | `{name, to}`                                    | `{name, sessions}`      |
| `DELETE /api/sessions` | `{name}`                                        | `{sessions}`            |
| `GET /api/dirs`        |                                                 | folders under `TV_ROOT` |
| `GET /api/usage`       |                                                 | `Usage` or `null`       |
| `POST /api/usage`      |                                                 | same, checked now       |

`dir` is relative to `TV_ROOT`, or a `~/…` / absolute path. Errors come back as
`{error}` with 400 (bad folder, git failure), 404 (no such session) or 409
(name taken; includes `{name}`).

`WS /ws/pty?session=<name>&cols=<n>&rows=<n>` streams raw terminal output.
Send `{"t":"i","d":"…"}` for input and `{"t":"r","cols":n,"rows":n}` on resize.
Close code 4000 means the tmux client exited (killed or detached), 4404 means
no such session; the page reconnects on anything else.

## Troubleshooting

- **Page looks out of date.** Pages reload after a server restart, but a tab
  that was backgrounded during a UI-only hot update can miss it. Refresh once.
- **Desktop terminal suddenly small.** tmux sizes a window to its most recently
  active client; typing from the phone shrinks it until you type on the
  desktop again.
- **A start command shows up twice.** It's typed into the new shell before the
  prompt draws, so zsh echoes it once. Harmless.
- **Terminals won't open after an install.** node-pty 1.1.0 ships its macOS
  `spawn-helper` without the execute bit; `scripts/fix-node-pty.mjs` fixes
  that on postinstall, so rerun `pnpm install`.
- **Session names changed.** tmux won't allow `.` or `:` in names, so they
  become `_`. Folders two levels down are named `parent-child`.
- **Plan usage says it couldn't get usage.** Check the log for `usage:` lines.
  Usually Claude Code isn't logged in for this user, or an SDK update changed
  the experimental call.
- **A reset time looks wrong.** It's shown in the viewing device's time zone
  (Claude Code reports UTC). Compare with `/usage` in a session; they read the
  same data.
- **Clone fails on a private repo.** Clones never prompt for credentials, since
  nobody could answer. Use an SSH URL or a credential helper that works
  without prompting.

## License

MIT. See [LICENSE](LICENSE).
