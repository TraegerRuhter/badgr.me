import { generateTemplateCopy } from "./copy";
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

export function buildNotificationId(taskId: string, index: number): string {
  return [NAG_ID_PREFIX, taskId, index].join(NAG_ID_SEPARATOR);
}

export function parseNotificationId(
  identifier: string
): { taskId: string; index: number } | null {
  const parts = identifier.split(NAG_ID_SEPARATOR);
  if (parts.length !== 3 || parts[0] !== NAG_ID_PREFIX) return null;
  const index = Number(parts[2]);
  if (!Number.isInteger(index) || index < 0) return null;
  return { taskId: parts[1], index };
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
    burst.fireTimes.forEach((fireAt, index) => {
      const level = Math.max(
        0,
        task.snoozeCount + index + (options?.copyLevelOffset ?? 0)
      );
      const copy = generateTemplateCopy(task, level);
      planned.push({
        identifier: buildNotificationId(task.id, index),
        taskId: task.id,
        index,
        fireAt,
        title: copy.title,
        body: copy.body,
      });
    });
  }

  return planned;
}
