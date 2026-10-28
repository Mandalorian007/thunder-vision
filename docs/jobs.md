# Scheduled jobs

A job runs Claude or a shell command in a folder on a schedule, and keeps a
history of runs: green and red dots in the sidebar, a log for each run, and
Claude's final message up top.

## Making one

**Jobs → +** in the sidebar. A job has:

- **Name**: also its id (`Morning triage` → `morning-triage`), which names its
  runs folder and never changes.
- **Folder**: like the new session palette: relative to `TV_ROOT`, `TV_ROOT`
  itself (listed as "all repos"), or `~/…` or an absolute path.
- **Claude** or **Shell**:
  - Claude runs the prompt with `claude -p --permission-mode auto`. A custom
    slash command (`/my-workflow` in `.claude/commands/`) works well: build
    and test it interactively, then schedule it. The prompt goes in on stdin.
  - Shell runs the command in your login shell (`$SHELL -lc`), so your PATH
    and Homebrew tools are there even under launchd.
- **When**: at a time, every hour or every 5–30 minutes, on the days you pick,
  or any five-field cron
  (`*/15 9-17 * * 1-5`). Times are this Mac's local time.
- **More options**:
  - model (sonnet, opus or fable; default sonnet) and effort (low to max;
    default medium), for Claude
  - **timeout**: minutes before the run is stopped (default 30, at most
    1440). It gets SIGTERM, then SIGKILL 10s later; everything it started goes
    too.
  - **keep runs**: older runs are deleted as new ones start (default 50).

## Runs

**Run now** starts one immediately. A run's status is one of:

| Dot       | Status    | Meaning                                            |
| --------- | --------- | -------------------------------------------------- |
| green     | ok        | exit 0 (and, for Claude, a result without error)   |
| red       | failed    | non-zero exit, Claude error, or a missing folder   |
| red       | timed out | hit the job's timeout                              |
| red       | lost      | the runner died mid-run (reboot, crash)            |
| grey      | stopped   | you pressed Stop, or deleted the job while running |
| hollow    | skipped   | the previous run was still going                   |
| lightning | running   | the log streams live                               |

Runs don't overlap: if one is still going when the next is due, that one is
recorded as skipped.

A run's page shows the final message (Claude's `result`) with a Copy button,
then the full log. **Continue in session** opens a tmux session in the job's
folder running `claude --resume <session>`, so you can pick up where the
scheduled run left off.

## When the server is down

Each run is its own detached process, so it carries on if the server restarts
and records how it ended. The scheduler remembers how far it has fired; when
the server comes back it runs each missed job **once** (marked `catch-up`),
not once per missed time. Pausing and resuming, or editing the schedule, never
fires for times in the past.

Jobs only run while Thunder Vision is running: install the launchd agent
([configuration](configuration.md#launchd-macos)) and keep the Mac awake.

## Deleting

- A run: the trash button on its page.
- All of a job's runs: **⋯ → Clear history**.
- A job: **⋯ → Delete job**, with a choice to keep its runs on disk. A running
  run is stopped first.

## Files

Everything lives in `.thunder/` in the app folder (gitignored), or in
`TV_DATA_DIR`:

```
.thunder/
├─ jobs.json                     every job, with its schedule state
└─ runs/<job>/<YYYYMMDD-HHMMSS>/
   ├─ run.json                   status, times, exit code, Claude's result
   ├─ spec.json                  exactly what was run, with what env
   ├─ output.log                 what the log view shows
   └─ raw.jsonl                  Claude's stream-json output, as-is
```

The `claude` that jobs run is `CLAUDE_BIN`, else `~/.local/bin/claude`, else
`claude` on PATH.
