import { planNagNotifications, type Task } from "@alarmed/core";

/**
 * The web counterpart to `apps/mobile/src/notifications/scheduler.ts`. Both
 * feed the same pure `planNagNotifications` plan into a platform queue, so
 * the decisions (which fires, in what order, within budget) are identical.
 *
 * The queues themselves aren't: iOS lets us pre-schedule a burst that fires
 * even if the app is force-closed. Browsers have no equivalent without a
 * push server, so this arms plain `setTimeout`s that fire a `Notification`
 * while this tab stays open — closing or reloading the tab drops them. See
 * apps/web/README.md for the tradeoff; Supabase + Web Push (Phase 3) is the
 * path to closing this gap.
 */

let timers = new Map<string, ReturnType<typeof setTimeout>>();

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
  tasks: Task[]
): Promise<RescheduleResult> {
  clearAllTimers();

  const planned = planNagNotifications(tasks);

  for (const p of planned) {
    const delay = Math.max(0, p.fireAt.getTime() - Date.now());
    const timer = setTimeout(() => {
      timers.delete(p.identifier);
      if (Notification.permission === "granted") {
        new Notification(p.title, { body: p.body, tag: p.identifier });
      }
    }, delay);
    timers.set(p.identifier, timer);
  }

  return { scheduledCount: planned.length };
}
