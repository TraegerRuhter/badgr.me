import type { Task } from "./types";

/**
 * Single-tap due-date adjustment (the slide-deck's −5m/+1d panel): pure
 * computation of the new fire time so both clients shift identically.
 *
 * Semantics match the reference app's feel:
 * - A positive shift on an overdue task counts from *now* — "+1h" on
 *   something 4 days late means "give me an hour", not "3 days and 23
 *   hours ago".
 * - A positive shift on a future task extends its existing fire time.
 * - A negative shift pulls the fire time earlier, clamped to now — you
 *   can't schedule into the past.
 */
export function shiftFireAt(
  task: Pick<Task, "fireAt">,
  deltaSeconds: number,
  now: Date = new Date()
): string {
  const current = new Date(task.fireAt);
  const currentMs = Number.isNaN(current.getTime())
    ? now.getTime()
    : current.getTime();

  const baseMs =
    deltaSeconds >= 0 ? Math.max(currentMs, now.getTime()) : currentMs;
  const shifted = baseMs + deltaSeconds * 1000;

  return new Date(Math.max(shifted, now.getTime())).toISOString();
}

/** The quick-adjust steps offered on an expanded task, in display order. */
export const ADJUST_STEPS: readonly {
  label: string;
  seconds: number;
}[] = [
  { label: "5m", seconds: 5 * 60 },
  { label: "30m", seconds: 30 * 60 },
  { label: "1h", seconds: 3600 },
  { label: "1d", seconds: 86400 },
];

/**
 * Compact age tag for an overdue fire time — the red "(4d)" from the
 * reference list. Empty string when not overdue.
 */
export function overdueAgeLabel(fireAt: string, now: Date = new Date()): string {
  const fireMs = Date.parse(fireAt);
  if (Number.isNaN(fireMs)) return "";
  const ageMs = now.getTime() - fireMs;
  if (ageMs <= 0) return "";
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `(${Math.max(1, minutes)}m)`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `(${hours}h)`;
  return `(${Math.floor(hours / 24)}d)`;
}
