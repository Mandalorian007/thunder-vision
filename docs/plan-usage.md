# Plan usage

The sidebar footer shows what `/usage` shows: the plan, the login email, and
the session (rolling 5-hour) and weekly caps, each with when it resets. Reset
times are in the viewing device's time zone. Bars turn amber at 75% and red at
90%. In the collapsed sidebar they become two rings, with details in a tooltip.

## Where the numbers come from

The server asks Claude Code itself, through the
[Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)
(`usage_EXPERIMENTAL…()` and `accountInfo()`):

- It starts `claude` (the SDK's bundled copy, or `CLAUDE_BIN`) with no prompt,
  so nothing goes to a model, no session is saved and no settings or hooks
  load. Claude Code uses its own login; Thunder Vision never sees the token.
- A check takes about half a second and runs on the hour (10:00, 11:00…), only
  while a page is open. Every open page shares the answer, so the numbers can
  be up to an hour behind `/usage`; the header says when they were checked.
- The refresh button by the plan name checks straight away (at most once every
  30 seconds, however many pages ask), and the next check is still on the
  hour. Restarting the server also checks straight away.
- A failed check retries after a minute. Meanwhile the last numbers stay up,
  and "checked … ago" turns amber once they're over 70 minutes old. A window
  whose reset time passes drops to 0% within 30 seconds.

## Setup

Nothing beyond being logged in to Claude Code (`claude` → `/login`) as the user
the server runs as. API-key logins have no plan caps, so the footer says so.
The SDK marks the call experimental: if an update breaks it, the footer says it
couldn't get usage and everything else keeps working.
