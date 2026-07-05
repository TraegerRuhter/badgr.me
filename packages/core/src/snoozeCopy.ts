import type { CopyGenerator, CopyResult } from "./copy";
import { isNaggable } from "./notifications";
import type { Task } from "./types";

/**
 * The platform-specific seams the best-effort snooze copy refresh needs. Both
 * the mobile (expo-notifications + SQLite) and web (Notification + localStorage)
 * clients supply these; the orchestration itself lives here so the guard that
 * stops a finished task from being re-nagged can't drift between them.
 */
export interface NextOccurrenceCopyDeps {
  /** The AI-backed generator, or null to skip the refresh entirely. */
  generator: CopyGenerator | null;
  /** Re-read the task from the local store (to detect complete/delete/re-snooze). */
  getTask: (id: string) => Promise<Task | null>;
  /** Overwrite just the task's immediate next (index 0) notification. */
  scheduleNextOccurrence: (
    taskId: string,
    fireAt: Date,
    copy: CopyResult
  ) => Promise<void>;
  /**
   * Tone shift applied to the escalation level sent to the generator —
   * same semantics as `PlanOptions.copyLevelOffset`, so the AI line and the
   * template ladder escalate in step. Clamped at zero.
   */
  levelOffset?: number;
}

/**
 * After a snooze, best-effort fetch a fresher AI line for the *next* occurrence
 * and overlay it onto that one notification. The deterministic template ladder
 * has already armed every occurrence (including this one) via the resync, so
 * this only ever upgrades a single notification and is safe to skip.
 *
 * The generate() call can take seconds, during which the user may finish,
 * delete, or snooze the task again — so we re-read it first and only apply the
 * overlay if it's still naggable and hasn't been snoozed since. Without that
 * re-check a slow response would resurrect a nag for a task already dealt with.
 */
export async function refreshNextOccurrenceCopy(
  snoozed: Task,
  deps: NextOccurrenceCopyDeps
): Promise<void> {
  if (!deps.generator) return;

  const copy = await deps.generator.generate({
    task: snoozed,
    level: Math.max(0, snoozed.snoozeCount + (deps.levelOffset ?? 0)),
  });

  const fresh = await deps.getTask(snoozed.id);
  if (
    fresh &&
    isNaggable(fresh) &&
    fresh.snoozeCount === snoozed.snoozeCount
  ) {
    await deps.scheduleNextOccurrence(snoozed.id, new Date(fresh.fireAt), copy);
  }
}
