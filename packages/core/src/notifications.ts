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

/** A task should be nagging only while it's open and not deleted (spec §3.1). */
export function isNaggable(task: Task): boolean {
  return task.completedAt == null && task.deletedAt == null;
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
    fireAt: new Date(task.fireAt),
    nagIntervalSeconds: task.nagIntervalSeconds,
    nagMaxCount: task.nagMaxCount,
    nagUntil: task.nagUntil ? new Date(task.nagUntil) : null,
    escalationMode: task.escalationMode,
    priority: task.priority,
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
      const copy = generateTemplateCopy(task, task.snoozeCount + index);
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
