import { describe, expect, it } from "vitest";
import { generateTemplateCopy, templateCopyGenerator } from "./copy";
import type { Task } from "./types";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Schedule eye appointment",
    notes: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    fireAt: "2026-01-01T00:00:00.000Z",
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

describe("generateTemplateCopy", () => {
  it("never touches the task title", () => {
    const task = makeTask();
    for (const level of [0, 1, 3, 5, 8, 20]) {
      expect(generateTemplateCopy(task, level).title).toBe(task.title);
    }
  });

  it("always shows user notes verbatim, regardless of escalation level", () => {
    const task = makeTask({ notes: "bring the insurance card" });
    for (const level of [0, 4, 9]) {
      expect(generateTemplateCopy(task, level).body).toBe(
        "bring the insurance card"
      );
    }
  });

  it("uses the neutral fallback line at level 0", () => {
    const task = makeTask();
    expect(generateTemplateCopy(task, 0).body).toBe(
      "Still on your list — tap to deal with it."
    );
  });

  it("escalates to a harsher tier as the level climbs", () => {
    const task = makeTask();
    const seen = new Set<string>();
    for (const level of [0, 1, 3, 5, 8]) {
      seen.add(generateTemplateCopy(task, level).body);
    }
    // each escalation boundary should introduce a new line, not repeat tier 0
    expect(seen.size).toBe(5);
  });

  it("caps out at the harshest tier instead of throwing for very high levels", () => {
    const task = makeTask();
    expect(() => generateTemplateCopy(task, 1000)).not.toThrow();
    expect(generateTemplateCopy(task, 1000).body.length).toBeGreaterThan(0);
  });

  it("is deterministic for a given task and level", () => {
    const task = makeTask();
    expect(generateTemplateCopy(task, 6)).toEqual(generateTemplateCopy(task, 6));
  });
});

describe("templateCopyGenerator", () => {
  it("wraps generateTemplateCopy as an async CopyGenerator", async () => {
    const task = makeTask();
    const result = await templateCopyGenerator.generate({ task, level: 3 });
    expect(result).toEqual(generateTemplateCopy(task, 3));
  });
});
