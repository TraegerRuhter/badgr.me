import {
  applySnooze,
  shiftFireAt,
  type LocalTaskStore,
  type EscalationMode,
  type Task,
} from "@alarmed/core";

/**
 * Local persistence — the web counterpart to
 * `apps/mobile/src/db/database.ts`. Same on-device source of truth, same
 * CRUD surface (offline create / complete / reopen / soft-delete), just
 * backed by localStorage instead of SQLite since there's no native module
 * story on the web.
 */

export const STORAGE_KEY = "alarmed.tasks";

function isoString(value: unknown, fallback: string): string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value))
    ? value
    : fallback;
}

function isoStringOrNull(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value))
    ? value
    : null;
}

/**
 * Coerces one stored entry into a valid Task, or null if it's too corrupt to
 * use (no usable id/title). Every other field is backfilled with the same
 * defaults `createTask` uses — localStorage is user-editable and versions
 * drift, and one bad field must degrade that task's value, not crash the
 * scheduling math for the whole list. Salvage over strictness: sync would
 * happily propagate a dropped row's absence as staleness, so keeping a
 * repaired task beats silently losing it.
 */
function normalizeStoredTask(raw: unknown): Task | null {
  if (typeof raw !== "object" || raw === null) return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.id !== "string" || t.id.length === 0) return null;
  if (typeof t.title !== "string" || t.title.length === 0) return null;

  const now = new Date().toISOString();
  return {
    id: t.id,
    title: t.title,
    notes: typeof t.notes === "string" ? t.notes : null,
    createdAt: isoString(t.createdAt, now),
    updatedAt: isoString(t.updatedAt, now),
    fireAt: isoString(t.fireAt, now),
    nagIntervalSeconds:
      typeof t.nagIntervalSeconds === "number" &&
      Number.isFinite(t.nagIntervalSeconds) &&
      t.nagIntervalSeconds > 0
        ? t.nagIntervalSeconds
        : 60,
    nagMaxCount:
      typeof t.nagMaxCount === "number" &&
      Number.isInteger(t.nagMaxCount) &&
      t.nagMaxCount > 0
        ? t.nagMaxCount
        : null,
    nagUntil: isoStringOrNull(t.nagUntil),
    escalationMode:
      t.escalationMode === "shrink" || t.escalationMode === "sound"
        ? t.escalationMode
        : "none",
    completedAt: isoStringOrNull(t.completedAt),
    dismissedAt: isoStringOrNull(t.dismissedAt),
    repeatRule: typeof t.repeatRule === "string" ? t.repeatRule : null,
    priority:
      typeof t.priority === "number" && Number.isFinite(t.priority)
        ? t.priority
        : 0,
    deviceOrigin: t.deviceOrigin === "mobile" ? "mobile" : "web",
    deletedAt: isoStringOrNull(t.deletedAt),
    snoozeCount:
      typeof t.snoozeCount === "number" &&
      Number.isInteger(t.snoozeCount) &&
      t.snoozeCount >= 0
        ? t.snoozeCount
        : 0,
  };
}

function readAll(): Task[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map(normalizeStoredTask).filter((t): t is Task => t !== null);
}

function writeAll(tasks: Task[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
}

export async function initDatabase(): Promise<void> {
  if (localStorage.getItem(STORAGE_KEY) == null) {
    writeAll([]);
  }
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
  return readAll()
    .filter((task) => task.deletedAt == null)
    .sort((a, b) => {
      const aDone = a.completedAt != null ? 1 : 0;
      const bDone = b.completedAt != null ? 1 : 0;
      if (aDone !== bDone) return aDone - bDone;
      return a.fireAt.localeCompare(b.fireAt);
    });
}

export async function createTask(input: NewTaskInput): Promise<Task> {
  const now = new Date().toISOString();
  const task: Task = {
    id: crypto.randomUUID(),
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
    deviceOrigin: "web",
    deletedAt: null,
    snoozeCount: 0,
  };

  const tasks = readAll();
  tasks.push(task);
  writeAll(tasks);

  return task;
}

/** Marks a task done — the scheduler then cancels its remaining nags. */
export async function completeTask(id: string): Promise<void> {
  const now = new Date().toISOString();
  const tasks = readAll();
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  task.completedAt = now;
  task.updatedAt = now;
  writeAll(tasks);
}

export async function reopenTask(id: string): Promise<void> {
  const now = new Date().toISOString();
  const tasks = readAll();
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  task.completedAt = null;
  task.updatedAt = now;
  writeAll(tasks);
}

export async function getTask(id: string): Promise<Task | null> {
  return readAll().find((t) => t.id === id) ?? null;
}

/**
 * Pushes a task's fire time out and bumps its snooze count (spec §3.4,
 * escalation) — the web counterpart to `apps/mobile/src/db/database.ts`'s
 * `snoozeTask`.
 */
export async function snoozeTask(
  id: string,
  options?: { snoozeSeconds?: number; now?: Date }
): Promise<Task | null> {
  const tasks = readAll();
  const task = tasks.find((t) => t.id === id);
  // Don't resurrect a finished task: snoozing a stale notification for one
  // that's already been completed or deleted must be a no-op.
  if (!task || task.completedAt != null || task.deletedAt != null) return null;

  const { fireAt, snoozeCount } = applySnooze(task, options);
  task.fireAt = fireAt.toISOString();
  task.snoozeCount = snoozeCount;
  task.updatedAt = new Date().toISOString();
  writeAll(tasks);

  return task;
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
  const tasks = readAll();
  const task = tasks.find((t) => t.id === id);
  if (!task || task.deletedAt != null) return null;

  if (patch.title !== undefined && patch.title.trim().length > 0) {
    task.title = patch.title.trim();
  }
  if (patch.notes !== undefined) {
    const trimmed = patch.notes?.trim() ?? "";
    task.notes = trimmed.length > 0 ? trimmed : null;
  }
  if (patch.fireAt !== undefined && !Number.isNaN(Date.parse(patch.fireAt))) {
    task.fireAt = patch.fireAt;
  }
  if (
    patch.nagIntervalSeconds !== undefined &&
    Number.isInteger(patch.nagIntervalSeconds) &&
    patch.nagIntervalSeconds > 0
  ) {
    task.nagIntervalSeconds = patch.nagIntervalSeconds;
  }
  if (patch.nagMaxCount !== undefined) {
    task.nagMaxCount =
      patch.nagMaxCount != null &&
      Number.isInteger(patch.nagMaxCount) &&
      patch.nagMaxCount > 0
        ? patch.nagMaxCount
        : null;
  }
  if (patch.escalationMode !== undefined) {
    task.escalationMode = patch.escalationMode;
  }
  task.updatedAt = new Date().toISOString();
  writeAll(tasks);

  return task;
}

/**
 * The PowerCircle: pause (alerts off, task stays put) or resume. Paused
 * tasks are skipped by the planner entirely — completing/deleting is not
 * required to make a task shut up for a while.
 */
export async function setTaskPaused(
  id: string,
  paused: boolean
): Promise<Task | null> {
  const tasks = readAll();
  const task = tasks.find((t) => t.id === id);
  if (!task || task.completedAt != null || task.deletedAt != null) return null;

  const now = new Date().toISOString();
  task.dismissedAt = paused ? now : null;
  task.updatedAt = now;
  writeAll(tasks);

  return task;
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
  const tasks = readAll();
  const task = tasks.find((t) => t.id === id);
  if (!task || task.completedAt != null || task.deletedAt != null) return null;

  task.fireAt = shiftFireAt(task, deltaSeconds);
  task.updatedAt = new Date().toISOString();
  writeAll(tasks);

  return task;
}

/** Soft delete so the removal can later propagate through sync (spec §5). */
export async function deleteTask(id: string): Promise<void> {
  const now = new Date().toISOString();
  const tasks = readAll();
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  task.deletedAt = now;
  task.updatedAt = now;
  writeAll(tasks);
}

/**
 * The `LocalTaskStore` the core sync engine drives. Unlike `listTasks` this
 * includes soft-deleted rows (sync needs deletes to converge), and `upsertMany`
 * applies whatever the reconcile decided the local store should take.
 */
export const localTaskStore: LocalTaskStore = {
  async listAllForSync(): Promise<Task[]> {
    return readAll();
  },
  async upsertMany(incoming: Task[]): Promise<void> {
    if (incoming.length === 0) return;
    const byId = new Map(readAll().map((t) => [t.id, t]));
    for (const task of incoming) byId.set(task.id, task);
    writeAll([...byId.values()]);
  },
};
