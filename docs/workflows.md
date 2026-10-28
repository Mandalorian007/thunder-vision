# Workflows

A workflow is a YAML file of shell steps, run in order, by hand or on a
schedule. A step can be anything your shell can do, and `tv-claude` runs
Claude Code headless, so a typical one chains Claude calls: plan, build,
review, open a PR. In a repo each run gets its own git worktree and branch,
so runs never touch your checkout or each other.

A run has a timeline of steps, a live log, a markdown summary, outputs such as
a PR link, and files it chose to keep. If it fails, its worktree stays, and
**Continue in session** opens Claude right where the failing step left off.

## Where they live

| Kind  | File                                     | Runs in                                 |
| ----- | ---------------------------------------- | --------------------------------------- |
| Repo  | `<repo>/.thunder/workflows/<name>.yml`   | a fresh worktree of that repo (default) |
| Local | `~/.thunder-vision/workflows/<name>.yml` | the folder its `dir:` names             |

Repo workflows are found in folders under `TV_ROOT`, the same two levels the
new session palette lists, and are meant to be committed with the repo.
Local ones are for folders that aren't repos, or for workflows you'd rather
not commit. Files are re-read every few seconds, so edits show up on their own.

A workflow's id is `<repo>--<file>` (`my-app--nightly`) or `local--<file>`.
It names the runs folder and the URL (`#wf:my-app--nightly`), so renaming the
file starts a fresh history.

## Making one

**Workflows → +** in the sidebar asks for a name and a folder. It writes a
commented template, into the repo's `.thunder/workflows/` if the folder is a
repo under `TV_ROOT` or as a local workflow otherwise, then opens a tmux
session running Claude with this page as context, to help you write the
steps. On a workflow's page, **⋯ → Edit with Claude** does the same later,
and a file that doesn't parse shows the error with **Fix with Claude**.

You can also just write the file yourself.

## The file

```yaml
name: Nightly deps # shown in the UI; default: the file name
schedule: "0 6 * * 1-5" # five-field cron, this Mac's local time; omit = manual only
inputs: # asked for on Run; scheduled runs get the defaults
  task:
    description: What to work on
    default: ""
worktree: true # repo default; or { base: develop }; false = run in the folder
timeout: 60 # minutes for the whole run (default 60, at most 1440)
keep: 50 # runs kept on disk (default 50)
steps:
  - id: plan # optional; default step-1, step-2, …
    run: |
      tv-claude "/plan $TV_INPUT_TASK"
  - echo "a step can be a plain string too"
```

- `dir:` is for local workflows only (`~/…`, absolute, or relative to
  `TV_ROOT`). A repo's workflows always run in that repo. Quote a
  bare `"~"`: unquoted, YAML reads it as nothing.
- `inputs:` can also be a list of names, or `name: default` pairs.
- Unknown keys are an error, so a typo doesn't silently do nothing.

## Steps

Each step is a bash script run with `-e -o pipefail`, after your login shell
has set up PATH, so Homebrew tools, `gh` and the like are there even under
launchd. Steps run in the worktree (or the folder), one after another. A
step's exit code decides what happens next:

| Exit     | Means                                                    |
| -------- | -------------------------------------------------------- |
| 0        | carry on to the next step                                |
| 78       | stop here, **no changes**: nothing to do, not a failure  |
| anything | stop here, **failed**; a worktree is kept for you to see |

Steps get these environment variables:

| Variable          | What                                                      |
| ----------------- | --------------------------------------------------------- |
| `TV_INPUT_<NAME>` | each input, upper-cased, `-` → `_`                        |
| `TV_OUTPUT`       | a file: append `key=value` lines (see below)              |
| `TV_OUT_<KEY>`    | outputs earlier steps wrote                               |
| `TV_SUMMARY`      | a file: markdown shown at the top of the run              |
| `TV_ARTIFACTS`    | a folder: files kept with the run, linked from its page   |
| `TV_BRANCH`       | the run's branch (worktree runs)                          |
| `TV_BASE`         | what it branched from, e.g. `origin/main` (worktree runs) |
| `TV_WORKTREE`     | the worktree's path (worktree runs)                       |
| `TV_WORKFLOW`     | the workflow id                                           |
| `TV_RUN`          | the run id (`20261028-060000`)                            |
| `TV_STEP`         | this step's id                                            |
| `TV_TRIGGER`      | `manual`, `schedule` or `catch-up`                        |

### Outputs

`$TV_OUTPUT` takes the same format as GitHub Actions' `$GITHUB_OUTPUT`:

```sh
echo "pr=$(gh pr create --fill)" >> "$TV_OUTPUT"
{
  echo "notes<<EOF"
  cat notes.txt
  echo "EOF"
} >> "$TV_OUTPUT"
```

Keys are letters, digits, `_` and `-`; a later step's value wins. Outputs
show on the run's page (URLs as links), and a `pr` output also gets a chip in
the sidebar and the run list.

### Claude in a step

`tv-claude` (on PATH in every step) is `claude -p --permission-mode auto`
with stream-json output, which the runner turns into a readable log. It
takes a prompt as an argument or on stdin, plus any `claude` flags:

```yaml
- id: build
  run: |
    tv-claude --model sonnet "Implement the plan in PLAN.md. Commit when tests pass."
- id: review
  run: |
    tv-claude --model opus <<EOF
    Review the diff against $TV_BASE. Fix what you find and commit.
    EOF
```

The runner remembers each step's Claude session and final message. If no
step writes `$TV_SUMMARY`, the last Claude message is the run's summary.
Claude runs in auto mode in the worktree, with your usual settings, `CLAUDE.md`
and permissions. Calls count against your plan like any other session.

The `claude` it runs is `CLAUDE_BIN`, else `~/.local/bin/claude`, else
`claude` on PATH.

## Worktrees

With `worktree: true` (the default in a repo), each run:

1. fetches `origin` (if that fails, it carries on from what's local);
2. adds a worktree at `~/.thunder-vision/worktrees/<workflow>/<run>` on a new
   branch `tv/<file>/<run>`, from `origin`'s default branch or `base:`;
3. runs the steps there.

Then:

- **ok** or **no changes**: the worktree is removed. So is the branch, unless
  it has commits that were never pushed; those are kept and the run says so.
- **failed**, **timed out** or **stopped**: the worktree is kept. The run's
  page offers **Continue in session** and **Discard worktree** (which
  deletes the branch too).

Your repo's own `.env` and other untracked files aren't in a fresh worktree.
If the steps need them, copy them in a first step, e.g.
`cp ~/repos/my-app/.env .`. Git hooks and the repo's config do apply.

Because each run has its own worktree, you can start another while one is
going. Without a worktree, runs of the same workflow never overlap.

## Runs

**Run** starts one now, asking for inputs first if there are any. A run's
status is one of:

| Dot       | Status     | Meaning                                            |
| --------- | ---------- | -------------------------------------------------- |
| green     | ok         | every step exited 0                                |
| dash      | no changes | a step exited 78                                   |
| red       | failed     | a step exited non-zero, or the folder was missing  |
| red       | timed out  | hit the workflow's timeout                         |
| red       | lost       | the runner died mid-run (reboot, crash)            |
| grey      | stopped    | you pressed Stop                                   |
| hollow    | skipped    | the previous run was still going when this was due |
| lightning | running    | the log streams live                               |

A run's page has the result (PR, branch, worktree), a timeline of steps,
the summary with a Copy button, outputs, artifacts, and the log, whole or
one step at a time. On a phone, Details and Log are tabs.

**Continue in session** opens a tmux session in the run's worktree (or the
folder, once it's gone) running `claude --resume` on the failing step's
Claude session, or the last one. Timeouts and **Stop** send SIGTERM to the
step and everything it started, then SIGKILL 10s later.

## Schedules

`schedule:` is five-field cron in this Mac's local time:
`0 6 * * 1-5` (weekdays at 6), `*/30 9-17 * * *`, `0 * * * *`.

- A **repo** workflow's schedule starts **paused**: cloning or pulling a repo
  should never put its code on a timer. Press **Resume** on its page once.
  Changing the schedule in the file later keeps it on.
- A **local** workflow's schedule starts on.
- **Pause** stops the schedule only; Run still works.

Each run is its own detached process, so it carries on if the server
restarts and records how it ended. The scheduler remembers how far it has
fired. When the server comes back, a workflow that missed runs gets **one**
(marked `catch-up`), not one per missed time. Resuming, or editing the
schedule, never fires for times in the past.

Workflows only run on schedule while Thunder Vision is running: install the
launchd agent ([configuration](configuration.md#launchd-macos)) and keep the
Mac awake.

## Example: issue to PR

```yaml
name: Issue to PR
inputs:
  issue:
    description: GitHub issue number
steps:
  - id: plan
    run: |
      gh issue view "$TV_INPUT_ISSUE" > "$TV_ARTIFACTS/issue.md"
      tv-claude --model opus "Read $TV_ARTIFACTS/issue.md and write a plan to $TV_ARTIFACTS/plan.md. Don't change code."
  - id: build
    run: |
      tv-claude "Implement $TV_ARTIFACTS/plan.md. Run the tests. Commit when they pass."
      # Nothing committed: stop as "no changes", not a failure.
      [ "$(git rev-list --count "$TV_BASE..HEAD")" -gt 0 ] || exit 78
  - id: review
    run: |
      tv-claude --model opus "Review the commits since $TV_BASE as a strict reviewer. Fix real problems and commit."
  - id: pr
    run: |
      git push -q -u origin HEAD
      url=$(gh pr create --fill --body "Closes #$TV_INPUT_ISSUE")
      echo "pr=$url" >> "$TV_OUTPUT"
      git log --format='- %s' "$TV_BASE..HEAD" > "$TV_SUMMARY"
```

## Deleting

- A run: the trash button on its page. If it kept a worktree, that goes too
  (you're asked first).
- All of a workflow's finished runs: **⋯ → Clear history**.
- A workflow: delete its file. Its runs stay on disk under
  `~/.thunder-vision/runs/` until you remove them.

Old runs are pruned past `keep`, except ones whose worktree was kept.

## Files

```
~/.thunder-vision/                 or TV_DATA_DIR
├─ workflows/<name>.yml            local workflows
├─ state.json                      paused or not, how far each schedule fired
├─ order.json                      the sidebar order, once dragged
├─ usage.json                      the last good plan usage check
├─ runs/<workflow>/<run>/
│  ├─ run.json                     status, steps, outputs, worktree
│  ├─ spec.json                    exactly what was run, with what env
│  ├─ output.log                   what the log view shows
│  ├─ summary.md                   $TV_SUMMARY
│  ├─ artifacts/                   $TV_ARTIFACTS
│  └─ steps/<n>-<id>.{sh,out,jsonl} each step's script, outputs, Claude JSON
├─ worktrees/<workflow>/<run>/     worktrees, while running or kept
└─ uploads/                        files from the key bar's paperclip
```

Artifacts are served as downloads, except plain text, images and PDFs,
which open in the browser. Nothing a run writes is served as a page.

## Coming from scheduled jobs

Workflows replace scheduled jobs. At its first start, this version moves
`.thunder/` from the app folder to `~/.thunder-vision`, turns each job into a
one-step local workflow (`tv-claude …` or your shell command, with the same
folder, schedule and paused state), and keeps its run history. The old
`jobs.json` is left as `~/.thunder-vision/jobs.json.migrated`.
