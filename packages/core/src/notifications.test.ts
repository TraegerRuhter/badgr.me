import { describe, expect, it } from "vitest";

import { SAFE_GLOBAL_NOTIFICATION_BUDGET } from "./nag";
import {
  buildNotificationId,
  isNagNotificationId,
  parseNotificationId,
  planNagNotifications,
} from "./notifications";
import type { Task } from "./types";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-01-01T00:00:00.000Z");

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    title: "Test task",
    notes: null,
    createdAt: "2025-12-31T00:00:00.000Z",
    updatedAt: "2025-12-31T00:00:00.000Z",
    fireAt: "2026-01-01T00:00:00.000Z",
    nagIntervalSeconds: 120,
    nagMaxCount: 5,
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

describe("notification identifiers", () => {
  it("round-trips a task id and index", () => {
    const id = buildNotificationId(TASK_ID, 3);
    expect(parseNotificationId(id)).toEqual({ taskId: TASK_ID, index: 3 });
  });

  it("recognizes its own ids and rejects foreign ones", () => {
    expect(isNagNotificationId(buildNotificationId(TASK_ID, 0))).toBe(true);
    expect(isNagNotificationId("some-other-id")).toBe(false);
    expect(isNagNotificationId(`nag:${TASK_ID}`)).toBe(false);
    expect(parseNotificationId("nag:abc:-1")).toBeNull();
  });
});

describe("planNagNotifications", () => {
  it("plans one notification per future fire in the burst", () => {
    const planned = planNagNotifications([makeTask()], { now: NOW });
    expect(planned).toHaveLength(5); // nagMaxCount
    expect(planned.every((p) => p.fireAt.getTime() >= NOW.getTime())).toBe(true);
    expect(planned.every((p) => p.taskId === TASK_ID)).toBe(true);
  });

  it("excludes completed and soft-deleted tasks", () => {
    const tasks = [
      makeTask({ id: "a", completedAt: NOW.toISOString() }),
      makeTask({ id: "b", deletedAt: NOW.toISOString() }),
      makeTask({ id: "c" }),
    ];
    const planned = planNagNotifications(tasks, { now: NOW });
    expect(new Set(planned.map((p) => p.taskId))).toEqual(new Set(["c"]));
  });

  it("returns nothing when no task is naggable", () => {
    const planned = planNagNotifications(
      [makeTask({ completedAt: NOW.toISOString() })],
      { now: NOW }
    );
    expect(planned).toEqual([]);
  });

  it("never exceeds the global budget across many tasks", () => {
    const tasks: Task[] = Array.from({ length: 30 }, (_, i) =>
      makeTask({
        id: `task-${i}`,
        nagMaxCount: null,
        nagIntervalSeconds: 60,
      })
    );
    const planned = planNagNotifications(tasks, { now: NOW });
    expect(planned.length).toBeLessThanOrEqual(SAFE_GLOBAL_NOTIFICATION_BUDGET);
  });

  it("emits unique identifiers that map back to their task", () => {
    const tasks = [
      makeTask({ id: "a", nagMaxCount: 3 }),
      makeTask({ id: "b", nagMaxCount: 3 }),
    ];
    const planned = planNagNotifications(tasks, { now: NOW });
    const ids = planned.map((p) => p.identifier);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of planned) {
      expect(parseNotificationId(p.identifier)?.taskId).toBe(p.taskId);
    }
  });

  it("uses notes as the body when present", () => {
    const planned = planNagNotifications(
      [makeTask({ notes: "bring the form" })],
      { now: NOW }
    );
    expect(planned[0]?.body).toBe("bring the form");
  });

  it("escalates body copy further into the burst, and starts higher with a nonzero snoozeCount", () => {
    const fresh = planNagNotifications(
      [makeTask({ nagMaxCount: 6, snoozeCount: 0 })],
      { now: NOW }
    );
    const presnoozed = planNagNotifications(
      [makeTask({ nagMaxCount: 6, snoozeCount: 5 })],
      { now: NOW }
    );

    // same task, same burst length, but the already-snoozed one starts at a
    // harsher tier than the fresh one ends at.
    expect(fresh[0]?.body).not.toBe(fresh[5]?.body);
    expect(presnoozed[0]?.body).toBe(fresh[5]?.body);
  });
});
