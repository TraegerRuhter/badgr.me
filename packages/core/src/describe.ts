import type { EscalationMode } from "./types";

/**
 * Derived labels for the reminder editor (docs/plans/due-parity-build-plan.md §5).
 *
 * Every control that changes when the phone will buzz has to say so, in the
 * same view, in plain language (invariant U1). This module is where those
 * sentences are built — once, in core, so web and mobile cannot drift (U7).
 *
 * Pure by construction: no clock reads except through an injected `now`, and no
 * environment locale sniffing. Both would make the strings untestable.
 */

/** Minutes below this render as minutes; at or above, as hours (§9.2). */
const HOUR_MINUTES = 60;
const DAY_MINUTES = 1440;

/**
 * The one duration formatter (§9.2).
 *
 * Due ships two contradictory ones — its preset subtitles render 90 minutes as
 * "90 min" while its custom subtitle would render the same span as "1 hr,
 * 30 min". badgr picks the internally consistent rule and applies it
 * everywhere: minutes under an hour, abbreviated hours above, exact hours
 * dropping the minutes component.
 */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return `${seconds} sec`;

  const totalMinutes = Math.round(seconds / 60);
  if (totalMinutes < HOUR_MINUTES) return `${totalMinutes} min`;

  if (totalMinutes >= DAY_MINUTES) {
    const days = Math.floor(totalMinutes / DAY_MINUTES);
    const remainderHours = Math.round((totalMinutes % DAY_MINUTES) / HOUR_MINUTES);
    // A remainder that rounds up to a full day would print "1 day, 24 hr".
    if (remainderHours === 24) return `${days + 1} ${days + 1 === 1 ? "day" : "days"}`;
    const dayPart = `${days} ${days === 1 ? "day" : "days"}`;
    return remainderHours === 0 ? dayPart : `${dayPart}, ${remainderHours} hr`;
  }

  const hours = Math.floor(totalMinutes / HOUR_MINUTES);
  const minutes = totalMinutes % HOUR_MINUTES;
  return minutes === 0 ? `${hours} hr` : `${hours} hr, ${minutes} min`;
}

/** "Every 20 min" — the interval half of a nag description. */
export function formatInterval(intervalSeconds: number): string {
  return `Every ${formatDuration(intervalSeconds)}`;
}

export interface NagPlanInput {
  intervalSeconds: number;
  /** null means "until marked done" — no ceiling. */
  maxCount: number | null;
  escalationMode?: EscalationMode;
}

/**
 * The headline summary for a nag configuration (§3.3's Custom subtitle):
 * "Every 20 min, 12 times (4 hr)".
 *
 * The parenthesised total is the span from the first fire to the last, which is
 * `(n - 1)` intervals, not `n`. A task that nags 12 times at 20-minute spacing
 * finishes 3 hours 40 minutes after it starts — Due prints "(4 hr)" here, which
 * counts one interval too many. We print the true span.
 *
 * With `escalationMode: "shrink"` the interval tightens on each fire, so a
 * fixed-interval total would be wrong. Rather than duplicate the shrink maths
 * (which lives in `computeNagBurst`), the total is omitted and the caller is
 * expected to show real fire times via `describeFireTimes` instead — see U2.
 */
export function describeNagPlan(input: NagPlanInput): string {
  const { intervalSeconds, maxCount, escalationMode = "none" } = input;
  if (intervalSeconds <= 0) throw new Error("describeNagPlan: interval must be positive");

  if (maxCount === 1) return "Once, no repeat";

  const every = formatInterval(intervalSeconds);
  if (maxCount == null) return `${every}, until done`;

  const times = `${maxCount} times`;
  if (escalationMode === "shrink") return `${every}, ${times}, tightening`;

  return `${every}, ${times} (${formatDuration(intervalSeconds * (maxCount - 1))})`;
}

/**
 * The nag presets offered in the editor (§3.3), as pairs over the fields `Task`
 * already has (§4) — so the preset list costs no schema change.
 *
 * `maxCount: null` means "until marked done". `maxCount: 1` is badgr's "nag
 * off": it still alerts once, it just doesn't badger (§9.1).
 */
export interface NagPreset {
  readonly id: string;
  readonly label: string;
  readonly intervalSeconds: number;
  readonly maxCount: number | null;
}

export const NAG_PRESETS: readonly NagPreset[] = [
  { id: "once", label: "Just once", intervalSeconds: 300, maxCount: 1 },
  { id: "relentless", label: "Every minute", intervalSeconds: 60, maxCount: null },
  { id: "5m", label: "Every 5 minutes", intervalSeconds: 300, maxCount: 6 },
  { id: "15m", label: "Every 15 minutes", intervalSeconds: 900, maxCount: 6 },
  { id: "30m", label: "Every 30 minutes", intervalSeconds: 1800, maxCount: 6 },
  { id: "1h", label: "Every hour", intervalSeconds: 3600, maxCount: 6 },
  { id: "1d", label: "Every day", intervalSeconds: 86400, maxCount: null },
];

/** The subtitle under a preset row: "6 times (2 hr, 30 min), or until done". */
export function describeNagPreset(preset: NagPreset): string {
  if (preset.maxCount === 1) return "Alerts once and then leaves you alone";
  if (preset.maxCount == null) return "Repeats until marked done";
  const span = formatDuration(preset.intervalSeconds * (preset.maxCount - 1));
  return `${preset.maxCount} times (${span}), or until marked done`;
}

/** Finds the preset matching a task's fields, or null if it's a custom pairing. */
export function matchNagPreset(
  intervalSeconds: number,
  maxCount: number | null
): NagPreset | null {
  return (
    NAG_PRESETS.find(
      (p) => p.intervalSeconds === intervalSeconds && p.maxCount === maxCount
    ) ?? null
  );
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** 24-hour clock time. Deliberately not `toLocaleTimeString` — see the module note. */
function clockTime(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export interface FireTimesOptions {
  /** How many times to name before summarising the rest. */
  max?: number;
}

/**
 * "Will fire at 09:00, 09:20, 09:40" — §3.4's enumerated preview.
 *
 * **Takes an already-computed burst, and that is the point (invariant U2).**
 * The only way to call this is to have run the real planner first, so the
 * preview cannot drift from what the scheduler will actually do. Do not add an
 * overload that accepts a config and computes the burst internally; that
 * reintroduces exactly the second implementation this signature exists to
 * prevent, and the drift would stay invisible until it woke someone at the
 * wrong hour.
 */
export function describeFireTimes(
  burst: readonly Date[],
  options: FireTimesOptions = {}
): string {
  const { max = 3 } = options;
  if (burst.length === 0) return "Won't fire";

  const shown = burst.slice(0, max).map(clockTime);
  const remaining = burst.length - shown.length;

  if (remaining <= 0) return `Will fire at ${shown.join(", ")}`;
  return `Will fire at ${shown.join(", ")}, and ${remaining} more`;
}

/** True when a fire time has already passed — drives the red/"Now" state (§3.5). */
export function isPastDue(fireAt: Date | string | null, now: Date = new Date()): boolean {
  if (fireAt == null) return false;
  const ms = typeof fireAt === "string" ? Date.parse(fireAt) : fireAt.getTime();
  return !Number.isNaN(ms) && ms < now.getTime();
}

/**
 * "in 2 hr" / "3 hr, 40 min ago" — the relative gloss beside a fire time.
 *
 * Rounded to the minute: a countdown that ticks seconds invites the eye to
 * watch it, and this label sits in a form the user is meant to be filling in.
 */
export function describeRelativeFireTime(
  fireAt: Date | string,
  now: Date = new Date()
): string {
  const ms = typeof fireAt === "string" ? Date.parse(fireAt) : fireAt.getTime();
  if (Number.isNaN(ms)) return "";

  const deltaSeconds = Math.round((ms - now.getTime()) / 1000);
  const magnitude = Math.abs(deltaSeconds);

  if (magnitude < 60) return deltaSeconds < 0 ? "just now" : "in under a minute";
  return deltaSeconds < 0
    ? `${formatDuration(magnitude)} ago`
    : `in ${formatDuration(magnitude)}`;
}

/**
 * The label for §3.5's first quick chip, which flips `Today` → `Now` once the
 * chosen time is in the past. Two cheap signals (this plus the red value) beat
 * a dialog.
 */
export function quickChipLabel(fireAt: Date | string | null, now: Date = new Date()): string {
  return isPastDue(fireAt, now) ? "Now" : "Today";
}

/**
 * Pre-alarm choices offered in the editor (§3.6).
 *
 * Shared so both clients offer the same set and the same wording (U7). `null`
 * is "no heads-up", which is the default and must stay first — a pre-alarm is
 * opt-in, because it costs a notification slot (U6).
 */
export interface LeadTimeChoice {
  readonly seconds: number | null;
  readonly label: string;
}

export const LEAD_TIME_CHOICES: readonly LeadTimeChoice[] = [
  { seconds: null, label: "Off" },
  { seconds: 300, label: "5 min" },
  { seconds: 900, label: "15 min" },
  { seconds: 1800, label: "30 min" },
  { seconds: 3600, label: "1 hr" },
  { seconds: 86400, label: "1 day" },
];

/** "Heads-up 15 min before" — the derived summary for a chosen lead time. */
export function describeLeadTime(seconds: number | null): string {
  if (seconds == null || seconds <= 0) return "No heads-up before it's due";
  return `Heads-up ${formatDuration(seconds)} before`;
}
