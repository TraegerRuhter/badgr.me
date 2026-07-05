import {
  buildNotificationId,
  planNagNotifications,
  type CopyResult,
  type PlanOptions,
  type Task,
} from "@alarmed/core";

/**
 * The web counterpart to `apps/mobile/src/notifications/scheduler.ts`. Both
 * feed the same pure `planNagNotifications` plan into a platform queue, so
 * the decisions (which fires, in what order, within budget) are identical.
 *
 * The queues themselves aren't: iOS lets us pre-schedule a burst that fires
 * even if the app is force-closed. Browsers have no equivalent without a
 * push server, so this arms plain `setTimeout`s that fire a `Notification`
 * while this tab stays open — closing or reloading the tab drops them. See
 * apps/web/README.md for the tradeoff; a Web Push backend is the path to
 * closing this gap.
 */

let timers = new Map<string, ReturnType<typeof setTimeout>>();

// setTimeout stores its delay in a 32-bit int; anything larger overflows and
// fires (almost) immediately. Skip timers beyond this — they get re-armed on
// the next reschedule (foreground/change), by which point they're in range.
const MAX_TIMEOUT_MS = 2_147_483_647;

export async function requestNotificationPermissions(): Promise<boolean> {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  const result = await Notification.requestPermission();
  return result === "granted";
}

function clearAllTimers(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers = new Map();
}

/**
 * Arms (or replaces) a single notification timer. Returns whether it was
 * actually scheduled — a fire time too far out is skipped rather than firing
 * immediately. Shared by the full reschedule and the post-snooze AI overlay.
 */
function armNotification(identifier: string, fireAt: Date, copy: CopyResult): boolean {
  const existing = timers.get(identifier);
  if (existing) clearTimeout(existing);
  timers.delete(identifier);

  const delay = fireAt.getTime() - Date.now();
  if (delay > MAX_TIMEOUT_MS) return false;

  const timer = setTimeout(() => {
    timers.delete(identifier);
    if (Notification.permission === "granted") {
      new Notification(copy.title, { body: copy.body, tag: identifier });
    }
  }, Math.max(0, delay));
  timers.set(identifier, timer);
  return true;
}

export interface RescheduleResult {
  scheduledCount: number;
}

/**
 * Recomputes the entire pending set from the current tasks and re-arms the
 * tab to match (clear stale timers, arm the budgeted burst). Idempotent and
 * safe to call after any task change, mirroring the native scheduler's
 * re-arm semantics.
 */
export async function rescheduleAllNotifications(
  tasks: Task[],
  options?: PlanOptions
): Promise<RescheduleResult> {
  clearAllTimers();

  let scheduledCount = 0;
  for (const p of planNagNotifications(tasks, options)) {
    if (armNotification(p.identifier, p.fireAt, { title: p.title, body: p.body })) {
      scheduledCount += 1;
    }
  }

  return { scheduledCount };
}

/**
 * Best-effort overwrite of just the immediate next occurrence's copy, used
 * after a snooze once the nag-ai proxy (or its template fallback) returns a
 * line. Mirrors `apps/mobile/src/notifications/scheduler.ts`'s
 * `overlayNextOccurrenceCopy`, replacing the timer under the same
 * `nag:{taskId}:0` identifier.
 */
export async function overlayNextOccurrenceCopy(
  taskId: string,
  fireAt: Date,
  copy: CopyResult
): Promise<void> {
  armNotification(buildNotificationId(taskId, 0), fireAt, copy);
}
