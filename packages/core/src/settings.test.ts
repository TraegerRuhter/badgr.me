import { describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  planOptionsFrom,
  SETTING_LIMITS,
  swipeActionFor,
  toneLevelOffset,
} from "./settings";

describe("normalizeSettings", () => {
  it("returns defaults for garbage input", () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings("nope")).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(42)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps a fully valid stored blob", () => {
    const stored = {
      gestures: { swipeEnabled: false, swapDirections: true },
      nag: { snoozeMinutes: 25, maxPerTask: 3, globalBudget: 24 },
      copy: { tone: "savage", pack: "drill", aiRewrites: false },
      sync: { paused: true },
    };
    expect(normalizeSettings(stored)).toEqual(stored);
  });

  it("backfills pack for a blob predating personality packs, and rejects an unknown pack", () => {
    const legacy = normalizeSettings({
      copy: { tone: "standard", aiRewrites: true },
    });
    expect(legacy.copy.pack).toBe(DEFAULT_SETTINGS.copy.pack);
    const bogus = normalizeSettings({
      copy: { tone: "standard", pack: "villain", aiRewrites: true },
    });
    expect(bogus.copy.pack).toBe(DEFAULT_SETTINGS.copy.pack);
  });

  it("backfills groups an older blob doesn't have", () => {
    const legacy = { gestures: { swipeEnabled: false, swapDirections: false } };
    const result = normalizeSettings(legacy);
    expect(result.gestures.swipeEnabled).toBe(false);
    expect(result.nag).toEqual(DEFAULT_SETTINGS.nag);
    expect(result.copy).toEqual(DEFAULT_SETTINGS.copy);
    expect(result.sync).toEqual(DEFAULT_SETTINGS.sync);
  });

  it("clamps numeric knobs into their documented ranges", () => {
    const result = normalizeSettings({
      nag: { snoozeMinutes: 0, maxPerTask: 999, globalBudget: -5 },
    });
    expect(result.nag.snoozeMinutes).toBe(SETTING_LIMITS.snoozeMinutes.min);
    expect(result.nag.maxPerTask).toBe(SETTING_LIMITS.maxPerTask.max);
    expect(result.nag.globalBudget).toBe(SETTING_LIMITS.globalBudget.min);
  });

  it("rounds fractional numbers and rejects non-numeric ones", () => {
    const result = normalizeSettings({
      nag: { snoozeMinutes: 7.6, maxPerTask: "many", globalBudget: NaN },
    });
    expect(result.nag.snoozeMinutes).toBe(8);
    expect(result.nag.maxPerTask).toBe(DEFAULT_SETTINGS.nag.maxPerTask);
    expect(result.nag.globalBudget).toBe(DEFAULT_SETTINGS.nag.globalBudget);
  });

  it("rejects an unknown tone", () => {
    const result = normalizeSettings({ copy: { tone: "furious" } });
    expect(result.copy.tone).toBe(DEFAULT_SETTINGS.copy.tone);
  });
});

describe("swipeActionFor", () => {
  it("maps right=complete, left=snooze by default", () => {
    expect(swipeActionFor(DEFAULT_SETTINGS, "right")).toBe("complete");
    expect(swipeActionFor(DEFAULT_SETTINGS, "left")).toBe("snooze");
  });

  it("swaps both directions when configured", () => {
    const swapped = normalizeSettings({
      gestures: { swipeEnabled: true, swapDirections: true },
    });
    expect(swipeActionFor(swapped, "right")).toBe("snooze");
    expect(swipeActionFor(swapped, "left")).toBe("complete");
  });
});

describe("toneLevelOffset", () => {
  it("lags for gentle, holds for standard, jumps for savage", () => {
    expect(toneLevelOffset("gentle")).toBeLessThan(0);
    expect(toneLevelOffset("standard")).toBe(0);
    expect(toneLevelOffset("savage")).toBeGreaterThan(0);
  });
});

describe("planOptionsFrom", () => {
  it("maps the nag knobs, tone, and pack onto planner options", () => {
    const settings = normalizeSettings({
      nag: { snoozeMinutes: 5, maxPerTask: 4, globalBudget: 32 },
      copy: { tone: "savage", pack: "corporate", aiRewrites: true },
    });
    expect(planOptionsFrom(settings)).toEqual({
      globalBudget: 32,
      perTaskCap: 4,
      copyLevelOffset: toneLevelOffset("savage"),
      copyPack: "corporate",
    });
  });
});
