import type { Task } from "./types";

/**
 * Time-bucketed grouping for the task list (the collapsible "Past / Today /
 * Tomorrow / Next 7 days" drawers). Pure date math so both clients bucket
 * identically and the boundary cases stay unit-tested here.
 */

export type TaskBucket =
  | "past"
  | "today"
  | "tomorrow"
  | "week"
  | "later"
  | "done";

/** Render order of the drawers, top to bottom. */
export const BUCKET_ORDER: readonly TaskBucket[] = [
  "past",
  "today",
  "tomorrow",
  "week",
  "later",
  "done",
];

export const BUCKET_LABELS: Record<TaskBucket, string> = {
  past: "Past",
  today: "Today",
  tomorrow: "Tomorrow",
  week: "Next 7 days",
  later: "Later",
  done: "Done",
};

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * Which drawer a task belongs in. Completed tasks always land in "done"
 * regardless of their fire time. "past" means the fire time has already gone
 * by — a task due earlier today is overdue, not "today". Buckets use the
 * device's local timezone, same as the fire times shown on the cards.
 */
export function bucketForTask(task: Task, now: Date = new Date()): TaskBucket {
  if (task.completedAt != null) return "done";

  const fireAt = new Date(task.fireAt);
  if (Number.isNaN(fireAt.getTime()) || fireAt.getTime() <= now.getTime()) {
    return "past";
  }

  const startTomorrow = addDays(startOfDay(now), 1);
  if (fireAt < startTomorrow) return "today";

  const startDayAfter = addDays(startTomorrow, 1);
  if (fireAt < startDayAfter) return "tomorrow";

  // "Next 7 days" = the 7 days after today (tomorrow already has its own
  // drawer, so this covers days 2–7); anything past that is "later".
  const startBeyondWeek = addDays(startOfDay(now), 8);
  if (fireAt < startBeyondWeek) return "week";

  return "later";
}

export interface TaskSection {
  bucket: TaskBucket;
  label: string;
  tasks: Task[];
}

/**
 * Groups tasks into ordered, non-empty sections. Open buckets keep the
 * caller's order (fire-time ascending from the stores); "done" re-sorts to
 * most-recently-completed first, since that's the end you care about.
 */
export function groupTasksIntoSections(
  tasks: Task[],
  now: Date = new Date()
): TaskSection[] {
  const byBucket = new Map<TaskBucket, Task[]>();
  for (const task of tasks) {
    const bucket = bucketForTask(task, now);
    const list = byBucket.get(bucket);
    if (list) list.push(task);
    else byBucket.set(bucket, [task]);
  }

  byBucket
    .get("done")
    ?.sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));

  return BUCKET_ORDER.filter((bucket) => byBucket.has(bucket)).map(
    (bucket) => ({
      bucket,
      label: BUCKET_LABELS[bucket],
      tasks: byBucket.get(bucket) as Task[],
    })
  );
}
