export type EscalationMode = "none" | "shrink" | "sound";

export type DeviceOrigin = "mobile" | "web";

/** Mirrors the `tasks` table (spec §4.1). */
export interface Task {
  id: string;
  title: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  fireAt: string;
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
}

/** Mirrors the `nag_events` table (spec §4.2). */
export interface NagEvent {
  id: string;
  taskId: string;
  scheduledFor: string;
  fired: boolean;
  acknowledged: boolean;
}
