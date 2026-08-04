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
  /**
   * Occurrences already "used up" before this walk begins, counted against
   * `nagMaxCount`. Snoozing reschedules `fireAt` into the future, so those
   * fires would otherwise never be charged against the cap; passing the
   * snooze count here keeps `nagMaxCount` an absolute lifetime ceiling
   * (a "6×" task nags at most 6 times total, however often it's snoozed).
   */
  priorOccurrences?: number;
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
    priorOccurrences = 0,
    now = new Date(),
  } = params;

  if (nagIntervalSeconds <= 0) {
    throw new Error("nagIntervalSeconds must be positive");
  }

  const burst: Date[] = [];
  let nextFire = fireAt.getTime();
  let intervalMs = nagIntervalSeconds * 1000;
  let occurrence = priorOccurrences;

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

export interface RoundsBurstParams {
  fireAt: Date;
  intervalSeconds: number;
  /** "Count" mode of §3.4's cap. Mutually exclusive with `durationSeconds`. */
  maxCount?: number | null;
  /** "Duration" mode: stop this many seconds after `fireAt`. Mutually exclusive with `maxCount`. */
  durationSeconds?: number | null;
  maxNotifications?: number;
  now?: Date;
}

/**
 * Rounds' own walk (plan §3.4): the reminder itself recurs every
 * `intervalSeconds`, capped by count or by a duration measured from
 * `fireAt`. Deliberately just a translation into `computeNagBurst` rather
 * than a second walk, so Rounds can never drift from the one planner —
 * that's what invariant U2's gate checks.
 */
export function computeRoundsBurst(params: RoundsBurstParams): Date[] {
  const {
    fireAt,
    intervalSeconds,
    maxCount = null,
    durationSeconds = null,
    maxNotifications,
    now,
  } = params;

  return computeNagBurst({
    fireAt,
    nagIntervalSeconds: intervalSeconds,
    nagMaxCount: maxCount,
    nagUntil: durationSeconds != null ? new Date(fireAt.getTime() + durationSeconds * 1000) : null,
    escalationMode: "none",
    maxNotifications,
    now,
  });
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
  /** Times this task has been snoozed; consumed against `nagMaxCount` so snoozing can't reset the cap. */
  snoozeCount?: number;
  /** Seconds of heads-up before the first fire, or null/0 for none. */
  leadTimeSeconds?: number | null;
  /** Rounds' interval (plan §3.4), or null/undefined when Rounds is off. */
  roundsIntervalSeconds?: number | null;
  /** Rounds' cap, "Count" mode. Mutually exclusive with `roundsDurationSeconds`. */
  roundsMaxCount?: number | null;
  /** Rounds' cap, "Duration" mode. Mutually exclusive with `roundsMaxCount`. */
  roundsDurationSeconds?: number | null;
}

export interface ScheduledBurst {
  taskId: string;
  fireTimes: Date[];
  /**
   * Rounds' own fire times (plan §3.4), separate from `fireTimes` because
   * they're a second, independent schedule — not part of the Nag-Me
   * sequence and not counted against `nagMaxCount`. Empty when Rounds is
   * off or the budget ran out before reaching it.
   */
  roundsFireTimes: Date[];
  /**
   * The pre-alarm heads-up, when one is configured, still in the future, and
   * the budget stretched to it. Separate from `fireTimes` because it is not
   * part of the nag sequence: it fires *before* the task is due and must not
   * count against `nagMaxCount`.
   */
  preAlarm?: Date;
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
      results.push({ taskId: task.id, fireTimes: [], roundsFireTimes: [] });
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
      priorOccurrences: task.snoozeCount ?? 0,
      now,
    });
    remaining -= fireTimes.length;

    /*
     * Rounds is allocated right after the Nag-Me burst and before the
     * pre-alarm: a Rounds fire is still the task actually being due, just
     * later in the day, which outranks a mere heads-up when the budget is
     * tight (same reasoning as the pre-alarm ordering below).
     */
    const roundsCap = Math.min(perTaskCap, remaining);
    const roundsFireTimes =
      task.roundsIntervalSeconds != null && roundsCap > 0
        ? computeRoundsBurst({
            fireAt: task.fireAt,
            intervalSeconds: task.roundsIntervalSeconds,
            maxCount: task.roundsMaxCount,
            durationSeconds: task.roundsDurationSeconds,
            maxNotifications: roundsCap,
            now,
          })
        : [];
    remaining -= roundsFireTimes.length;

    /*
     * The pre-alarm is allocated *after* the burst, deliberately. With one slot
     * left, the notification at the actual fire time is worth more than the
     * heads-up before it — a task that buzzes on time beats one that only warns
     * you it is coming. Charged against the same budget so U6 holds.
     */
    const lead = task.leadTimeSeconds ?? 0;
    const preAlarmAt =
      lead > 0 ? new Date(task.fireAt.getTime() - lead * 1000) : null;
    const preAlarm =
      preAlarmAt !== null && preAlarmAt.getTime() >= now.getTime() && remaining > 0
        ? preAlarmAt
        : undefined;
    if (preAlarm) remaining -= 1;

    results.push({ taskId: task.id, fireTimes, roundsFireTimes, preAlarm });
  }

  return results;
}
