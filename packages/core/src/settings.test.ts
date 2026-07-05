import { describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  swipeActionFor,
} from "./settings";

describe("normalizeSettings", () => {
  it("returns defaults for garbage input", () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings("nope")).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(42)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps valid stored values", () => {
    const stored = { gestures: { swipeEnabled: false, swapDirections: true } };
    expect(normalizeSettings(stored)).toEqual(stored);
  });

  it("repairs individual corrupt fields without dropping the rest", () => {
    const result = normalizeSettings({
      gestures: { swipeEnabled: "yes", swapDirections: true },
    });
    expect(result.gestures.swipeEnabled).toBe(
      DEFAULT_SETTINGS.gestures.swipeEnabled
    );
    expect(result.gestures.swapDirections).toBe(true);
  });
});

describe("swipeActionFor", () => {
  it("maps right=complete, left=snooze by default", () => {
    expect(swipeActionFor(DEFAULT_SETTINGS, "right")).toBe("complete");
    expect(swipeActionFor(DEFAULT_SETTINGS, "left")).toBe("snooze");
  });

  it("swaps both directions when configured", () => {
    const swapped = {
      gestures: { swipeEnabled: true, swapDirections: true },
    };
    expect(swipeActionFor(swapped, "right")).toBe("snooze");
    expect(swipeActionFor(swapped, "left")).toBe("complete");
  });
});
