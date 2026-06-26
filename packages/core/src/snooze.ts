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
 * what follows). Doesn't touch `nagMaxCount`/`nagUntil` — those are absolute
 * caps on the task's lifecycle, and `computeNagBurst` already re-derives the
 * remaining budget fresh from whatever `fireAt` ends up being, the same way
 * it fast-forwards through any other past occurrence.
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
