/**
 * User-tweakable app behavior, shared by both clients so the shape (and the
 * salvage rules for a corrupt stored blob) stay identical. Each app persists
 * this wherever it persists things — localStorage on web, AsyncStorage on
 * mobile — under its own key; this module is pure.
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

export interface AppSettings {
  gestures: GestureSettings;
}

export const DEFAULT_SETTINGS: AppSettings = {
  gestures: {
    swipeEnabled: true,
    swapDirections: false,
  },
};

/**
 * Coerces whatever was persisted into a valid AppSettings, falling back to
 * defaults field-by-field — same salvage-over-crash posture as the stores.
 */
export function normalizeSettings(raw: unknown): AppSettings {
  if (typeof raw !== "object" || raw === null) return DEFAULT_SETTINGS;
  const gestures = (raw as Record<string, unknown>).gestures;
  const g =
    typeof gestures === "object" && gestures !== null
      ? (gestures as Record<string, unknown>)
      : {};
  return {
    gestures: {
      swipeEnabled:
        typeof g.swipeEnabled === "boolean"
          ? g.swipeEnabled
          : DEFAULT_SETTINGS.gestures.swipeEnabled,
      swapDirections:
        typeof g.swapDirections === "boolean"
          ? g.swapDirections
          : DEFAULT_SETTINGS.gestures.swapDirections,
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
