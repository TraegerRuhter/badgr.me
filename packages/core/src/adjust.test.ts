import { describe, expect, it } from "vitest";

import { overdueAgeLabel, shiftFireAt } from "./adjust";

const NOW = new Date("2026-07-08T13:00:00.000Z");

describe("shiftFireAt", () => {
  it("extends a future fire time from itself", () => {
    const fireAt = "2026-07-08T15:00:00.000Z";
    expect(shiftFireAt({ fireAt }, 3600, NOW)).toBe("2026-07-08T16:00:00.000Z");
  });

  it("bases a positive shift on now for an overdue task", () => {
    const fireAt = "2026-07-04T09:00:00.000Z"; // 4 days late
    expect(shiftFireAt({ fireAt }, 3600, NOW)).toBe("2026-07-08T14:00:00.000Z");
  });

  it("pulls a future fire time earlier", () => {
    const fireAt = "2026-07-08T15:00:00.000Z";
    expect(shiftFireAt({ fireAt }, -1800, NOW)).toBe("2026-07-08T14:30:00.000Z");
  });

  it("clamps a negative shift at now instead of scheduling into the past", () => {
    const fireAt = "2026-07-08T13:10:00.000Z"; // 10m out, minus 1h
    expect(shiftFireAt({ fireAt }, -3600, NOW)).toBe(NOW.toISOString());
  });

  it("treats an unparseable fireAt as now", () => {
    expect(shiftFireAt({ fireAt: "garbage" }, 300, NOW)).toBe(
      "2026-07-08T13:05:00.000Z"
    );
  });
});

describe("overdueAgeLabel", () => {
  it("is empty for future or unparseable times", () => {
    expect(overdueAgeLabel("2026-07-08T14:00:00.000Z", NOW)).toBe("");
    expect(overdueAgeLabel("garbage", NOW)).toBe("");
  });

  it("formats minutes, hours, then days", () => {
    expect(overdueAgeLabel("2026-07-08T12:35:00.000Z", NOW)).toBe("(25m)");
    expect(overdueAgeLabel("2026-07-08T08:00:00.000Z", NOW)).toBe("(5h)");
    expect(overdueAgeLabel("2026-07-04T09:00:00.000Z", NOW)).toBe("(4d)");
  });
});
