/** Default delay before a snoozed nag comes back, when the caller doesn't override it. */
export const DEFAULT_SNOOZE_SECONDS = 600;

export interface SnoozeInput {
  snoozeCount: number;
}

export interface SnoozeResult {
  fireAt: Date;
  snoozeCount: number;
}

/**
 * Pure computation for the "Snooze" notification action: pushes the next fire
 * out by `snoozeSeconds` from now and bumps `snoozeCount` (which drives both
 * escalating copy and, combined with `shrink` mode, a tighter interval on
 * what follows). Doesn't touch `nagMaxCount`/`nagUntil` directly — but the
 * bumped `snoozeCount` is fed to `computeNagBurst` as `priorOccurrences`, so
 * each snooze is charged against `nagMaxCount`. That keeps the count an
 * absolute lifetime ceiling: a "6×" task nags at most 6 times total no matter
 * how often it's snoozed, rather than getting a fresh full burst every time.
 */
export function applySnooze(
  task: SnoozeInput,
  options?: { snoozeSeconds?: number; now?: Date }
): SnoozeResult {
  const { snoozeSeconds = DEFAULT_SNOOZE_SECONDS, now = new Date() } =
    options ?? {};

  if (snoozeSeconds <= 0) {
    throw new Error("snoozeSeconds must be positive");
  }

  return {
    fireAt: new Date(now.getTime() + snoozeSeconds * 1000),
    snoozeCount: task.snoozeCount + 1,
  };
}
