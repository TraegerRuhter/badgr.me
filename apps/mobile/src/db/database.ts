import {
  applySnooze,
  shiftFireAt,
  type DeviceOrigin,
  type EscalationMode,
  type LocalTaskStore,
  type Task,
} from "@alarmed/core";
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

// Base schema = the Phase 1 columns. Later columns are added as ordered
// migrations below, so an existing install upgrades correctly instead of
// silently missing a column (CREATE TABLE IF NOT EXISTS is a no-op once the
// table already exists). Mirrors the supabase/migrations split.
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
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS tasks_fire_at_idx ON tasks (fire_at);
`;

async function columnExists(
  db: SQLite.SQLiteDatabase,
  table: string,
  column: string
): Promise<boolean> {
  const cols = await db.getAllAsync<{ name: string }>(
    `PRAGMA table_info(${table})`
  );
  return cols.some((c) => c.name === column);
}

/**
 * Ordered, idempotent schema migrations. Each runs once, gated by the db's
 * `PRAGMA user_version`; the column-existence checks make them safe to re-run
 * against a store created by any prior version of this code.
 */
const MIGRATIONS: ((db: SQLite.SQLiteDatabase) => Promise<void>)[] = [
  // v1 — Phase 2 escalation: per-task snooze count.
  async (db) => {
    if (!(await columnExists(db, "tasks", "snooze_count"))) {
      await db.execAsync(
        "ALTER TABLE tasks ADD COLUMN snooze_count INTEGER NOT NULL DEFAULT 0;"
      );
    }
  },
];

export async function initDatabase(): Promise<void> {
  const db = await getDb();
  await db.execAsync("PRAGMA journal_mode = WAL;");
  await db.execAsync(CREATE_TABLE_SQL);

  const row = await db.getFirstAsync<{ user_version: number }>(
    "PRAGMA user_version"
  );
  const current = row?.user_version ?? 0;
  for (let version = current; version < MIGRATIONS.length; version++) {
    await MIGRATIONS[version](db);
  }
  if (current < MIGRATIONS.length) {
    // user_version can't be bound as a parameter; it's a trusted constant.
    await db.execAsync(`PRAGMA user_version = ${MIGRATIONS.length}`);
  }
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

export interface TaskPatch {
  title?: string;
  notes?: string | null;
  fireAt?: string;
  nagIntervalSeconds?: number;
  nagMaxCount?: number | null;
  escalationMode?: EscalationMode;
}

/**
 * The Edit sheet's save: applies whichever fields changed and bumps
 * updatedAt so the edit wins last-write-wins sync. Rejects an empty title
 * rather than persisting an unnameable task.
 */
export async function updateTask(
  id: string,
  patch: TaskPatch
): Promise<Task | null> {
  const task = await getTask(id);
  if (!task || task.deletedAt != null) return null;

  const next: Task = { ...task };
  if (patch.title !== undefined && patch.title.trim().length > 0) {
    next.title = patch.title.trim();
  }
  if (patch.notes !== undefined) {
    const trimmed = patch.notes?.trim() ?? "";
    next.notes = trimmed.length > 0 ? trimmed : null;
  }
  if (patch.fireAt !== undefined && !Number.isNaN(Date.parse(patch.fireAt))) {
    next.fireAt = patch.fireAt;
  }
  if (
    patch.nagIntervalSeconds !== undefined &&
    Number.isInteger(patch.nagIntervalSeconds) &&
    patch.nagIntervalSeconds > 0
  ) {
    next.nagIntervalSeconds = patch.nagIntervalSeconds;
  }
  if (patch.nagMaxCount !== undefined) {
    next.nagMaxCount =
      patch.nagMaxCount != null &&
      Number.isInteger(patch.nagMaxCount) &&
      patch.nagMaxCount > 0
        ? patch.nagMaxCount
        : null;
  }
  if (patch.escalationMode !== undefined) {
    next.escalationMode = patch.escalationMode;
  }
  next.updatedAt = new Date().toISOString();

  const db = await getDb();
  await db.runAsync(
    "UPDATE tasks SET title = ?, notes = ?, fire_at = ?, nag_interval_seconds = ?, nag_max_count = ?, escalation_mode = ?, updated_at = ? WHERE id = ?",
    [
      next.title,
      next.notes,
      next.fireAt,
      next.nagIntervalSeconds,
      next.nagMaxCount,
      next.escalationMode,
      next.updatedAt,
      id,
    ]
  );

  return next;
}

/**
 * Single-tap due-date shift from the expanded task panel (±5m/±30m/±1h/±1d).
 * Unlike snooze this doesn't touch snoozeCount — nudging a date isn't
 * procrastination, so it shouldn't sharpen the copy ladder.
 */
export async function adjustTaskFireAt(
  id: string,
  deltaSeconds: number
): Promise<Task | null> {
  const task = await getTask(id);
  if (!task || task.completedAt != null || task.deletedAt != null) return null;

  const fireAt = shiftFireAt(task, deltaSeconds);
  const updatedAt = new Date().toISOString();

  const db = await getDb();
  await db.runAsync(
    "UPDATE tasks SET fire_at = ?, updated_at = ? WHERE id = ?",
    [fireAt, updatedAt, id]
  );

  return { ...task, fireAt, updatedAt };
}

/**
 * The `LocalTaskStore` the core sync engine drives. Unlike `listTasks` this
 * includes soft-deleted rows (sync needs deletes to converge), and `upsertMany`
 * writes whatever the reconcile decided the local store should take, replacing
 * any existing row by primary key.
 */
export const localTaskStore: LocalTaskStore = {
  async listAllForSync(): Promise<Task[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<TaskRow>("SELECT * FROM tasks");
    return rows.map(rowToTask);
  },
  async upsertMany(tasks: Task[]): Promise<void> {
    if (tasks.length === 0) return;
    const db = await getDb();
    for (const task of tasks) {
      await db.runAsync(
        `INSERT OR REPLACE INTO tasks (
           id, title, notes, created_at, updated_at, fire_at,
           nag_interval_seconds, nag_max_count, nag_until, escalation_mode,
           completed_at, dismissed_at, repeat_rule, priority, device_origin,
           deleted_at, snooze_count
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
    }
  },
};
