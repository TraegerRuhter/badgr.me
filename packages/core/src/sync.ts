import type { Task } from "./types";

/**
 * Sync engine (spec §5): reconciles the local on-device store against the
 * Supabase mirror using last-write-wins on `updatedAt`. Pure and
 * platform-agnostic — the actual reads/writes live behind the
 * `LocalTaskStore`/`RemoteTaskStore` seams so this is fully unit-testable
 * with no network.
 *
 * Soft deletes need no special case: a deleted task just carries a non-null
 * `deletedAt` and a bumped `updatedAt`, so it propagates like any other edit
 * and both sides converge on "deleted".
 */

/** Wins ties? No — equal timestamps mean already-in-sync, so neither side moves. */
function newer(a: Task, b: Task): number {
  return Date.parse(a.updatedAt) - Date.parse(b.updatedAt);
}

export interface SyncPlan {
  /** Local rows the remote should accept (new locally, or locally newer). */
  toPushUp: Task[];
  /** Remote rows the local store should accept (new remotely, or remotely newer). */
  toApplyLocal: Task[];
}

/**
 * Computes which rows move in each direction. Both inputs MUST include
 * soft-deleted rows, or a delete on one side can't propagate to the other.
 */
export function reconcileTasks(local: Task[], remote: Task[]): SyncPlan {
  const pairs = new Map<string, { local?: Task; remote?: Task }>();
  for (const t of local) pairs.set(t.id, { ...pairs.get(t.id), local: t });
  for (const t of remote) pairs.set(t.id, { ...pairs.get(t.id), remote: t });

  const toPushUp: Task[] = [];
  const toApplyLocal: Task[] = [];

  for (const { local: l, remote: r } of pairs.values()) {
    if (l && !r) {
      toPushUp.push(l);
    } else if (r && !l) {
      toApplyLocal.push(r);
    } else if (l && r) {
      const diff = newer(l, r);
      if (diff > 0) toPushUp.push(l);
      else if (diff < 0) toApplyLocal.push(r);
      // diff === 0 → identical timestamp, already in sync
    }
  }

  return { toPushUp, toApplyLocal };
}

/** Reads every row including soft-deleted ones (sync needs deletes too). */
export interface LocalTaskStore {
  listAllForSync(): Promise<Task[]>;
  upsertMany(tasks: Task[]): Promise<void>;
}

export interface RemoteTaskStore {
  listAll(): Promise<Task[]>;
  upsertMany(tasks: Task[]): Promise<void>;
}

export interface SyncResult {
  pushed: number;
  pulled: number;
}

/**
 * One reconciliation pass: pull both snapshots, compute the plan, then apply
 * both directions. Pushing up and applying down are independent, so they run
 * concurrently. Returns how many rows moved each way (for UI/telemetry).
 */
export async function syncTasks(
  local: LocalTaskStore,
  remote: RemoteTaskStore
): Promise<SyncResult> {
  const [localTasks, remoteTasks] = await Promise.all([
    local.listAllForSync(),
    remote.listAll(),
  ]);

  const plan = reconcileTasks(localTasks, remoteTasks);

  await Promise.all([
    plan.toPushUp.length > 0 ? remote.upsertMany(plan.toPushUp) : Promise.resolve(),
    plan.toApplyLocal.length > 0
      ? local.upsertMany(plan.toApplyLocal)
      : Promise.resolve(),
  ]);

  return { pushed: plan.toPushUp.length, pulled: plan.toApplyLocal.length };
}
