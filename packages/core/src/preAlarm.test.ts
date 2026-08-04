import { describe, expect, it } from "vitest";
import {
  allocateNotificationBudget,
  MAX_BURST_PER_TASK,
  SAFE_GLOBAL_NOTIFICATION_BUDGET,
} from "./nag";
import {
  buildPreAlarmId,
  isNagNotificationId,
  parseNotificationId,
  planNagNotifications,
  PRE_ALARM_SLOT,
} from "./notifications";
import type { Task } from "./types";

/**
 * Pre-alarm lead time (due-parity plan §3.6, Phase 4).
 *
 * The gate for this phase is invariant U6: a new per-task option must not be
 * able to push the app past the notification ceiling. Everything here exists to
 * hold that line, because exceeding it means iOS silently drops notifications
 * and the nag stops working with no visible failure.
 */

const NOW = new Date("2026-08-03T09:00:00.000Z");

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t",
    title: "Take shot",
    notes: null,
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-08-01T09:00:00.000Z",
    fireAt: "2026-08-03T12:00:00.000Z",
    nagIntervalSeconds: 900,
    nagMaxCount: 6,
    nagUntil: null,
    escalationMode: "none",
    completedAt: null,
    dismissedAt: null,
    repeatRule: null,
    priority: 0,
    deviceOrigin: "web",
    deletedAt: null,
    snoozeCount: 0,
    leadTimeSeconds: null,
    ...overrides,
  };
}

describe("U6 — the notification ceiling holds", () => {
  it("never exceeds the budget with every task carrying a lead time", () => {
    const tasks = Array.from({ length: 40 }, (_, i) =>
      task({
        id: `t${i}`,
        fireAt: new Date(NOW.getTime() + (i + 1) * 3600_000).toISOString(),
        leadTimeSeconds: 900,
        nagMaxCount: null, // uncapped: each task will take everything it can get
      })
    );

    const planned = planNagNotifications(tasks, { now: NOW });
    expect(planned.length).toBeLessThanOrEqual(SAFE_GLOBAL_NOTIFICATION_BUDGET);
  });

  it("counts the pre-alarm against the budget, not around it", () => {
    // A tight budget: without accounting, the pre-alarms would be free extras.
    const tasks = Array.from({ length: 5 }, (_, i) =>
      task({
        id: `t${i}`,
        fireAt: new Date(NOW.getTime() + (i + 1) * 3600_000).toISOString(),
        leadTimeSeconds: 600,
        nagMaxCount: 2,
      })
    );

    const budget = 7;
    const planned = planNagNotifications(tasks, { now: NOW, globalBudget: budget });
    expect(planned.length).toBeLessThanOrEqual(budget);
  });

  it("spends the last slot on the real fire, not the heads-up", () => {
    // With one slot available, the notification at the actual time is worth
    // more than a warning that it is coming.
    const bursts = allocateNotificationBudget(
      [
        {
          id: "only",
          fireAt: new Date(NOW.getTime() + 3600_000),
          nagIntervalSeconds: 900,
          nagMaxCount: 5,
          leadTimeSeconds: 600,
        },
      ],
      { globalBudget: 1, now: NOW }
    );

    expect(bursts[0].fireTimes).toHaveLength(1);
    expect(bursts[0].preAlarm).toBeUndefined();
  });

  it("adds the heads-up once there is room for both", () => {
    const bursts = allocateNotificationBudget(
      [
        {
          id: "only",
          fireAt: new Date(NOW.getTime() + 3600_000),
          nagIntervalSeconds: 900,
          nagMaxCount: 1,
          leadTimeSeconds: 600,
        },
      ],
      { globalBudget: 2, now: NOW }
    );

    expect(bursts[0].fireTimes).toHaveLength(1);
    expect(bursts[0].preAlarm).toBeInstanceOf(Date);
  });

  it("holds the ceiling even at the per-task cap", () => {
    const tasks = Array.from({ length: 10 }, (_, i) =>
      task({
        id: `t${i}`,
        fireAt: new Date(NOW.getTime() + (i + 1) * 86_400_000).toISOString(),
        nagIntervalSeconds: 60,
        nagMaxCount: MAX_BURST_PER_TASK * 2,
        leadTimeSeconds: 3600,
      })
    );
    const planned = planNagNotifications(tasks, { now: NOW });
    expect(planned.length).toBeLessThanOrEqual(SAFE_GLOBAL_NOTIFICATION_BUDGET);
  });
});

describe("when a pre-alarm is scheduled at all", () => {
  it("fires exactly the lead time before the task", () => {
    const fireAt = new Date(NOW.getTime() + 3600_000);
    const bursts = allocateNotificationBudget(
      [
        {
          id: "t",
          fireAt,
          nagIntervalSeconds: 900,
          nagMaxCount: 1,
          leadTimeSeconds: 900,
        },
      ],
      { now: NOW }
    );
    expect(bursts[0].preAlarm?.getTime()).toBe(fireAt.getTime() - 900_000);
  });

  it("is skipped when it would already be in the past", () => {
    // Task due in 5 minutes with a 15-minute heads-up: the warning moment has
    // gone, and scheduling it would be scheduling a trigger in the past.
    const bursts = allocateNotificationBudget(
      [
        {
          id: "t",
          fireAt: new Date(NOW.getTime() + 300_000),
          nagIntervalSeconds: 900,
          nagMaxCount: 1,
          leadTimeSeconds: 900,
        },
      ],
      { now: NOW }
    );
    expect(bursts[0].preAlarm).toBeUndefined();
    expect(bursts[0].fireTimes).toHaveLength(1);
  });

  it("is absent when no lead time is set", () => {
    const bursts = allocateNotificationBudget(
      [{ id: "t", fireAt: new Date(NOW.getTime() + 3600_000), nagIntervalSeconds: 900 }],
      { now: NOW }
    );
    expect(bursts[0].preAlarm).toBeUndefined();
  });

  it("does not consume a nag occurrence", () => {
    // The heads-up precedes the task; charging it against nagMaxCount would
    // silently cost the user one of their nags.
    const withLead = allocateNotificationBudget(
      [
        {
          id: "t",
          fireAt: new Date(NOW.getTime() + 3600_000),
          nagIntervalSeconds: 900,
          nagMaxCount: 3,
          leadTimeSeconds: 600,
        },
      ],
      { now: NOW }
    );
    expect(withLead[0].fireTimes).toHaveLength(3);
  });
});

describe("the pre-alarm notification itself", () => {
  it("is plain and factual, not part of the escalation ladder", () => {
    const planned = planNagNotifications(
      [task({ leadTimeSeconds: 900, snoozeCount: 8 })],
      { now: NOW }
    );
    const pre = planned.find((p) => p.identifier.endsWith(PRE_ALARM_SLOT));
    // snoozeCount 8 would be deep into the sass ladder; a heads-up for a task
    // that is not even late yet should not open with that.
    expect(pre?.title).toBe("Take shot");
    expect(pre?.body).toMatch(/^Coming up in /);
  });

  it("shares the task's id prefix so cancelling clears it too", () => {
    const id = buildPreAlarmId("abc");
    expect(id.startsWith("nag:abc:")).toBe(true);
    expect(isNagNotificationId(id)).toBe(true);
    expect(parseNotificationId(id)).toEqual({ taskId: "abc", index: 0, preAlarm: true });
  });

  it("cannot collide with a burst position", () => {
    expect(buildPreAlarmId("abc")).not.toBe("nag:abc:0");
    expect(parseNotificationId("nag:abc:0")?.preAlarm).toBeUndefined();
  });

  it("is scheduled before the first real fire", () => {
    const planned = planNagNotifications([task({ leadTimeSeconds: 900 })], { now: NOW });
    const pre = planned.find((p) => p.identifier.endsWith(PRE_ALARM_SLOT));
    const first = planned.find((p) => p.identifier === "nag:t:0");
    expect(pre!.fireAt.getTime()).toBeLessThan(first!.fireAt.getTime());
  });

  it("is absent for a task with no lead time", () => {
    const planned = planNagNotifications([task()], { now: NOW });
    expect(planned.some((p) => p.identifier.endsWith(PRE_ALARM_SLOT))).toBe(false);
  });

  it("is not scheduled for a paused or completed task", () => {
    for (const overrides of [
      { dismissedAt: NOW.toISOString() },
      { completedAt: NOW.toISOString() },
      { fireAt: null },
    ] as Partial<Task>[]) {
      const planned = planNagNotifications([task({ leadTimeSeconds: 900, ...overrides })], {
        now: NOW,
      });
      expect(planned).toHaveLength(0);
    }
  });
});
