import { describe, expect, it } from "vitest";
import {
  allocateNotificationBudget,
  computeNagBurst,
  MAX_BURST_PER_TASK,
  SAFE_GLOBAL_NOTIFICATION_BUDGET,
  SHRINK_FLOOR_SECONDS,
} from "./nag";

const FIRE_AT = new Date("2026-06-20T09:00:00.000Z");
const NOW_BEFORE_FIRE = new Date("2026-06-20T08:00:00.000Z");

describe("computeNagBurst", () => {
  it("produces evenly spaced fires with no escalation", () => {
    const burst = computeNagBurst({
      fireAt: FIRE_AT,
      nagIntervalSeconds: 120,
      maxNotifications: 3,
      now: NOW_BEFORE_FIRE,
    });

    expect(burst).toEqual([
      new Date("2026-06-20T09:00:00.000Z"),
      new Date("2026-06-20T09:02:00.000Z"),
      new Date("2026-06-20T09:04:00.000Z"),
    ]);
  });

  it("stops at nagMaxCount", () => {
    const burst = computeNagBurst({
      fireAt: FIRE_AT,
      nagIntervalSeconds: 3600,
      nagMaxCount: 6,
      maxNotifications: 20,
      now: NOW_BEFORE_FIRE,
    });

    expect(burst).toHaveLength(6);
  });

  it("stops at nagUntil", () => {
    const burst = computeNagBurst({
      fireAt: FIRE_AT,
      nagIntervalSeconds: 60,
      nagUntil: new Date("2026-06-20T09:02:30.000Z"),
      maxNotifications: 20,
      now: NOW_BEFORE_FIRE,
    });

    expect(burst).toEqual([
      new Date("2026-06-20T09:00:00.000Z"),
      new Date("2026-06-20T09:01:00.000Z"),
      new Date("2026-06-20T09:02:00.000Z"),
    ]);
  });

  it("never exceeds maxNotifications even with no other end condition", () => {
    const burst = computeNagBurst({
      fireAt: FIRE_AT,
      nagIntervalSeconds: 60,
      maxNotifications: MAX_BURST_PER_TASK,
      now: NOW_BEFORE_FIRE,
    });

    expect(burst).toHaveLength(MAX_BURST_PER_TASK);
  });

  it("shrinks the interval and floors it when escalationMode is shrink", () => {
    const burst = computeNagBurst({
      fireAt: FIRE_AT,
      nagIntervalSeconds: 120,
      escalationMode: "shrink",
      maxNotifications: 6,
      now: NOW_BEFORE_FIRE,
    });

    const gapsSeconds = burst
      .slice(1)
      .map((d, i) => (d.getTime() - burst[i].getTime()) / 1000);

    // strictly decreasing until it hits the floor
    for (let i = 1; i < gapsSeconds.length; i++) {
      expect(gapsSeconds[i]).toBeLessThanOrEqual(gapsSeconds[i - 1]);
    }
    for (const gap of gapsSeconds) {
      expect(gap).toBeGreaterThanOrEqual(SHRINK_FLOOR_SECONDS);
    }
  });

  it("fast-forwards through past occurrences without burning the per-call cap", () => {
    // First fire was 3 hours ago on an hourly nag with no max count: re-arming
    // "now" should pick up from the next future occurrence, not return empty.
    const burst = computeNagBurst({
      fireAt: new Date("2026-06-20T06:00:00.000Z"),
      nagIntervalSeconds: 3600,
      maxNotifications: 5,
      now: new Date("2026-06-20T09:15:00.000Z"),
    });

    expect(burst[0]).toEqual(new Date("2026-06-20T10:00:00.000Z"));
    expect(burst).toHaveLength(5);
  });

  it("returns nothing once nagMaxCount has been entirely used up in the past", () => {
    const burst = computeNagBurst({
      fireAt: new Date("2026-06-20T01:00:00.000Z"),
      nagIntervalSeconds: 3600,
      nagMaxCount: 4,
      maxNotifications: 20,
      now: NOW_BEFORE_FIRE,
    });

    expect(burst).toEqual([]);
  });

  it("rejects a non-positive interval", () => {
    expect(() =>
      computeNagBurst({ fireAt: FIRE_AT, nagIntervalSeconds: 0 })
    ).toThrow();
  });
});

describe("allocateNotificationBudget", () => {
  it("caps each task at perTaskCap", () => {
    const allocations = allocateNotificationBudget(
      [
        {
          id: "a",
          fireAt: FIRE_AT,
          nagIntervalSeconds: 1,
          priority: 0,
        },
      ],
      { perTaskCap: 5, globalBudget: 50, now: NOW_BEFORE_FIRE }
    );

    expect(allocations[0].fireTimes).toHaveLength(5);
  });

  it("prioritizes higher-priority and soonest tasks when the budget is tight", () => {
    const allocations = allocateNotificationBudget(
      [
        { id: "low", fireAt: FIRE_AT, nagIntervalSeconds: 60, priority: 0 },
        {
          id: "high",
          fireAt: new Date(FIRE_AT.getTime() + 3600_000),
          nagIntervalSeconds: 60,
          priority: 10,
        },
      ],
      { perTaskCap: 5, globalBudget: 6, now: NOW_BEFORE_FIRE }
    );

    const high = allocations.find((a) => a.taskId === "high")!;
    const low = allocations.find((a) => a.taskId === "low")!;
    expect(high.fireTimes).toHaveLength(5);
    expect(low.fireTimes).toHaveLength(1);
  });

  it("never allocates beyond the global budget across all tasks", () => {
    const tasks = Array.from({ length: 10 }, (_, i) => ({
      id: `task-${i}`,
      fireAt: new Date(FIRE_AT.getTime() + i * 1000),
      nagIntervalSeconds: 60,
      priority: 0,
    }));

    const allocations = allocateNotificationBudget(tasks, {
      now: NOW_BEFORE_FIRE,
    });
    const total = allocations.reduce((sum, a) => sum + a.fireTimes.length, 0);

    expect(total).toBeLessThanOrEqual(SAFE_GLOBAL_NOTIFICATION_BUDGET);
  });
});
