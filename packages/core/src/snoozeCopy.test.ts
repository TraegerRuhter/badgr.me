import { describe, expect, it, vi } from "vitest";
import { refreshNextOccurrenceCopy } from "./snoozeCopy";
import type { CopyGenerator } from "./copy";
import type { Task } from "./types";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Renew passport",
    notes: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
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
    snoozeCount: 1,
    ...overrides,
  };
}

function generatorReturning(body: string): CopyGenerator {
  return { generate: vi.fn().mockResolvedValue({ title: "Renew passport", body }) };
}

describe("refreshNextOccurrenceCopy", () => {
  it("overlays the generated line for the next occurrence when still naggable", async () => {
    const snoozed = makeTask();
    const schedule = vi.fn().mockResolvedValue(undefined);

    await refreshNextOccurrenceCopy(snoozed, {
      generator: generatorReturning("Fresh AI nag"),
      getTask: async () => snoozed,
      scheduleNextOccurrence: schedule,
    });

    expect(schedule).toHaveBeenCalledWith(
      snoozed.id,
      new Date(snoozed.fireAt),
      { title: "Renew passport", body: "Fresh AI nag" }
    );
  });

  it("does nothing when there is no generator (AI disabled)", async () => {
    const schedule = vi.fn();
    await refreshNextOccurrenceCopy(makeTask(), {
      generator: null,
      getTask: async () => makeTask(),
      scheduleNextOccurrence: schedule,
    });
    expect(schedule).not.toHaveBeenCalled();
  });

  it("does NOT resurrect a task completed during the generate() call", async () => {
    const snoozed = makeTask();
    const schedule = vi.fn();
    await refreshNextOccurrenceCopy(snoozed, {
      generator: generatorReturning("too late"),
      // by the time the line comes back, the user has completed the task
      getTask: async () => makeTask({ completedAt: "2026-01-01T00:05:00.000Z" }),
      scheduleNextOccurrence: schedule,
    });
    expect(schedule).not.toHaveBeenCalled();
  });

  it("does NOT overlay if the task was deleted meanwhile", async () => {
    const schedule = vi.fn();
    await refreshNextOccurrenceCopy(makeTask(), {
      generator: generatorReturning("x"),
      getTask: async () => makeTask({ deletedAt: "2026-01-01T00:05:00.000Z" }),
      scheduleNextOccurrence: schedule,
    });
    expect(schedule).not.toHaveBeenCalled();
  });

  it("does NOT overlay a stale line if the task was snoozed again meanwhile", async () => {
    const snoozed = makeTask({ snoozeCount: 1 });
    const schedule = vi.fn();
    await refreshNextOccurrenceCopy(snoozed, {
      generator: generatorReturning("stale"),
      // a newer snooze bumped the count past what this call was working from
      getTask: async () => makeTask({ snoozeCount: 2 }),
      scheduleNextOccurrence: schedule,
    });
    expect(schedule).not.toHaveBeenCalled();
  });

  it("uses the freshly-read fireAt, not the stale one passed in", async () => {
    const snoozed = makeTask({ fireAt: "2026-01-01T00:10:00.000Z" });
    const schedule = vi.fn().mockResolvedValue(undefined);
    await refreshNextOccurrenceCopy(snoozed, {
      generator: generatorReturning("ai"),
      getTask: async () => makeTask({ fireAt: "2026-01-01T00:30:00.000Z" }),
      scheduleNextOccurrence: schedule,
    });
    expect(schedule).toHaveBeenCalledWith(
      snoozed.id,
      new Date("2026-01-01T00:30:00.000Z"),
      expect.anything()
    );
  });
});
