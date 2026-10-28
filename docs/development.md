# Development

`pnpm dev` (and the launchd dev mode) runs `server.ts` under `tsx watch`:

| You edit                                               | What happens                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------- |
| `src/app/**`, `src/components/**`, `src/lib/**`        | Next HMR updates open pages in place                          |
| `server.ts`, `src/server/**`, `next.config.ts`, `.env` | Server restarts; terminals reconnect, pages reload themselves |

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

CI runs lint, build and `tsc` on pushes to main and on pull requests.

## How it fits together

```
browser ──https──▶ tailscale serve ──▶ server.ts (127.0.0.1:7700)
                                        ├─ /ws/pty         → pty-bridge: tmux attach in node-pty
                                        ├─ /ws/log         → log-tail: a job run's output.log
                                        ├─ /_next/hmr      → Next dev (HMR)
                                        └─ everything else → Next app + /api routes
```

Opening a tab runs `tmux attach` in a pty (node-pty) and streams it to xterm.js
over a WebSocket. Closing the page kills only that tmux client, so the session
lives on.

- `server.ts`: custom Node server. Next.js, the `/ws/pty` upgrade, Host,
  origin, cross-site and Funnel guards, and the `X-TV-Boot` header pages use to
  spot a restart
- `src/server/pty-bridge.ts`: one `tmux attach` pty per WebSocket
- `src/server/tmux.ts`: `list-sessions` parsing; new / rename / kill; start
  commands via `send-keys`
- `src/server/repos.ts`: folder listing under `TV_ROOT`, path resolution,
  mkdir / `git init` / `git clone`
- `src/server/usage.ts`: plan usage and account, via the Agent SDK
- `src/server/jobs.ts`: the job and run store (files under `.thunder/`),
  starting, stopping and pruning runs; `scheduler.ts`: a 20s tick in
  `server.ts` that starts due runs; `job-runner.ts`: one detached process per
  run (timeout, Claude's stream-json → readable log); `log-tail.ts`: `/ws/log`
- `src/lib/jobs.ts`: job types, schedule presets ↔ cron, shared with the UI
- `src/lib/names.ts`: session naming, shared by the palette preview and the
  server; `src/lib/protocol.ts`: WebSocket messages and close codes
- `src/app/api/`: `sessions`, `dirs`, `usage`, `jobs` and `runs` routes
- `src/components/`: `thunder-vision.tsx` (shell, polling, dialogs),
  `session-sidebar.tsx`, `settings-menu.tsx`, `usage-meters.tsx`,
  `new-session-palette.tsx`, `rename-dialog.tsx`, `terminal-pane.tsx`,
  `key-bar.tsx`, and for jobs `job-list.tsx`, `job-view.tsx`, `job-dialog.tsx`,
  `log-terminal.tsx`, `run-dots.tsx`; `ui/` is shadcn

Jobs state is all in files, never in memory: the scheduler (loaded by
`server.ts`) and the API routes (bundled by Next) are separate copies of the
module, and runs outlive server restarts. A `running` run whose runner pid is
gone is marked `lost` when next read.

A tab's busy dot pulses while its window printed output in the last 5s.

## API

Mutating calls take JSON and need a same-origin `Origin` header.

| Call                      | Body                                            | Returns                 |
| ------------------------- | ----------------------------------------------- | ----------------------- |
| `GET /api/sessions`       |                                                 | `TmuxSession[]`         |
| `POST /api/sessions`      | `{dir, create?, git?, clone?, name?, command?}` | 201 `{name, sessions}`  |
| `PATCH /api/sessions`     | `{name, to}`                                    | `{name, sessions}`      |
| `DELETE /api/sessions`    | `{name}`                                        | `{sessions}`            |
| `POST /api/sessions/live` | `{name}` (leave copy mode)                      | `{sessions}`            |
| `GET /api/dirs`           |                                                 | folders under `TV_ROOT` |
| `GET /api/usage`          |                                                 | `Usage` or `null`       |
| `POST /api/usage`         |                                                 | same, checked now       |
| `GET /api/jobs`           |                                                 | `JobSummary[]`          |
| `POST /api/jobs`          | `{name, dir, schedule, task, timeoutMin?, …}`   | 201 `{id, jobs}`        |
| `PATCH /api/jobs`         | `{id, …changes}`                                | `{jobs}`                |
| `DELETE /api/jobs`        | `{id, history}`                                 | `{jobs}`                |
| `GET /api/runs?job=`      |                                                 | `Run[]`, newest first   |
| `POST /api/runs`          | `{job}` (run now)                               | `{run, runs}`           |
| `PATCH /api/runs`         | `{job, run}` (stop)                             | `{runs}`                |
| `DELETE /api/runs`        | `{job, run?}` (one, or all finished)            | `{runs}`                |

`dir` is relative to `TV_ROOT`, or a `~/…` / absolute path. Errors come back as
`{error}` with 400 (bad folder, git failure), 403 (cross-site, unknown host),
404 (no such session) or 409 (name taken; includes `{name}`).

`WS /ws/pty?session=<name>&cols=<n>&rows=<n>` streams raw terminal output.
Send `{"t":"i","d":"…"}` for input and `{"t":"r","cols":n,"rows":n}` on resize.
Close code 4000 means the tmux client exited (killed or detached), 4404 means
no such session; the page reconnects on anything else.

`WS /ws/log?job=<id>&run=<id>` streams a run's `output.log` (the last 2MB,
then new output) and closes with 4000 once the run has finished, or 4404 for
no such run.
