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
}

/** Mirrors the `nag_events` table (spec §4.2). */
export interface NagEvent {
  id: string;
  taskId: string;
  scheduledFor: string;
  fired: boolean;
  acknowledged: boolean;
}
