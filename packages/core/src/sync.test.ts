import { describe, expect, it, vi } from "vitest";
import {
  reconcileTasks,
  syncTasks,
  type LocalTaskStore,
  type RemoteTaskStore,
} from "./sync";
import type { Task } from "./types";

function makeTask(id: string, updatedAt: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `task ${id}`,
    notes: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
    fireAt: "2026-01-01T00:10:00.000Z",
    nagIntervalSeconds: 120,
    nagMaxCount: null,
    nagUntil: null,
    escalationMode: "none",
    completedAt: null,
    dismissedAt: null,
    repeatRule: null,
    priority: 0,
    deviceOrigin: "mobile",
    deletedAt: null,
    snoozeCount: 0,
    ...overrides,
  };
}

const T1 = "2026-01-01T01:00:00.000Z";
const T2 = "2026-01-01T02:00:00.000Z";

describe("reconcileTasks", () => {
  it("pushes up rows that exist only locally", () => {
    const plan = reconcileTasks([makeTask("a", T1)], []);
    expect(plan.toPushUp.map((t) => t.id)).toEqual(["a"]);
    expect(plan.toApplyLocal).toEqual([]);
  });

  it("applies locally rows that exist only remotely", () => {
    const plan = reconcileTasks([], [makeTask("b", T1)]);
    expect(plan.toApplyLocal.map((t) => t.id)).toEqual(["b"]);
    expect(plan.toPushUp).toEqual([]);
  });

  it("lets the newer side win on conflict (local newer)", () => {
    const plan = reconcileTasks([makeTask("a", T2)], [makeTask("a", T1)]);
    expect(plan.toPushUp.map((t) => t.id)).toEqual(["a"]);
    expect(plan.toApplyLocal).toEqual([]);
  });

  it("lets the newer side win on conflict (remote newer)", () => {
    const plan = reconcileTasks([makeTask("a", T1)], [makeTask("a", T2)]);
    expect(plan.toApplyLocal.map((t) => t.id)).toEqual(["a"]);
    expect(plan.toPushUp).toEqual([]);
  });

  it("treats equal timestamps as already in sync (no move)", () => {
    const plan = reconcileTasks([makeTask("a", T1)], [makeTask("a", T1)]);
    expect(plan.toPushUp).toEqual([]);
    expect(plan.toApplyLocal).toEqual([]);
  });

  it("propagates a local soft-delete up when it is the newer edit", () => {
    const local = makeTask("a", T2, { deletedAt: T2 });
    const remote = makeTask("a", T1);
    const plan = reconcileTasks([local], [remote]);
    expect(plan.toPushUp[0]?.deletedAt).toBe(T2);
    expect(plan.toApplyLocal).toEqual([]);
  });

  it("propagates a remote soft-delete down when it is the newer edit", () => {
    const local = makeTask("a", T1);
    const remote = makeTask("a", T2, { deletedAt: T2 });
    const plan = reconcileTasks([local], [remote]);
    expect(plan.toApplyLocal[0]?.deletedAt).toBe(T2);
    expect(plan.toPushUp).toEqual([]);
  });

  it("handles a mixed batch in a single pass", () => {
    const local = [
      makeTask("onlyLocal", T1),
      makeTask("localNewer", T2),
      makeTask("remoteNewer", T1),
      makeTask("same", T1),
    ];
    const remote = [
      makeTask("onlyRemote", T1),
      makeTask("localNewer", T1),
      makeTask("remoteNewer", T2),
      makeTask("same", T1),
    ];
    const plan = reconcileTasks(local, remote);
    expect(new Set(plan.toPushUp.map((t) => t.id))).toEqual(
      new Set(["onlyLocal", "localNewer"])
    );
    expect(new Set(plan.toApplyLocal.map((t) => t.id))).toEqual(
      new Set(["onlyRemote", "remoteNewer"])
    );
  });
});

describe("syncTasks", () => {
  it("pushes and pulls the reconciled rows and reports the counts", async () => {
    const local: LocalTaskStore = {
      listAllForSync: vi
        .fn()
        .mockResolvedValue([makeTask("a", T2), makeTask("b", T1)]),
      upsertMany: vi.fn().mockResolvedValue(undefined),
    };
    const remote: RemoteTaskStore = {
      listAll: vi.fn().mockResolvedValue([makeTask("b", T2), makeTask("c", T1)]),
      upsertMany: vi.fn().mockResolvedValue(undefined),
    };

    const result = await syncTasks(local, remote);

    // a is local-only → push; b remote newer → pull; c remote-only → pull
    expect(remote.upsertMany).toHaveBeenCalledWith([
      expect.objectContaining({ id: "a" }),
    ]);
    const pulled = vi.mocked(local.upsertMany).mock.calls[0][0].map((t) => t.id);
    expect(new Set(pulled)).toEqual(new Set(["b", "c"]));
    expect(result).toEqual({ pushed: 1, pulled: 2 });
  });

  it("skips empty writes when nothing changed", async () => {
    const local: LocalTaskStore = {
      listAllForSync: vi.fn().mockResolvedValue([makeTask("a", T1)]),
      upsertMany: vi.fn().mockResolvedValue(undefined),
    };
    const remote: RemoteTaskStore = {
      listAll: vi.fn().mockResolvedValue([makeTask("a", T1)]),
      upsertMany: vi.fn().mockResolvedValue(undefined),
    };

    const result = await syncTasks(local, remote);

    expect(local.upsertMany).not.toHaveBeenCalled();
    expect(remote.upsertMany).not.toHaveBeenCalled();
    expect(result).toEqual({ pushed: 0, pulled: 0 });
  });
});
