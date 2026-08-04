import { generateTemplateCopy, type NagPack } from "./copy";
import { describeRelativeFireTime, describeRoundOccurrence } from "./describe";
import { allocateNotificationBudget, type SchedulableTask } from "./nag";
import type { Task } from "./types";

/**
 * Notification planning (spec §3.2–§3.4): the pure layer that turns the current
 * set of tasks into the concrete list of local notifications the device should
 * have pending. The native app feeds this output straight into
 * `expo-notifications`; keeping it here makes the scheduler's decisions unit
 * testable without touching any OS APIs.
 */

/** Every pre-scheduled nag notification's id is `nag:{taskId}:{index}` so the */
/** scheduler can cancel a whole task's burst by id prefix (spec §3.2). */
export const NAG_ID_PREFIX = "nag";
const NAG_ID_SEPARATOR = ":";

/**
 * The pre-alarm's slot marker (plan §3.6). A word rather than an index, so it
 * cannot collide with a burst position, and so `parseNotificationId` can keep
 * rejecting negative and non-integer indices as malformed.
 */
export const PRE_ALARM_SLOT = "pre";

/**
 * Rounds' slot marker (plan §3.4). Rounds fires get a fourth id segment —
 * `nag:{taskId}:round:{index}` — rather than a new top-level prefix, so
 * every existing `nag:`-prefix consumer (cancel-a-task, cancel-everything,
 * `isNagNotificationId`) keeps working on Rounds fires with no changes.
 */
export const ROUNDS_SLOT = "round";

export function buildNotificationId(taskId: string, index: number): string {
  return [NAG_ID_PREFIX, taskId, index].join(NAG_ID_SEPARATOR);
}

/** Shares the `nag:{taskId}:` prefix so cancelling a task still clears everything. */
export function buildPreAlarmId(taskId: string): string {
  return [NAG_ID_PREFIX, taskId, PRE_ALARM_SLOT].join(NAG_ID_SEPARATOR);
}

/** Shares the `nag:{taskId}:` prefix so cancelling a task still clears everything. */
export function buildRoundNotificationId(taskId: string, index: number): string {
  return [NAG_ID_PREFIX, taskId, ROUNDS_SLOT, index].join(NAG_ID_SEPARATOR);
}

export function parseNotificationId(
  identifier: string
): { taskId: string; index: number; preAlarm?: true; round?: true } | null {
  const parts = identifier.split(NAG_ID_SEPARATOR);
  if (parts[0] !== NAG_ID_PREFIX) return null;

  if (parts.length === 3) {
    const [, taskId, slot] = parts;
    if (slot === PRE_ALARM_SLOT) {
      // Index 0 keeps every existing caller working: the pre-alarm belongs to
      // the same task and precedes its first fire, so treating it as position
      // zero is the honest answer for anything that only cares about ordering.
      return { taskId, index: 0, preAlarm: true };
    }
    const index = Number(slot);
    if (!Number.isInteger(index) || index < 0) return null;
    return { taskId, index };
  }

  if (parts.length === 4 && parts[2] === ROUNDS_SLOT) {
    const [, taskId, , indexPart] = parts;
    const index = Number(indexPart);
    if (!Number.isInteger(index) || index < 0) return null;
    return { taskId, index, round: true };
  }

  return null;
}

export function isNagNotificationId(identifier: string): boolean {
  return parseNotificationId(identifier) !== null;
}

/**
 * A task should be nagging only while it's open, not deleted, not paused,
 * and dated (spec §3.1). `dismissedAt` is the PowerCircle: set = alerts off.
 * A null `fireAt` is an "undated" task — parked with no alarm, so nothing
 * to schedule.
 */
export function isNaggable(task: Task): boolean {
  return (
    task.completedAt == null &&
    task.deletedAt == null &&
    task.dismissedAt == null &&
    task.fireAt != null
  );
}

/** The PowerCircle's states: armed, paused (alerts off), snoozed, or undated. */
export type PowerState = "armed" | "paused" | "snoozed" | "undated";

export function powerStateFor(task: Task, now: Date = new Date()): PowerState {
  if (task.dismissedAt != null) return "paused";
  if (task.fireAt == null) return "undated";
  if (task.snoozeCount > 0 && Date.parse(task.fireAt) > now.getTime()) {
    return "snoozed";
  }
  return "armed";
}

export interface PlannedNotification {
  /** Stable id of the form `nag:{taskId}:{index}`. */
  identifier: string;
  taskId: string;
  /** 0-based position of this fire within the task's burst. */
  index: number;
  fireAt: Date;
  title: string;
  body: string;
}

export interface PlanOptions {
  globalBudget?: number;
  perTaskCap?: number;
  /**
   * Shifts the escalation level used to pick each occurrence's copy —
   * negative keeps the ladder milder longer, positive jumps tiers early
   * (see `toneLevelOffset`). Clamped at zero per occurrence.
   */
  copyLevelOffset?: number;
  /** Personality pack for the escalation copy (default "classic"). */
  copyPack?: NagPack;
  now?: Date;
}

/**
 * Computes the full set of notifications that should currently be pending across
 * all tasks, respecting the global 64-slot budget. The scheduler cancels
 * everything and re-schedules from this list, so it doubles as the
 * foreground "re-arm" computation (spec §3.3).
 */
export function planNagNotifications(
  tasks: Task[],
  options?: PlanOptions
): PlannedNotification[] {
  const now = options?.now ?? new Date();
  const active = tasks.filter(isNaggable);

  const schedulable: SchedulableTask[] = active.map((task) => ({
    id: task.id,
    // isNaggable guarantees a non-null fireAt for everything in `active`.
    fireAt: new Date(task.fireAt as string),
    nagIntervalSeconds: task.nagIntervalSeconds,
    nagMaxCount: task.nagMaxCount,
    nagUntil: task.nagUntil ? new Date(task.nagUntil) : null,
    escalationMode: task.escalationMode,
    priority: task.priority,
    snoozeCount: task.snoozeCount,
    leadTimeSeconds: task.leadTimeSeconds,
    roundsIntervalSeconds: task.roundsIntervalSeconds,
    roundsMaxCount: task.roundsMaxCount,
    roundsDurationSeconds: task.roundsDurationSeconds,
  }));

  const bursts = allocateNotificationBudget(schedulable, {
    globalBudget: options?.globalBudget,
    perTaskCap: options?.perTaskCap,
    now,
  });

  const tasksById = new Map(active.map((task) => [task.id, task]));
  const planned: PlannedNotification[] = [];

  for (const burst of bursts) {
    const task = tasksById.get(burst.taskId);
    if (!task) continue;

    /*
     * The pre-alarm is a heads-up, so it deliberately skips the escalation
     * ladder: the task isn't late yet, and opening with the sass reserved for
     * a task you've ignored six times would be nonsense. Plain and factual.
     */
    if (burst.preAlarm) {
      planned.push({
        identifier: buildPreAlarmId(task.id),
        taskId: task.id,
        index: 0,
        fireAt: burst.preAlarm,
        title: task.title,
        body: `Coming up ${describeRelativeFireTime(
          task.fireAt as string,
          burst.preAlarm
        )}.`,
      });
    }

    burst.fireTimes.forEach((fireAt, index) => {
      const level = Math.max(
        0,
        task.snoozeCount + index + (options?.copyLevelOffset ?? 0)
      );
      const copy = generateTemplateCopy(task, level, options?.copyPack);
      planned.push({
        identifier: buildNotificationId(task.id, index),
        taskId: task.id,
        index,
        fireAt,
        title: copy.title,
        body: copy.body,
      });
    });

    /*
     * Rounds skips the escalation ladder entirely — it's a fixed schedule,
     * not a response to being ignored, so the copy stays plain (§3.4's
     * AutoComplete decision: schedule-based only, see describeRoundOccurrence).
     */
    burst.roundsFireTimes.forEach((fireAt, index) => {
      planned.push({
        identifier: buildRoundNotificationId(task.id, index),
        taskId: task.id,
        index,
        fireAt,
        title: task.title,
        body: describeRoundOccurrence(index),
      });
    });
  }

  return planned;
}
