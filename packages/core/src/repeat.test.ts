import { describe, expect, it } from "vitest";

import { isRepeatRule, nextRepeatFireAt } from "./repeat";

describe("nextRepeatFireAt", () => {
  it("advances daily and weekly by exactly one period, preserving time-of-day", () => {
    const daily = nextRepeatFireAt("2026-07-08T14:30:00.000Z", "daily");
    expect(daily).toBe("2026-07-09T14:30:00.000Z");
    const weekly = nextRepeatFireAt("2026-07-08T14:30:00.000Z", "weekly");
    expect(weekly).toBe("2026-07-15T14:30:00.000Z");
  });

  it("advances monthly across a normal month boundary", () => {
    const next = nextRepeatFireAt("2026-07-08T09:00:00.000Z", "monthly");
    expect(next).toBe("2026-08-08T09:00:00.000Z");
  });

  it("clamps monthly instead of overflowing into the next month", () => {
    // Jan 31 + 1 month must land on Feb 28 (2026 is not a leap year), not Mar 3.
    const next = nextRepeatFireAt("2026-01-31T09:00:00.000Z", "monthly");
    expect(next).toBe("2026-02-28T09:00:00.000Z");
  });

  it("clamps yearly Feb 29 to Feb 28 in a non-leap target year", () => {
    // 2028 is a leap year; 2029 is not.
    const next = nextRepeatFireAt("2028-02-29T09:00:00.000Z", "yearly");
    expect(next).toBe("2029-02-28T09:00:00.000Z");
  });

  it("advances exactly one period even when the result is still in the past", () => {
    // No catch-up loop — one period forward, full stop.
    const oldFireAt = "2020-01-01T09:00:00.000Z";
    expect(nextRepeatFireAt(oldFireAt, "daily")).toBe("2020-01-02T09:00:00.000Z");
  });

  it("throws on an unparseable fireAt", () => {
    expect(() => nextRepeatFireAt("garbage", "daily")).toThrow();
  });
});

describe("isRepeatRule", () => {
  it("accepts the four known rules and rejects everything else", () => {
    expect(isRepeatRule("daily")).toBe(true);
    expect(isRepeatRule("weekly")).toBe(true);
    expect(isRepeatRule("monthly")).toBe(true);
    expect(isRepeatRule("yearly")).toBe(true);
    expect(isRepeatRule("hourly")).toBe(false);
    expect(isRepeatRule(null)).toBe(false);
    expect(isRepeatRule(42)).toBe(false);
  });
});
