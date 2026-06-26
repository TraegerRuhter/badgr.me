import { describe, expect, it } from "vitest";
import { applySnooze, DEFAULT_SNOOZE_SECONDS } from "./snooze";

const NOW = new Date("2026-06-20T09:00:00.000Z");

describe("applySnooze", () => {
  it("pushes fireAt out by the default snooze delay and bumps snoozeCount", () => {
    const result = applySnooze({ snoozeCount: 0 }, { now: NOW });
    expect(result.fireAt).toEqual(
      new Date(NOW.getTime() + DEFAULT_SNOOZE_SECONDS * 1000)
    );
    expect(result.snoozeCount).toBe(1);
  });

  it("honors a custom snooze delay", () => {
    const result = applySnooze(
      { snoozeCount: 2 },
      { snoozeSeconds: 60, now: NOW }
    );
    expect(result.fireAt).toEqual(new Date("2026-06-20T09:01:00.000Z"));
    expect(result.snoozeCount).toBe(3);
  });

  it("accumulates across repeated snoozes", () => {
    let state = { snoozeCount: 0 };
    for (let i = 0; i < 5; i++) {
      const result = applySnooze(state, { snoozeSeconds: 30, now: NOW });
      state = { snoozeCount: result.snoozeCount };
    }
    expect(state.snoozeCount).toBe(5);
  });

  it("rejects a non-positive delay", () => {
    expect(() =>
      applySnooze({ snoozeCount: 0 }, { snoozeSeconds: 0 })
    ).toThrow();
  });
});
