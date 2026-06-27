import { applySnooze, type EscalationMode, type Task } from "@alarmed/core";

/**
 * Local persistence — the web counterpart to
 * `apps/mobile/src/db/database.ts`. Same on-device source of truth, same
 * CRUD surface (offline create / complete / reopen / soft-delete), just
 * backed by localStorage instead of SQLite since there's no native module
 * story on the web.
 */

const STORAGE_KEY = "alarmed.tasks";

function readAll(): Task[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as Task[];
  } catch {
    return [];
  }
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
