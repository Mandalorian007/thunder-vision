import { dueAt, listRuns, readJobs, startRun, updateJobs } from "./jobs";

const TICK_MS = 20_000;
/** Later than this (asleep, server down) and it's recorded as a catch-up. */
const LATE_MS = 2 * 60_000;

/**
 * Fires due jobs. Each job's `scheduledThrough` is saved before its run
 * starts, so a restart mid-tick can't fire it twice. Missed times collapse
 * into one catch-up run, not one per miss.
 */
function tick() {
  const now = new Date();
  for (const job of readJobs()) {
    const due = dueAt(job, now);
    if (!due) continue;
    const fresh = updateJobs((jobs) => {
      const j = jobs.find((x) => x.id === job.id);
      if (j) j.scheduledThrough = now.toISOString();
      return j;
    });
    if (!fresh) continue;
    const late = now.getTime() - due.getTime() > LATE_MS;
    try {
      startRun(fresh, late ? "catch-up" : "schedule");
    } catch (err) {
      console.error(`[jobs] ${job.id} failed to start:`, err);
    }
  }
}

let started = false;

/** Called once by server.ts. Also settles runs whose runner died while we were down. */
export function startScheduler() {
  if (started) return;
  started = true;
  for (const job of readJobs()) listRuns(job.id, 5);
  tick();
  setInterval(tick, TICK_MS).unref();
}
