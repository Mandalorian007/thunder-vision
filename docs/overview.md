# Overview

Any tmux session running Claude Code gets an **Overview** tab next to
**Terminal**. It's a read-only view of where the work stands, built for long
sessions that coordinate many subagents: you see progress and the big calls
without asking the session for a report. Claude stays in charge; the Overview
never types into the session or changes anything.

## What's on it

**Summary** (the default view):

- **Goal and headline**: what the session is driving toward and where it is.
- **Waiting on you**: anything the session is blocked on you for.
- **Areas**: the workstreams as the session itself frames them, each with a
  state (done, on track, at risk, blocked, idle). A progress bar appears only
  when the session reported counts for that area. Tap one for now, next and
  its sources.
- **Decisions worth a look**: the big calls, marked as the session's or
  yours, with the reasoning.
- **Lately** and **Next**: a few lines each.
- **In flight** and **Landed**: running agents and the latest reports, merges
  and PRs, counted by script.

Every Haiku claim has a **src** button that shows the transcript lines it came
from, so you can check or challenge it in the session.

**Full log**: the whole activity feed (your messages, agent starts and
reports, PRs, releases, failures), finished agents and pull requests.

## Where the data comes from

Two layers, kept apart:

1. **Facts, by script.** Claude Code records each interactive session in
   `~/.claude/sessions/<pid>.json`, including the tmux pane it runs in. That
   leads to the transcript under `~/.claude/projects/`, which is parsed
   incrementally into agents, events and PRs. No model is involved, and
   nothing is added to your Claude sessions (no hooks, no status line).
2. **The summary, by Haiku.** On refresh, a digest of the transcript (the
   last compaction summary plus the most recent ~140k characters) goes to a
   headless `claude -p --model haiku` call that returns structured JSON. The
   call has no tools, no settings, no MCP servers and no saved session, is
   capped at $0.50, and is told the transcript is data, not instructions.
   Claims must cite transcript lines; unknown citations are dropped.

A refresh typically takes 20–40 seconds and costs a couple of cents. It runs
through Claude Code's own login, so it counts against your Claude plan.

## Refreshing

The bar above the summary has **⟳ Refresh** and an interval: **Manual**
(the default), every 15m, 30m, 1h or 6h. The interval is per session, stored
on the tmux session as the `@tv_overview_every` option, so it survives
restarts and renames.

Scheduled refreshes:

- skip when nothing notable has happened since the last summary,
- retry 10 minutes after a failure,
- pause after three failures in a row, until you refresh by hand.

A failed refresh keeps the previous summary on screen with a red note.

## Files

Per pane, under `~/.thunder-vision/overview/pane-<n>/`: `state.json` (parsed
facts), `summary.json` (the last summary, tied to the Claude process it
describes, since tmux reuses pane ids), `seen.json` and a `summary.lock`
while a refresh runs. Folders of panes gone for a week are removed.
