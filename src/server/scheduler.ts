import {
  listWorkflows,
  migrate,
  settleAll,
  startRun,
  takeDue,
} from "./workflows";

const TICK_MS = 20_000;
/** Later than this (asleep, server down) and it's recorded as a catch-up. */
const LATE_MS = 2 * 60_000;

/**
 * Fires due workflows. takeDue() saves the fire time before the run starts,
 * so a restart mid-tick can't fire it twice. Missed times collapse into one
 * catch-up run, not one per miss.
 */
function tick() {
  const now = new Date();
  let workflows;
  try {
    workflows = listWorkflows();
  } catch (err) {
    // Thrown from a timer, this would crash the server every tick.
    console.error("[workflows] couldn't list workflows:", err);
    return;
  }
  for (const wf of workflows) {
    try {
      const due = takeDue(wf, now);
      if (!due) continue;
      const late = now.getTime() - due.getTime() > LATE_MS;
      startRun(wf, late ? "catch-up" : "schedule");
    } catch (err) {
      console.error(`[workflows] ${wf.id} failed to start:`, err);
    }
  }
}

let started = false;

/**
 * Called once by server.ts. Moves old scheduled jobs over, then settles
 * runs whose runner died while the server was down.
 */
export function startScheduler() {
  if (started) return;
  started = true;
  try {
    migrate();
  } catch (err) {
    console.error("[workflows] couldn't move the old scheduled jobs:", err);
  }
  try {
    settleAll();
  } catch (err) {
    console.error("[workflows] couldn't settle old runs:", err);
  }
  tick();
  setInterval(tick, TICK_MS).unref();
}
