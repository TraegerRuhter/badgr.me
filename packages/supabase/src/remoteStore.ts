import type {
  DeviceOrigin,
  EscalationMode,
  RemoteTaskStore,
  Task,
} from "@alarmed/core";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Maps the shared `Task` type to/from the Postgres `tasks` table (snake_case
 * columns, see supabase/migrations) and exposes it as the `RemoteTaskStore`
 * the core sync engine drives. Timestamps stay ISO-8601 strings on both
 * sides, so they pass through untouched.
 */

export interface TaskRow {
  id: string;
  title: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
  fire_at: string | null;
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

export function rowToTask(row: TaskRow): Task {
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

export function taskToRow(task: Task): TaskRow {
  return {
    id: task.id,
    title: task.title,
    notes: task.notes,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    fire_at: task.fireAt,
    nag_interval_seconds: task.nagIntervalSeconds,
    nag_max_count: task.nagMaxCount,
    nag_until: task.nagUntil,
    escalation_mode: task.escalationMode,
    completed_at: task.completedAt,
    dismissed_at: task.dismissedAt,
    repeat_rule: task.repeatRule,
    priority: task.priority,
    device_origin: task.deviceOrigin,
    deleted_at: task.deletedAt,
    snooze_count: task.snoozeCount,
  };
}

const DEFAULT_TABLE = "tasks";

// PostgREST caps any single response (Supabase default: 1000 rows). listAll
// must page past that or sync silently reconciles against a truncated
// snapshot once the table outgrows one page.
const PAGE_SIZE = 1000;

/**
 * A row the sync engine can safely reconcile: it needs a real id to pair on,
 * a parseable updated_at for last-write-wins, and a title to render. Anything
 * else degrades gracefully client-side, but these three would corrupt the
 * sync decision itself — skip such rows instead of importing them.
 */
function isUsableRow(row: TaskRow): boolean {
  return (
    typeof row.id === "string" &&
    row.id.length > 0 &&
    typeof row.title === "string" &&
    row.title.length > 0 &&
    typeof row.updated_at === "string" &&
    !Number.isNaN(Date.parse(row.updated_at))
  );
}

export function createSupabaseRemoteStore(
  client: SupabaseClient,
  table: string = DEFAULT_TABLE
): RemoteTaskStore {
  return {
    async listAll(): Promise<Task[]> {
      // Pull everything including soft-deleted rows — the sync engine needs
      // deletes to converge. Ordered paging keeps the pages stable.
      const rows: TaskRow[] = [];
      for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error } = await client
          .from(table)
          .select("*")
          .order("id", { ascending: true })
          .range(from, from + PAGE_SIZE - 1);
        if (error) throw new Error(`supabase listAll failed: ${error.message}`);
        const page = (data ?? []) as TaskRow[];
        rows.push(...page);
        if (page.length < PAGE_SIZE) break;
      }
      return rows.filter(isUsableRow).map(rowToTask);
    },

    async upsertMany(tasks: Task[]): Promise<void> {
      if (tasks.length === 0) return;
      const { error } = await client
        .from(table)
        .upsert(tasks.map(taskToRow), { onConflict: "id" });
      if (error) throw new Error(`supabase upsertMany failed: ${error.message}`);
    },
  };
}
