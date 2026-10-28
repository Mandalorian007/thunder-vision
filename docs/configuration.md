# Configuration

Everything specific to your machine goes in `.env` (copy `.env.example`), which
git ignores. Every setting is optional. Variables already set in the
environment win over `.env`. The server reads it at startup, and `pnpm dev`
restarts when you save it.

| Variable            | Default                | Purpose                                              |
| ------------------- | ---------------------- | ---------------------------------------------------- |
| `TV_ROOT`           | `~/repos`              | Folders the palette lists; new folders land here     |
| `PORT`              | `7700`                 | Listen port, always on `127.0.0.1` ([why][sec])      |
| `TV_ALLOWED_LOGINS` | _(anyone on tailnet)_  | Comma-separated Tailscale logins allowed in          |
| `TMUX_BIN`          | `tmux`                 | tmux binary (set when PATH is minimal, e.g. launchd) |
| `CLAUDE_BIN`        | _(see purpose)_        | `claude` for workflows and plan usage ([more][wf])   |
| `TV_DATA_DIR`       | `~/.thunder-vision`    | Runs, worktrees, local workflows, uploads            |
| `TV_LAUNCHD_LABEL`  | `local.thunder-vision` | launchd label used by `scripts/install-launchd.sh`   |

[sec]: ../README.md#security
[wf]: workflows.md#claude-in-a-step

`TV_ALLOWED_LOGINS` checks the `Tailscale-User-Login` header that
`tailscale serve` adds, so it only means something while the server listens on
`127.0.0.1` behind `tailscale serve`. Anyone reaching the port directly could
forge the header. List your tailnet's logins with
`tailscale status --json | jq -r '.User[].LoginName'`.

## The new session palette

The palette (⌘K or **+**) lists folders under `TV_ROOT`, two levels deep. You
can also type:

- a new name → **Create** it under `TV_ROOT`, optionally with `git init`
- a `~/…` or `/…` path → start there (created if missing)
- a git URL (`https://…`, `git@…`, `ssh://…`) → **Clone** into
  `TV_ROOT/<repo>` and start there

**Tab** on a row (the sliders button on touch) opens its options: session name,
a start command (recent ones plus `claude`, `claude --resume`,
`claude --continue`) and `git init`. If the name is taken, you're offered the
existing session instead.

Rename and kill a session from its tab's ⋯ menu, or right-click / long-press
the tab. Text size, the key bar and the theme are under the settings button by
the title, remembered per device.

## launchd (macOS)

`scripts/install-launchd.sh` installs a per-user agent that starts at login and
restarts on crash. It reads `.env` for the label and port, and bakes the current
`node` and `tmux` paths (or your `TMUX_BIN`) into the plist, since launchd's
PATH is minimal. If you switch Node versions with nvm or fnm, rerun it.

```sh
./scripts/install-launchd.sh                      # dev mode: live reload (default)
pnpm build && ./scripts/install-launchd.sh prod   # stable build
tail -f ~/Library/Logs/thunder-vision.log
launchctl kickstart -k gui/$(id -u)/local.thunder-vision   # restart
launchctl bootout gui/$(id -u)/local.thunder-vision        # stop / uninstall
```

Use your `TV_LAUNCHD_LABEL` in place of `local.thunder-vision` if you set one;
the script prints the exact commands. Rerun it after changing the label or
switching modes. Other `.env` changes only need a restart.

## Updating

```sh
git pull && pnpm install
pnpm build && launchctl kickstart -k gui/$(id -u)/local.thunder-vision   # prod mode
```

Dev mode picks up the pull on its own.

## Linux

The app isn't Mac-specific, only the launchd script is. node-pty builds from
source there, so install a compiler first (`build-essential` and `python3` on
Debian/Ubuntu). Then run `pnpm build && pnpm start` under systemd or similar,
with the same `.env`.

## Tailscale notes

`tailscale serve` settings survive reboots. If you changed `PORT`, use
`--https=<PORT>` with it. `tailscale status` lists the machine name; the
tailnet name is on the [DNS page](https://login.tailscale.com/admin/dns).
Requests carrying `Tailscale-Funnel-Request` are refused, but don't rely on
that: check `tailscale serve status` says "(tailnet only)".
