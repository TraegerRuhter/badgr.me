import { describe, expect, it } from "vitest";

import { bucketForTask, groupTasksIntoSections } from "./sections";
import type { Task } from "./types";

// Fixed "now": a Wednesday afternoon, local time.
const NOW = new Date(2026, 6, 8, 13, 0, 0); // Jul 8 2026 13:00 local

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: crypto.randomUUID(),
    title: "t",
    notes: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    fireAt: NOW.toISOString(),
    nagIntervalSeconds: 60,
    nagMaxCount: 5,
    nagUntil: null,
    escalationMode: "none",
    completedAt: null,
    dismissedAt: null,
    repeatRule: null,
    priority: 0,
    deviceOrigin: "web",
    deletedAt: null,
    snoozeCount: 0,
    ...overrides,
  };
}

function at(y: number, m: number, d: number, h = 0, min = 0): string {
  return new Date(y, m, d, h, min).toISOString();
}

describe("bucketForTask", () => {
  it("puts overdue tasks in past — including earlier today", () => {
    expect(bucketForTask(makeTask({ fireAt: at(2026, 6, 8, 9) }), NOW)).toBe("past");
    expect(bucketForTask(makeTask({ fireAt: at(2026, 6, 1, 9) }), NOW)).toBe("past");
  });

  it("puts the rest of today in today, up to midnight", () => {
    expect(bucketForTask(makeTask({ fireAt: at(2026, 6, 8, 13, 1) }), NOW)).toBe("today");
    expect(bucketForTask(makeTask({ fireAt: at(2026, 6, 8, 23, 59) }), NOW)).toBe("today");
    expect(bucketForTask(makeTask({ fireAt: at(2026, 6, 9, 0, 0) }), NOW)).toBe("tomorrow");
  });

  it("gives tomorrow its own drawer, then days 2-7 to the week", () => {
    expect(bucketForTask(makeTask({ fireAt: at(2026, 6, 9, 23, 59) }), NOW)).toBe("tomorrow");
    expect(bucketForTask(makeTask({ fireAt: at(2026, 6, 10, 0, 0) }), NOW)).toBe("week");
    expect(bucketForTask(makeTask({ fireAt: at(2026, 6, 15, 23, 59) }), NOW)).toBe("week");
    expect(bucketForTask(makeTask({ fireAt: at(2026, 6, 16, 0, 0) }), NOW)).toBe("later");
  });

  it("puts completed tasks in done no matter when they fire", () => {
    const doneTask = makeTask({
      fireAt: at(2026, 6, 20),
      completedAt: NOW.toISOString(),
    });
    expect(bucketForTask(doneTask, NOW)).toBe("done");
  });

  it("treats an unparseable fireAt as past so it stays visible", () => {
    expect(bucketForTask(makeTask({ fireAt: "garbage" }), NOW)).toBe("past");
  });
});

describe("groupTasksIntoSections", () => {
  it("returns only non-empty sections in drawer order", () => {
    const sections = groupTasksIntoSections(
      [
        makeTask({ title: "later", fireAt: at(2026, 6, 25) }),
        makeTask({ title: "overdue", fireAt: at(2026, 6, 7) }),
        makeTask({ title: "tonight", fireAt: at(2026, 6, 8, 22) }),
      ],
      NOW
    );
    expect(sections.map((s) => s.bucket)).toEqual(["past", "today", "later"]);
    expect(sections.map((s) => s.tasks[0]?.title)).toEqual([
      "overdue",
      "tonight",
      "later",
    ]);
  });

  it("sorts done most-recently-completed first", () => {
    const sections = groupTasksIntoSections(
      [
        makeTask({ title: "old", completedAt: at(2026, 6, 1) }),
        makeTask({ title: "fresh", completedAt: at(2026, 6, 8, 12) }),
      ],
      NOW
    );
    expect(sections[0]?.bucket).toBe("done");
    expect(sections[0]?.tasks.map((t) => t.title)).toEqual(["fresh", "old"]);
  });
});
