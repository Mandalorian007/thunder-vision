# Configuration

Everything specific to your machine goes in `.env` (copy `.env.example`), which
git ignores. Every setting is optional. Variables already set in the
environment win over `.env`. The server reads it at startup, and `pnpm dev`
restarts when you save it.

| Variable                 | Default                 | Purpose                                              |
| ------------------------ | ----------------------- | ---------------------------------------------------- |
| `TV_ROOT`                | `~/repos`               | Folders the palette lists; new folders land here     |
| `PORT`                   | `7700`                  | Listen port, always on `127.0.0.1` ([why][sec])      |
| `TV_ALLOWED_LOGINS`      | _(anyone on tailnet)_   | Comma-separated Tailscale logins allowed in          |
| `TMUX_BIN`               | `tmux`                  | tmux binary (set when PATH is minimal, e.g. launchd) |
| `CLAUDE_BIN`             | _(see purpose)_         | `claude` for workflows, usage, Overview ([more][wf]) |
| `TV_DATA_DIR`            | `~/.thunder-vision`     | Runs, worktrees, workflows, uploads, Overview        |
| `TV_LAUNCHD_LABEL`       | `local.thunder-vision`  | launchd label used by `scripts/install-launchd.sh`   |
| `TV_WHISPER_MODEL`       | _(see [Voice](#voice))_ | whisper.cpp model for the mic                        |
| `TV_WHISPER_DRAFT_MODEL` | _(see [Voice](#voice))_ | Faster model for the live draft while you talk       |
| `TV_WHISPER_LANG`        | `en`                    | Spoken language (`auto` to detect)                   |
| `WHISPER_SERVER_BIN`     | `whisper-server`        | whisper.cpp server, kept warm while you talk         |
| `WHISPER_BIN`            | `whisper-cli`           | Fallback when the server won't start                 |
| `FFMPEG_BIN`             | `ffmpeg`                | ffmpeg, for clips that aren't already 16 kHz WAV     |

[sec]: ../README.md#security
[wf]: workflows.md#claude-in-a-step

`TV_ALLOWED_LOGINS` checks the `Tailscale-User-Login` header that
`tailscale serve` adds, so it only means something while the server listens on
`127.0.0.1` behind `tailscale serve`. Anyone reaching the port directly could
forge the header. List your tailnet's logins with
`tailscale status --json | jq -r '.User[].LoginName'`.

## Voice

The mic button transcribes on this Mac with [whisper.cpp], so it needs
whisper.cpp and two models: an accurate one for the text that gets typed, and
a fast one for the grey draft you watch while you talk.

```sh
brew install whisper-cpp ffmpeg
mkdir -p ~/.whisper && cd ~/.whisper
base=https://huggingface.co/ggerganov/whisper.cpp/resolve/main
curl -LO $base/ggml-large-v3-turbo-q5_0.bin   # typed text, 574 MB
curl -LO $base/ggml-base.en.bin               # live draft, 148 MB
```

How it runs: the page records raw 16 kHz audio. About every half second it
sends the phrase so far for a draft (`base.en`, ~0.1s), and at each pause it
sends the whole phrase for the final pass (`large-v3-turbo`, ~1s), which is
typed in. The app starts one `whisper-server` per model on a free loopback
port when the mic opens (~0.25s), and stops them a minute after the last
phrase, so the ~1 GB they hold is only used while you talk. Without
`whisper-server` it falls back to one `whisper-cli` run per phrase, with no
drafts.

Without `TV_WHISPER_MODEL` the final pass uses the first of these in
`~/.whisper`: `ggml-large-v3-turbo-q5_0.bin` (good with code words), the other
`large-v3-turbo` builds, `ggml-small.en.bin`, `ggml-base.en.bin`. Without
`TV_WHISPER_DRAFT_MODEL` drafts use `ggml-base.en.bin`, `ggml-base.bin`,
`ggml-tiny.en.bin` or `ggml-small.en.bin`, else the final model (about a
draft a second).

The browser only offers the mic on the `https://` tailnet address, and asks
for permission the first time. On iOS, if you said no, allow it again under
Settings → Apps → Safari → Microphone (or the site's aA menu).

[whisper.cpp]: https://github.com/ggml-org/whisper.cpp

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
