import { applySnooze, type DeviceOrigin, type EscalationMode, type Task } from "@alarmed/core";
import * as Crypto from "expo-crypto";
import * as SQLite from "expo-sqlite";

/**
 * Local SQLite mirror (spec §4.3): the on-device source of truth for tasks.
 * Everything the scheduler needs is read from here, never from the network, so
 * nags keep firing offline. Supabase sync (Phase 3) will reconcile against this.
 *
 * Columns mirror the Postgres `tasks` table; timestamps are stored as ISO-8601
 * TEXT to match the string dates on the shared `Task` type.
 */

const DB_NAME = "alarmed.db";

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = SQLite.openDatabaseAsync(DB_NAME);
  }
  return dbPromise;
}

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  fire_at TEXT NOT NULL,
  nag_interval_seconds INTEGER NOT NULL,
  nag_max_count INTEGER,
  nag_until TEXT,
  escalation_mode TEXT NOT NULL DEFAULT 'none',
  completed_at TEXT,
  dismissed_at TEXT,
  repeat_rule TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  device_origin TEXT NOT NULL,
  deleted_at TEXT,
  snooze_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS tasks_fire_at_idx ON tasks (fire_at);
`;

export async function initDatabase(): Promise<void> {
  const db = await getDb();
  await db.execAsync("PRAGMA journal_mode = WAL;");
  await db.execAsync(CREATE_TABLE_SQL);
}

interface TaskRow {
  id: string;
  title: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
  fire_at: string;
  nag_interval_seconds: number;
  nag_max_count: number | null;
  nag_until: string | null;
  escalation_mode: string;
  completed_at: string | null;
  dismissed_at: string | null;
  repeat_rule: string | null;
  priority: number;
  device_origin: string;
  deleted_at: string | null;
  snooze_count: number;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    fireAt: row.fire_at,
    nagIntervalSeconds: row.nag_interval_seconds,
    nagMaxCount: row.nag_max_count,
    nagUntil: row.nag_until,
    escalationMode: row.escalation_mode as EscalationMode,
    completedAt: row.completed_at,
    dismissedAt: row.dismissed_at,
    repeatRule: row.repeat_rule,
    priority: row.priority,
    deviceOrigin: row.device_origin as DeviceOrigin,
    deletedAt: row.deleted_at,
    snoozeCount: row.snooze_count,
  };
}

export interface NewTaskInput {
  title: string;
  notes?: string | null;
  /** ISO-8601 first-fire time. */
  fireAt: string;
  nagIntervalSeconds: number;
  nagMaxCount?: number | null;
  nagUntil?: string | null;
  escalationMode?: EscalationMode;
  repeatRule?: string | null;
  priority?: number;
}

/** All non-deleted tasks, open ones first, then by soonest fire time. */
export async function listTasks(): Promise<Task[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<TaskRow>(
    `SELECT * FROM tasks
     WHERE deleted_at IS NULL
     ORDER BY (completed_at IS NOT NULL), fire_at ASC`
  );
  return rows.map(rowToTask);
}

export async function getTask(id: string): Promise<Task | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<TaskRow>("SELECT * FROM tasks WHERE id = ?", [id]);
  return row ? rowToTask(row) : null;
}

export async function createTask(input: NewTaskInput): Promise<Task> {
  const db = await getDb();
  const now = new Date().toISOString();
  const task: Task = {
    id: Crypto.randomUUID(),
    title: input.title,
    notes: input.notes ?? null,
    createdAt: now,
    updatedAt: now,
    fireAt: input.fireAt,
    nagIntervalSeconds: input.nagIntervalSeconds,
    nagMaxCount: input.nagMaxCount ?? null,
    nagUntil: input.nagUntil ?? null,
    escalationMode: input.escalationMode ?? "none",
    completedAt: null,
    dismissedAt: null,
    repeatRule: input.repeatRule ?? null,
    priority: input.priority ?? 0,
    deviceOrigin: "mobile",
    deletedAt: null,
    snoozeCount: 0,
  };

  await db.runAsync(
    `INSERT INTO tasks (
       id, title, notes, created_at, updated_at, fire_at,
       nag_interval_seconds, nag_max_count, nag_until, escalation_mode,
       completed_at, dismissed_at, repeat_rule, priority, device_origin, deleted_at,
       snooze_count
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      task.id,
      task.title,
      task.notes,
      task.createdAt,
      task.updatedAt,
      task.fireAt,
      task.nagIntervalSeconds,
      task.nagMaxCount,
      task.nagUntil,
      task.escalationMode,
      task.completedAt,
      task.dismissedAt,
      task.repeatRule,
      task.priority,
      task.deviceOrigin,
      task.deletedAt,
      task.snoozeCount,
    ]
  );

  return task;
}

/** Marks a task done — the scheduler then cancels its remaining nags (spec §3.4). */
export async function completeTask(id: string): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  await db.runAsync(
    "UPDATE tasks SET completed_at = ?, updated_at = ? WHERE id = ?",
    [now, now, id]
  );
}

export async function reopenTask(id: string): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  await db.runAsync(
    "UPDATE tasks SET completed_at = NULL, updated_at = ? WHERE id = ?",
    [now, id]
  );
}

/**
 * Pushes a task's fire time out and bumps its snooze count (spec §3.4, escalation).
 * Returns the updated task so the caller can re-arm notifications and, best-effort,
 * ask the nag-ai proxy for a fresher line for the immediate next occurrence.
 */
export async function snoozeTask(
  id: string,
  options?: { snoozeSeconds?: number; now?: Date }
): Promise<Task | null> {
  const task = await getTask(id);
  // Don't resurrect a finished task: snoozing a stale notification for one
  // that's already been completed or deleted must be a no-op.
  if (!task || task.completedAt != null || task.deletedAt != null) return null;

  const { fireAt, snoozeCount } = applySnooze(task, options);
  const updatedAt = new Date().toISOString();

  const db = await getDb();
  await db.runAsync(
    "UPDATE tasks SET fire_at = ?, snooze_count = ?, updated_at = ? WHERE id = ?",
    [fireAt.toISOString(), snoozeCount, updatedAt, id]
  );

  return { ...task, fireAt: fireAt.toISOString(), snoozeCount, updatedAt };
}

/** Soft delete so the removal can later propagate through sync (spec §5). */
export async function deleteTask(id: string): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  await db.runAsync(
    "UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = ?",
    [now, now, id]
  );
}
