# Troubleshooting

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
- **Plan usage says it couldn't get usage.** Check
  `~/Library/Logs/thunder-vision.log` (or the `pnpm dev` terminal) for
  `usage:` lines. Usually Claude Code
  isn't logged in for this user, or an SDK update changed the experimental
  call.
- **A reset time looks wrong.** It's shown in the viewing device's time zone
  (Claude Code reports UTC). Compare with `/usage` in a session; they read the
  same data.
- **Clone fails on a private repo.** Clones never prompt for credentials, since
  nobody could answer. Use an SSH URL or a credential helper that works
  without prompting.
- **`403 unknown host`.** It only answers to `localhost` and `*.ts.net` names.
  Use the MagicDNS URL, not a Tailscale IP, LAN name or another proxy.
