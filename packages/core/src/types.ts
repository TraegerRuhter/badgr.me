export type EscalationMode = "none" | "shrink" | "sound";

export type DeviceOrigin = "mobile" | "web";

/** Mirrors the `tasks` table (spec §4.1). */
export interface Task {
  id: string;
  title: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  /** ISO fire time, or null for an "undated" task that never nags (spec §4.1). */
  fireAt: string | null;
  nagIntervalSeconds: number;
  nagMaxCount: number | null;
  nagUntil: string | null;
  escalationMode: EscalationMode;
  completedAt: string | null;
  dismissedAt: string | null;
  repeatRule: string | null;
  priority: number;
  deviceOrigin: DeviceOrigin;
  deletedAt: string | null;
  /** Times this task's nag has been snoozed; drives escalating copy and (with "shrink") interval. */
  snoozeCount: number;
  /**
   * Heads-up before the first fire, in seconds. Null means no pre-alarm
   * (docs/plans/due-parity-build-plan.md §3.6).
   *
   * Costs a notification slot, so it is accounted for in
   * `allocateNotificationBudget` — see invariant U6.
   */
  leadTimeSeconds: number | null;
  /**
   * Rounds — intra-day recurrence (plan §3.4): the reminder itself fires
   * again every `roundsIntervalSeconds`, starting from `fireAt`. Null means
   * Rounds is off, which is every task's default. Named "Rounds" per plan
   * §9.3.1: not Due's "DayMinder", and not "Burst" — `computeNagBurst`
   * already owns that word.
   *
   * Costs notification slots, so it is accounted for in
   * `allocateNotificationBudget` — see invariant U6.
   */
  roundsIntervalSeconds: number | null;
  /**
   * Rounds' cap, "Count" mode (plan §3.4's `Off | Count | Duration`
   * control): stop after this many rounds. Mutually exclusive with
   * `roundsDurationSeconds` — at most one is non-null. Null with a non-null
   * `roundsIntervalSeconds` means the cap is `roundsDurationSeconds`
   * instead, or Rounds is off if that is null too.
   */
  roundsMaxCount: number | null;
  /**
   * Rounds' cap, "Duration" mode: stop this many seconds after `fireAt`,
   * rather than after a fixed count. Mutually exclusive with
   * `roundsMaxCount`.
   */
  roundsDurationSeconds: number | null;
}

/** Mirrors the `nag_events` table (spec §4.2). */
export interface NagEvent {
  id: string;
  taskId: string;
  scheduledFor: string;
  fired: boolean;
  acknowledged: boolean;
}
