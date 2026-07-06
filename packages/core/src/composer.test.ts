import { describe, expect, it } from "vitest";

import { quickFireAt } from "./composer";

describe("quickFireAt", () => {
  it("'now' fires seconds out, 'hour' exactly an hour out", () => {
    const now = new Date(2026, 6, 8, 13, 0, 0);
    expect(quickFireAt("now", now).getTime() - now.getTime()).toBe(10_000);
    expect(quickFireAt("hour", now).getTime() - now.getTime()).toBe(3600_000);
  });

  it("'tonight' is 21:00 today during the day", () => {
    const now = new Date(2026, 6, 8, 13, 0, 0);
    const tonight = quickFireAt("tonight", now);
    expect(tonight.getDate()).toBe(8);
    expect(tonight.getHours()).toBe(21);
  });

  it("'tonight' rolls to tomorrow night when 21:00 is under 30m away", () => {
    const now = new Date(2026, 6, 8, 20, 45, 0);
    const tonight = quickFireAt("tonight", now);
    expect(tonight.getDate()).toBe(9);
    expect(tonight.getHours()).toBe(21);
  });

  it("'tomorrow' is 09:00 the next day, even late at night", () => {
    const now = new Date(2026, 6, 8, 23, 30, 0);
    const morning = quickFireAt("tomorrow", now);
    expect(morning.getDate()).toBe(9);
    expect(morning.getHours()).toBe(9);
  });
});
