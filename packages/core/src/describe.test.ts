import { describe, expect, it } from "vitest";
import { computeNagBurst } from "./nag";
import {
  describeFireTimes,
  describeNagPlan,
  describeNagPreset,
  describeRelativeFireTime,
  formatDuration,
  formatInterval,
  isPastDue,
  describeLeadTime,
  LEAD_TIME_CHOICES,
  matchNagPreset,
  NAG_PRESETS,
  quickChipLabel,
} from "./describe";

const NOW = new Date("2026-08-03T09:00:00.000Z");

describe("formatDuration — the single rule (plan §9.2)", () => {
  it("uses seconds below a minute", () => {
    expect(formatDuration(0)).toBe("0 sec");
    expect(formatDuration(59)).toBe("59 sec");
  });

  it("switches to minutes at exactly 60 seconds", () => {
    expect(formatDuration(60)).toBe("1 min");
    expect(formatDuration(61)).toBe("1 min");
  });

  it("holds minutes right up to the hour boundary", () => {
    expect(formatDuration(59 * 60)).toBe("59 min");
  });

  it("switches to hours at exactly 60 minutes", () => {
    expect(formatDuration(60 * 60)).toBe("1 hr");
  });

  it("renders 90 minutes as hours — the case Due contradicts itself on", () => {
    // Due's preset subtitle says "90 min"; its custom subtitle would say
    // "1 hr, 30 min". We render one way everywhere.
    expect(formatDuration(90 * 60)).toBe("1 hr, 30 min");
  });

  it("drops the minutes component on exact hours", () => {
    expect(formatDuration(180 * 60)).toBe("3 hr");
    expect(formatDuration(360 * 60)).toBe("6 hr");
  });

  it("matches Due's custom-subtitle examples", () => {
    expect(formatDuration(9 * 60)).toBe("9 min");
    expect(formatDuration(220 * 60)).toBe("3 hr, 40 min");
    expect(formatDuration(240 * 60)).toBe("4 hr");
  });

  it("switches to days at 24 hours and drops a zero remainder", () => {
    expect(formatDuration(23 * 3600)).toBe("23 hr");
    expect(formatDuration(24 * 3600)).toBe("1 day");
    expect(formatDuration(25 * 3600)).toBe("1 day, 1 hr");
    expect(formatDuration(48 * 3600)).toBe("2 days");
  });

  it("never prints a 24-hour remainder", () => {
    // 47h50m rounds to 48h; must roll into "2 days", not "1 day, 24 hr".
    expect(formatDuration(47.9 * 3600)).toBe("2 days");
  });

  it("clamps negatives rather than printing a sign", () => {
    expect(formatDuration(-5)).toBe("0 sec");
  });
});

describe("formatInterval", () => {
  it("prefixes the duration", () => {
    expect(formatInterval(1200)).toBe("Every 20 min");
    expect(formatInterval(3600)).toBe("Every 1 hr");
  });
});

describe("describeNagPlan", () => {
  it("spans first fire to last, not one interval too many", () => {
    // 12 fires at 20-minute spacing span 11 intervals = 3h40m.
    // Due prints "(4 hr)" here, which counts a trailing interval that
    // never elapses. We print the true span.
    expect(describeNagPlan({ intervalSeconds: 1200, maxCount: 12 })).toBe(
      "Every 20 min, 12 times (3 hr, 40 min)"
    );
  });

  it("handles the other observed custom values", () => {
    expect(describeNagPlan({ intervalSeconds: 180, maxCount: 3 })).toBe(
      "Every 3 min, 3 times (6 min)"
    );
    expect(describeNagPlan({ intervalSeconds: 1200, maxCount: 3 })).toBe(
      "Every 20 min, 3 times (40 min)"
    );
  });

  it("says 'until done' when there is no ceiling", () => {
    expect(describeNagPlan({ intervalSeconds: 60, maxCount: null })).toBe(
      "Every 1 min, until done"
    );
  });

  it("collapses a single fire to plain language", () => {
    expect(describeNagPlan({ intervalSeconds: 300, maxCount: 1 })).toBe("Once, no repeat");
  });

  it("omits the total when shrink makes it interval-dependent (U2)", () => {
    expect(
      describeNagPlan({ intervalSeconds: 1200, maxCount: 6, escalationMode: "shrink" })
    ).toBe("Every 20 min, 6 times, tightening");
  });

  it("rejects a non-positive interval rather than dividing by zero downstream", () => {
    expect(() => describeNagPlan({ intervalSeconds: 0, maxCount: 3 })).toThrow(/positive/);
  });
});

describe("nag presets (plan §3.3, §9.1)", () => {
  it("every preset produces a subtitle", () => {
    for (const preset of NAG_PRESETS) {
      expect(describeNagPreset(preset).length).toBeGreaterThan(0);
    }
  });

  it("renders the counted presets with their true span", () => {
    const byId = Object.fromEntries(NAG_PRESETS.map((p) => [p.id, describeNagPreset(p)]));
    expect(byId["5m"]).toBe("6 times (25 min), or until marked done");
    expect(byId["15m"]).toBe("6 times (1 hr, 15 min), or until marked done");
    expect(byId["30m"]).toBe("6 times (2 hr, 30 min), or until marked done");
    expect(byId["1h"]).toBe("6 times (5 hr), or until marked done");
  });

  it("describes the uncapped presets without a span", () => {
    const byId = Object.fromEntries(NAG_PRESETS.map((p) => [p.id, describeNagPreset(p)]));
    expect(byId["relentless"]).toBe("Repeats until marked done");
    expect(byId["1d"]).toBe("Repeats until marked done");
  });

  it("'Just once' is badgr's nag-off: it still alerts (§9.1)", () => {
    const once = NAG_PRESETS.find((p) => p.id === "once");
    expect(once?.maxCount).toBe(1);
    expect(describeNagPreset(once!)).toMatch(/once/i);
  });

  it("presets need no schema change — they are plain field pairs (§4)", () => {
    for (const preset of NAG_PRESETS) {
      expect(typeof preset.intervalSeconds).toBe("number");
      expect(preset.maxCount === null || typeof preset.maxCount === "number").toBe(true);
    }
  });

  it("round-trips a task's fields back to its preset", () => {
    expect(matchNagPreset(900, 6)?.id).toBe("15m");
    expect(matchNagPreset(1200, 12)).toBeNull();
  });
});

describe("describeFireTimes — U2 enforcement", () => {
  it("enumerates real planner output", () => {
    const burst = computeNagBurst({
      fireAt: new Date("2026-08-03T09:00:00.000Z"),
      nagIntervalSeconds: 3600,
      nagMaxCount: 3,
      now: NOW,
    });
    // Rendered in local time, so assert shape rather than a fixed wall clock.
    expect(describeFireTimes(burst)).toMatch(/^Will fire at \d\d:\d\d, \d\d:\d\d, \d\d:\d\d$/);
  });

  it("agrees with the planner on how many fires there are", () => {
    const burst = computeNagBurst({
      fireAt: NOW,
      nagIntervalSeconds: 1200,
      nagMaxCount: 12,
      now: NOW,
    });
    const described = describeFireTimes(burst, { max: 3 });
    expect(burst).toHaveLength(12);
    expect(described).toMatch(/and 9 more$/);
  });

  it("reflects a burst the planner truncated, rather than the requested count", () => {
    // nagUntil cuts the burst short; the label must follow the planner, not
    // the config. This is the drift U2 exists to prevent.
    const burst = computeNagBurst({
      fireAt: NOW,
      nagIntervalSeconds: 3600,
      nagMaxCount: 10,
      nagUntil: new Date("2026-08-03T11:00:00.000Z"),
      now: NOW,
    });
    expect(burst).toHaveLength(3);
    expect(describeFireTimes(burst, { max: 10 })).not.toMatch(/more/);
  });

  it("says so when nothing is scheduled", () => {
    expect(describeFireTimes([])).toBe("Won't fire");
  });

  it("does not say 'and 0 more' at the boundary", () => {
    const burst = computeNagBurst({
      fireAt: NOW,
      nagIntervalSeconds: 600,
      nagMaxCount: 3,
      now: NOW,
    });
    expect(describeFireTimes(burst, { max: 3 })).not.toMatch(/more/);
  });
});

describe("past-due state (plan §3.5)", () => {
  it("is false for the future and for undated tasks", () => {
    expect(isPastDue(new Date(NOW.getTime() + 1000), NOW)).toBe(false);
    expect(isPastDue(null, NOW)).toBe(false);
  });

  it("is true one second into the past", () => {
    expect(isPastDue(new Date(NOW.getTime() - 1000), NOW)).toBe(true);
  });

  it("accepts ISO strings and shrugs off garbage", () => {
    expect(isPastDue("2026-08-03T08:00:00.000Z", NOW)).toBe(true);
    expect(isPastDue("not a date", NOW)).toBe(false);
  });

  it("flips the quick chip from Today to Now", () => {
    expect(quickChipLabel(new Date(NOW.getTime() + 3600_000), NOW)).toBe("Today");
    expect(quickChipLabel(new Date(NOW.getTime() - 1000), NOW)).toBe("Now");
  });
});

describe("describeRelativeFireTime", () => {
  it("reads forward and backward", () => {
    expect(describeRelativeFireTime(new Date(NOW.getTime() + 7200_000), NOW)).toBe("in 2 hr");
    expect(describeRelativeFireTime(new Date(NOW.getTime() - 13200_000), NOW)).toBe(
      "3 hr, 40 min ago"
    );
  });

  it("avoids a ticking seconds countdown inside a form", () => {
    expect(describeRelativeFireTime(new Date(NOW.getTime() + 30_000), NOW)).toBe(
      "in under a minute"
    );
    expect(describeRelativeFireTime(new Date(NOW.getTime() - 30_000), NOW)).toBe("just now");
  });

  it("returns empty for an unparseable input rather than throwing", () => {
    expect(describeRelativeFireTime("nonsense", NOW)).toBe("");
  });
});

describe("lead time (plan §3.6)", () => {
  it("offers Off first, because a pre-alarm costs a notification slot", () => {
    expect(LEAD_TIME_CHOICES[0].seconds).toBeNull();
    expect(LEAD_TIME_CHOICES[0].label).toBe("Off");
  });

  it("describes the chosen lead time in plain language", () => {
    expect(describeLeadTime(null)).toBe("No heads-up before it's due");
    expect(describeLeadTime(900)).toBe("Heads-up 15 min before");
    expect(describeLeadTime(3600)).toBe("Heads-up 1 hr before");
    expect(describeLeadTime(86400)).toBe("Heads-up 1 day before");
  });

  it("treats a non-positive lead time as off", () => {
    expect(describeLeadTime(0)).toBe("No heads-up before it's due");
  });

  it("labels every choice consistently with formatDuration", () => {
    for (const choice of LEAD_TIME_CHOICES) {
      if (choice.seconds == null) continue;
      expect(choice.label).toBe(formatDuration(choice.seconds));
    }
  });
});
