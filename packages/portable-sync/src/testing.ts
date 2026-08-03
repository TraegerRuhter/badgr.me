import type { LocalTaskStore, Task } from "@alarmed/core";

import type { SeqStore } from "./store";

/**
 * In-memory stand-ins for the two platform seams, so the rollback rule and the
 * merge behaviour can be tested without a device, a keystore, or a filesystem.
 * Test-only.
 */

export function memorySeqStore(initial = 0n): SeqStore & { value: bigint } {
  let value = initial;
  return {
    get value() {
      return value;
    },
    async getSeqSeen() {
      return value;
    },
    async setSeqSeen(seq) {
      value = seq;
    },
  };
}

export function memoryTaskStore(initial: Task[] = []): LocalTaskStore & { rows: Task[] } {
  let rows = [...initial];
  return {
    get rows() {
      return rows;
    },
    async listAllForSync() {
      return [...rows];
    },
    async upsertMany(incoming) {
      const byId = new Map(rows.map((t) => [t.id, t]));
      for (const task of incoming) byId.set(task.id, task);
      rows = [...byId.values()];
    },
  };
}
