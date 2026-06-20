import type { EscalationMode } from "./types";

/** Hard OS ceiling on pending local notifications per app (spec §3.3). */
export const IOS_NOTIFICATION_HARD_LIMIT = 64;
/** Leave headroom under the hard limit so other tasks can always get a slot. */
export const SAFE_GLOBAL_NOTIFICATION_BUDGET = 60;
/** Cap on any single task's pre-scheduled burst. */
export const MAX_BURST_PER_TASK = 20;
/** Multiplicative shrink applied to the interval on each fire when escalationMode is "shrink". */
export const SHRINK_FACTOR = 0.75;
/** Shrinking interval never goes below this floor. */
export const SHRINK_FLOOR_SECONDS = 30;

export interface NagBurstParams {
  fireAt: Date;
  nagIntervalSeconds: number;
  nagMaxCount?: number | null;
  nagUntil?: Date | null;
  escalationMode?: EscalationMode;
  /** Most notifications this call may return, e.g. a per-task or remaining-global budget. */
  maxNotifications?: number;
  /** Occurrences strictly before `now` are skipped (can't schedule a past trigger). Defaults to current time. */
  now?: Date;
}

/**
 * Walks the nominal fire sequence for a task and returns the future occurrences
 * worth pre-scheduling as iOS local notifications, up to `maxNotifications`.
 *
 * Past occurrences are fast-forwarded through (not returned) but still count
 * against `nagMaxCount`/`nagUntil`, so calling this again later (e.g. on app
 * foreground "re-arm") correctly reflects how much of the burst is left —
 * including a burst that has fully run dry.
 */
export function computeNagBurst(params: NagBurstParams): Date[] {
  const {
    fireAt,
    nagIntervalSeconds,
    nagMaxCount = null,
    nagUntil = null,
    escalationMode = "none",
    maxNotifications = MAX_BURST_PER_TASK,
    now = new Date(),
  } = params;

  if (nagIntervalSeconds <= 0) {
    throw new Error("nagIntervalSeconds must be positive");
  }

  const burst: Date[] = [];
  let nextFire = fireAt.getTime();
  let intervalMs = nagIntervalSeconds * 1000;
  let occurrence = 0;

  while (burst.length < maxNotifications) {
    if (nagMaxCount != null && occurrence >= nagMaxCount) break;
    if (nagUntil != null && nextFire > nagUntil.getTime()) break;

    if (nextFire >= now.getTime()) {
      burst.push(new Date(nextFire));
    }

    occurrence += 1;
    if (escalationMode === "shrink") {
      intervalMs = Math.max(SHRINK_FLOOR_SECONDS * 1000, intervalMs * SHRINK_FACTOR);
    }
    nextFire += intervalMs;
  }

  return burst;
}

export interface SchedulableTask {
  id: string;
  fireAt: Date;
  nagIntervalSeconds: number;
  nagMaxCount?: number | null;
  nagUntil?: Date | null;
  escalationMode?: EscalationMode;
  /** Higher fires first when the global budget is tight. */
  priority?: number;
}

export interface ScheduledBurst {
  taskId: string;
  fireTimes: Date[];
}

/**
 * Spreads a shared global notification budget across multiple active tasks:
 * soonest/highest-priority tasks get scheduled first, each task is capped at
 * `perTaskCap`, and nothing is allocated once the global budget is exhausted.
 * Call this on every app foreground to recompute the whole schedule from
 * the local SQLite mirror (spec §3.3, §5).
 */
export function allocateNotificationBudget(
  tasks: SchedulableTask[],
  options?: { globalBudget?: number; perTaskCap?: number; now?: Date }
): ScheduledBurst[] {
  const {
    globalBudget = SAFE_GLOBAL_NOTIFICATION_BUDGET,
    perTaskCap = MAX_BURST_PER_TASK,
    now = new Date(),
  } = options ?? {};

  const sorted = [...tasks].sort((a, b) => {
    const priorityDiff = (b.priority ?? 0) - (a.priority ?? 0);
    if (priorityDiff !== 0) return priorityDiff;
    return a.fireAt.getTime() - b.fireAt.getTime();
  });

  const results: ScheduledBurst[] = [];
  let remaining = globalBudget;

  for (const task of sorted) {
    if (remaining <= 0) {
      results.push({ taskId: task.id, fireTimes: [] });
      continue;
    }

    const cap = Math.min(perTaskCap, remaining);
    const fireTimes = computeNagBurst({
      fireAt: task.fireAt,
      nagIntervalSeconds: task.nagIntervalSeconds,
      nagMaxCount: task.nagMaxCount,
      nagUntil: task.nagUntil,
      escalationMode: task.escalationMode,
      maxNotifications: cap,
      now,
    });

    results.push({ taskId: task.id, fireTimes });
    remaining -= fireTimes.length;
  }

  return results;
}
