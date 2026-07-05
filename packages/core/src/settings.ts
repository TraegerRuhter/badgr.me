import {
  MAX_BURST_PER_TASK,
  SAFE_GLOBAL_NOTIFICATION_BUDGET,
} from "./nag";
import { DEFAULT_SNOOZE_SECONDS } from "./snooze";

/**
 * User-tweakable app behavior, shared by both clients so the shape (and the
 * salvage rules for a corrupt stored blob) stay identical. Each app persists
 * this wherever it persists things — localStorage on web, AsyncStorage on
 * mobile — under its own key; this module is pure.
 *
 * Every numeric knob has a documented range and is clamped on read, so a
 * hand-edited or stale blob can never push the scheduler outside safe
 * bounds (e.g. past the 64-slot iOS notification budget).
 */

export interface GestureSettings {
  /** Master switch for swipe gestures on task rows. */
  swipeEnabled: boolean;
  /**
   * Default mapping: swipe right = complete/reopen, swipe left = snooze.
   * True swaps the two directions.
   */
  swapDirections: boolean;
}

export interface NagSettings {
  /** How long a snoozed nag stays quiet before firing again. */
  snoozeMinutes: number;
  /** Cap on pre-scheduled notifications any single task may hold. */
  maxPerTask: number;
  /** Ceiling across all tasks — stays under the 64-slot OS limit. */
  globalBudget: number;
}

/** How hard the escalation ladder leans. */
export type NagTone = "gentle" | "standard" | "savage";

export const NAG_TONES: readonly NagTone[] = ["gentle", "standard", "savage"];

export interface CopySettings {
  tone: NagTone;
  /** Ask the nag-ai proxy for rewritten lines after a snooze (when configured). */
  aiRewrites: boolean;
}

export interface SyncSettings {
  /** Temporarily stop background reconciliation without unconfiguring it. */
  paused: boolean;
}

export interface AppSettings {
  gestures: GestureSettings;
  nag: NagSettings;
  copy: CopySettings;
  sync: SyncSettings;
}

export const SETTING_LIMITS = {
  snoozeMinutes: { min: 1, max: 180 },
  maxPerTask: { min: 1, max: MAX_BURST_PER_TASK },
  globalBudget: { min: 4, max: SAFE_GLOBAL_NOTIFICATION_BUDGET },
} as const;

export const DEFAULT_SETTINGS: AppSettings = {
  gestures: {
    swipeEnabled: true,
    swapDirections: false,
  },
  nag: {
    snoozeMinutes: DEFAULT_SNOOZE_SECONDS / 60,
    maxPerTask: MAX_BURST_PER_TASK,
    globalBudget: SAFE_GLOBAL_NOTIFICATION_BUDGET,
  },
  copy: {
    tone: "standard",
    aiRewrites: true,
  },
  sync: {
    paused: false,
  },
};

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function clampedInt(
  value: unknown,
  fallback: number,
  limits: { min: number; max: number }
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(limits.max, Math.max(limits.min, Math.round(value)));
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Coerces whatever was persisted into a valid AppSettings, falling back to
 * defaults field-by-field — same salvage-over-crash posture as the stores.
 * A blob written by an older app version (e.g. gestures-only) picks up
 * defaults for every group it doesn't know about.
 */
export function normalizeSettings(raw: unknown): AppSettings {
  const root = record(raw);
  const g = record(root.gestures);
  const n = record(root.nag);
  const c = record(root.copy);
  const s = record(root.sync);
  const d = DEFAULT_SETTINGS;

  return {
    gestures: {
      swipeEnabled: bool(g.swipeEnabled, d.gestures.swipeEnabled),
      swapDirections: bool(g.swapDirections, d.gestures.swapDirections),
    },
    nag: {
      snoozeMinutes: clampedInt(
        n.snoozeMinutes,
        d.nag.snoozeMinutes,
        SETTING_LIMITS.snoozeMinutes
      ),
      maxPerTask: clampedInt(
        n.maxPerTask,
        d.nag.maxPerTask,
        SETTING_LIMITS.maxPerTask
      ),
      globalBudget: clampedInt(
        n.globalBudget,
        d.nag.globalBudget,
        SETTING_LIMITS.globalBudget
      ),
    },
    copy: {
      tone: NAG_TONES.includes(c.tone as NagTone)
        ? (c.tone as NagTone)
        : d.copy.tone,
      aiRewrites: bool(c.aiRewrites, d.copy.aiRewrites),
    },
    sync: {
      paused: bool(s.paused, d.sync.paused),
    },
  };
}

export type SwipeAction = "complete" | "snooze";

/**
 * Which action a horizontal swipe maps to, honoring the swap setting.
 * `direction` is the sign of the drag: positive = right.
 */
export function swipeActionFor(
  settings: AppSettings,
  direction: "left" | "right"
): SwipeAction {
  const rightAction: SwipeAction = settings.gestures.swapDirections
    ? "snooze"
    : "complete";
  const leftAction: SwipeAction = settings.gestures.swapDirections
    ? "complete"
    : "snooze";
  return direction === "right" ? rightAction : leftAction;
}

/**
 * Shifts the escalation level fed to the copy ladder (and the nag-ai proxy):
 * gentle lags the ladder so the tone stays mild longer, savage jumps tiers
 * early. Callers clamp the resulting level at zero.
 */
export function toneLevelOffset(tone: NagTone): number {
  switch (tone) {
    case "gentle":
      return -2;
    case "savage":
      return 3;
    default:
      return 0;
  }
}

/** The planner options a given settings blob implies — one place to map them. */
export function planOptionsFrom(settings: AppSettings): {
  globalBudget: number;
  perTaskCap: number;
  copyLevelOffset: number;
} {
  return {
    globalBudget: settings.nag.globalBudget,
    perTaskCap: settings.nag.maxPerTask,
    copyLevelOffset: toneLevelOffset(settings.copy.tone),
  };
}
