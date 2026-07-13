/**
 * Repeat options (spec parity item): a task can recur on a simple fixed
 * cadence. Deliberately not RRULE — four cadences cover the reference app's
 * "Repeat" field for this app's purposes, stored as a plain string in the
 * existing (until now unused) `repeatRule` column.
 */

export type RepeatRule = "daily" | "weekly" | "monthly" | "yearly";

export const REPEAT_RULES: readonly RepeatRule[] = [
  "daily",
  "weekly",
  "monthly",
  "yearly",
];

export const REPEAT_LABELS: Record<RepeatRule, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  yearly: "Yearly",
};

export function isRepeatRule(value: unknown): value is RepeatRule {
  return (
    typeof value === "string" &&
    (REPEAT_RULES as readonly string[]).includes(value)
  );
}

/** Days-in-month, leap-year aware. */
function daysInMonth(year: number, monthIndex0: number): number {
  return new Date(year, monthIndex0 + 1, 0).getDate();
}

/** Same time-of-day, `months` calendar months later, clamped to a valid day. */
function addMonthsClamped(date: Date, months: number): Date {
  const totalMonths = date.getMonth() + months;
  const targetYear = date.getFullYear() + Math.floor(totalMonths / 12);
  const targetMonth = ((totalMonths % 12) + 12) % 12;
  const clampedDay = Math.min(date.getDate(), daysInMonth(targetYear, targetMonth));
  const result = new Date(date);
  result.setFullYear(targetYear, targetMonth, clampedDay);
  return result;
}

/**
 * Advances a fire time by exactly one period of `rule`, from `fireAt`
 * itself — not from "now". A repeating task that's overdue when completed
 * moves one period forward and may still be overdue; that's intentional
 * (matches iOS Reminders — the reminder resurfaces in Past instead of
 * silently catching up to today), and it keeps this function loop-free
 * regardless of how long a task has sat unopened.
 *
 * Monthly/yearly clamp to the target month's last valid day instead of
 * overflowing (Jan 31 + 1 month lands on Feb 28/29, not Mar 3).
 */
export function nextRepeatFireAt(fireAt: string, rule: RepeatRule): string {
  const d = new Date(fireAt);
  if (Number.isNaN(d.getTime())) {
    throw new Error("nextRepeatFireAt: fireAt is not a valid date");
  }

  switch (rule) {
    case "daily":
      d.setDate(d.getDate() + 1);
      return d.toISOString();
    case "weekly":
      d.setDate(d.getDate() + 7);
      return d.toISOString();
    case "monthly":
      return addMonthsClamped(d, 1).toISOString();
    case "yearly":
      return addMonthsClamped(d, 12).toISOString();
  }
}
