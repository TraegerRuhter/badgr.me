import { beforeEach, describe, expect, it } from "vitest";

import {
  createTask,
  completeTask,
  deleteTask,
  listTasks,
  localTaskStore,
  snoozeTask,
  STORAGE_KEY,
} from "./database";

// The store reads localStorage at call time, not import time, so an
// in-memory stub is enough — no DOM test environment needed.
function stubLocalStorage(): void {
  const data = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  } as Storage;
}

function seedRaw(entries: unknown[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

beforeEach(() => {
  stubLocalStorage();
});

describe("web task store", () => {
  it("round-trips a created task", async () => {
    const created = await createTask({
      title: "Pay rent",
      fireAt: new Date(Date.now() + 60_000).toISOString(),
      nagIntervalSeconds: 30,
    });
    const listed = await listTasks();
    expect(listed).toEqual([created]);
  });

  it("survives malformed JSON and non-array payloads", async () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    expect(await listTasks()).toEqual([]);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ id: "x" }));
    expect(await listTasks()).toEqual([]);
  });

  it("drops entries missing a usable id or title", async () => {
    seedRaw([null, 42, { id: "a" }, { title: "no id" }, { id: "", title: "x" }]);
    expect(await listTasks()).toEqual([]);
  });

  it("repairs corrupt fields instead of dropping (or crashing on) the task", async () => {
    seedRaw([
      {
        id: "t1",
        title: "Salvage me",
        fireAt: "not-a-date",
        nagIntervalSeconds: -5,
        escalationMode: "banana",
        snoozeCount: "seven",
        priority: Infinity,
        deviceOrigin: "toaster",
      },
    ]);
    const [task] = await listTasks();
    expect(task.title).toBe("Salvage me");
    // An unparseable fireAt is salvaged as null (undated), not a bogus date.
    expect(task.fireAt).toBeNull();
    expect(task.nagIntervalSeconds).toBeGreaterThan(0);
    expect(task.escalationMode).toBe("none");
    expect(task.snoozeCount).toBe(0);
    expect(task.priority).toBe(0);
    expect(task.deviceOrigin).toBe("web");
    expect(task.completedAt).toBeNull();
    expect(task.deletedAt).toBeNull();
  });

  it("hides soft-deleted tasks from listTasks but keeps them for sync", async () => {
    const task = await createTask({
      title: "Doomed",
      fireAt: new Date().toISOString(),
      nagIntervalSeconds: 30,
    });
    await deleteTask(task.id);
    expect(await listTasks()).toEqual([]);
    const forSync = await localTaskStore.listAllForSync();
    expect(forSync).toHaveLength(1);
    expect(forSync[0].deletedAt).not.toBeNull();
  });

  it("refuses to snooze a completed task", async () => {
    const task = await createTask({
      title: "Done already",
      fireAt: new Date().toISOString(),
      nagIntervalSeconds: 30,
    });
    await completeTask(task.id);
    expect(await snoozeTask(task.id)).toBeNull();
  });

  it("upsertMany merges by id rather than appending duplicates", async () => {
    const task = await createTask({
      title: "Original",
      fireAt: new Date().toISOString(),
      nagIntervalSeconds: 30,
    });
    await localTaskStore.upsertMany([{ ...task, title: "Replaced" }]);
    const listed = await listTasks();
    expect(listed).toHaveLength(1);
    expect(listed[0].title).toBe("Replaced");
  });
});
