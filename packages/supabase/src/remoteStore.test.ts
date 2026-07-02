import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Task } from "@alarmed/core";
import {
  createSupabaseRemoteStore,
  rowToTask,
  taskToRow,
  type TaskRow,
} from "./remoteStore";

function makeRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Renew passport",
    notes: "bring the form",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    fire_at: "2026-01-01T00:10:00.000Z",
    nag_interval_seconds: 120,
    nag_max_count: 6,
    nag_until: null,
    escalation_mode: "shrink",
    completed_at: null,
    dismissed_at: null,
    repeat_rule: null,
    priority: 2,
    device_origin: "web",
    deleted_at: null,
    snooze_count: 3,
    ...overrides,
  };
}

describe("row <-> task mapping", () => {
  it("round-trips a row through Task and back unchanged", () => {
    const row = makeRow();
    expect(taskToRow(rowToTask(row))).toEqual(row);
  });

  it("maps every column to its camelCase Task field", () => {
    const task = rowToTask(makeRow());
    expect(task).toMatchObject<Partial<Task>>({
      id: "11111111-1111-4111-8111-111111111111",
      nagIntervalSeconds: 120,
      nagMaxCount: 6,
      escalationMode: "shrink",
      deviceOrigin: "web",
      snoozeCount: 3,
      notes: "bring the form",
    });
  });

  it("preserves soft-delete and null fields", () => {
    const task = rowToTask(makeRow({ deleted_at: "2026-01-03T00:00:00.000Z", notes: null }));
    expect(task.deletedAt).toBe("2026-01-03T00:00:00.000Z");
    expect(task.notes).toBeNull();
  });
});

// Minimal fake of the supabase query builder for the two calls the store
// makes. listAll pages via select().order().range(), so the fake slices the
// backing array the way PostgREST would.
function fakeClient(opts: {
  selectData?: TaskRow[];
  selectError?: { message: string };
  upsertError?: { message: string };
}) {
  const upsert = vi.fn().mockResolvedValue({ error: opts.upsertError ?? null });
  const range = vi.fn().mockImplementation((from: number, to: number) =>
    Promise.resolve(
      opts.selectError
        ? { data: null, error: opts.selectError }
        : { data: (opts.selectData ?? []).slice(from, to + 1), error: null }
    )
  );
  const order = vi.fn().mockReturnValue({ range });
  const select = vi.fn().mockReturnValue({ order });
  const from = vi.fn().mockReturnValue({ select, upsert });
  return { client: { from } as unknown as SupabaseClient, from, select, range, upsert };
}

describe("createSupabaseRemoteStore", () => {
  it("listAll selects all rows and maps them to tasks", async () => {
    const { client, from, select } = fakeClient({ selectData: [makeRow()] });
    const store = createSupabaseRemoteStore(client);

    const tasks = await store.listAll();

    expect(from).toHaveBeenCalledWith("tasks");
    expect(select).toHaveBeenCalledWith("*");
    expect(tasks[0]?.id).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("pages past the PostgREST row cap instead of truncating", async () => {
    // 1000 full page + 500 partial page: both must come back.
    const many = Array.from({ length: 1500 }, (_, i) =>
      makeRow({ id: `id-${String(i).padStart(5, "0")}` })
    );
    const { client, range } = fakeClient({ selectData: many });
    const store = createSupabaseRemoteStore(client);

    const tasks = await store.listAll();

    expect(tasks).toHaveLength(1500);
    expect(range).toHaveBeenCalledTimes(2);
    expect(range).toHaveBeenNthCalledWith(1, 0, 999);
    expect(range).toHaveBeenNthCalledWith(2, 1000, 1999);
  });

  it("skips rows the sync engine couldn't reconcile instead of importing them", async () => {
    const good = makeRow();
    const noId = makeRow({ id: "" });
    const noTitle = makeRow({ id: "22222222-2222-4222-8222-222222222222", title: "" });
    const badStamp = makeRow({
      id: "33333333-3333-4333-8333-333333333333",
      updated_at: "not a timestamp",
    });
    const { client } = fakeClient({ selectData: [good, noId, noTitle, badStamp] });
    const store = createSupabaseRemoteStore(client);

    const tasks = await store.listAll();

    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe(good.id);
  });

  it("upsertMany writes mapped rows with id conflict target", async () => {
    const { client, upsert } = fakeClient({});
    const store = createSupabaseRemoteStore(client);
    const task = rowToTask(makeRow());

    await store.upsertMany([task]);

    expect(upsert).toHaveBeenCalledWith(
      [expect.objectContaining({ id: task.id, snooze_count: 3 })],
      { onConflict: "id" }
    );
  });

  it("upsertMany no-ops on an empty batch", async () => {
    const { client, from } = fakeClient({});
    const store = createSupabaseRemoteStore(client);
    await store.upsertMany([]);
    expect(from).not.toHaveBeenCalled();
  });

  it("throws a descriptive error when select fails", async () => {
    const { client } = fakeClient({ selectError: { message: "boom" } });
    const store = createSupabaseRemoteStore(client);
    await expect(store.listAll()).rejects.toThrow(/supabase listAll failed: boom/);
  });

  it("throws a descriptive error when upsert fails", async () => {
    const { client } = fakeClient({ upsertError: { message: "nope" } });
    const store = createSupabaseRemoteStore(client);
    await expect(store.upsertMany([rowToTask(makeRow())])).rejects.toThrow(
      /supabase upsertMany failed: nope/
    );
  });
});
