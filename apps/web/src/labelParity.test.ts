import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  describeNagPlan,
  describeNagPreset,
  describeRoundsPlan,
  matchNagPreset,
  NAG_PRESETS,
  type Task,
} from "@alarmed/core";

/**
 * Invariant U7 (docs/plans/due-parity-build-plan.md §2): web and mobile render
 * the same string from the same core function.
 *
 * Two halves, because neither alone is enough:
 *
 *  1. Pin the strings, so a change to the wording is a deliberate diff rather
 *     than a silent drift.
 *  2. Assert neither app has grown its own copy of the formatting. This is the
 *     failure mode that actually happens — someone needs a label in a hurry,
 *     writes `${mins}m` inline, and the two clients quietly diverge. A string
 *     test would never catch it, because both would still pass their own
 *     assertions.
 */

const WEB_APP = resolve(__dirname, "App.tsx");
const MOBILE_APP = resolve(__dirname, "../../mobile/App.tsx");

const read = (path: string) => readFileSync(path, "utf8");

function taskFixture(overrides: Partial<Task> = {}): Task {
  return {
    id: "fixture",
    title: "Take shot",
    notes: null,
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-08-01T09:00:00.000Z",
    fireAt: "2026-08-03T09:00:00.000Z",
    nagIntervalSeconds: 900,
    nagMaxCount: 6,
    nagUntil: null,
    escalationMode: "none",
    completedAt: null,
    dismissedAt: null,
    repeatRule: null,
    priority: 0,
    deviceOrigin: "web",
    deletedAt: null,
    snoozeCount: 0,
    leadTimeSeconds: null,
    roundsIntervalSeconds: null,
    roundsMaxCount: null,
    roundsDurationSeconds: null,
    ...overrides,
  };
}

describe("U7 — shared label source", () => {
  it("both clients import the derived-label functions from core", () => {
    for (const [name, source] of [
      ["web", read(WEB_APP)],
      ["mobile", read(MOBILE_APP)],
    ] as const) {
      expect(source, `${name} should use the shared preset list`).toContain("NAG_PRESETS");
      expect(source, `${name} should use the shared preset subtitle`).toContain(
        "describeNagPreset"
      );
      expect(source, `${name} should use the shared plan summary`).toContain(
        "describeNagPlan"
      );
      expect(source, `${name} should use the shared fire-time preview`).toContain(
        "describeFireTimes"
      );
      expect(source, `${name} should use the shared Rounds summary`).toContain(
        "describeRoundsPlan"
      );
      expect(source, `${name} should use the shared Rounds schedule-only note`).toContain(
        "ROUNDS_SCHEDULE_NOTE"
      );
    }
  });

  it("neither client re-implements duration formatting", () => {
    // `formatInterval` survives in both apps for the interval chips, which is
    // fine — it is imported from core. What must not appear is a *local*
    // definition of the nag-label formatters.
    const forbidden = [
      /function\s+describeNagPlan/,
      /function\s+describeNagPreset/,
      /function\s+formatDuration/,
      /function\s+describeRoundsPlan/,
      /function\s+computeRoundsBurst/,
    ];
    for (const [name, source] of [
      ["web", read(WEB_APP)],
      ["mobile", read(MOBILE_APP)],
    ] as const) {
      for (const pattern of forbidden) {
        expect(pattern.test(source), `${name} defines its own ${pattern}`).toBe(false);
      }
    }
  });

  it("the fire-time preview is fed from the real planner, not a config", () => {
    // U2's enforcement at the call site: both apps must run computeNagBurst
    // before describing it. If someone adds a config-taking overload, this
    // catches the first caller that uses it.
    for (const [name, source] of [
      ["web", read(WEB_APP)],
      ["mobile", read(MOBILE_APP)],
    ] as const) {
      expect(source, `${name} must compute a real burst`).toContain("computeNagBurst");
      expect(source, `${name} must compute a real Rounds burst`).toContain(
        "computeRoundsBurst"
      );
    }
  });
});

describe("U7 — pinned strings", () => {
  it("renders the card summary identically for a fixture task", () => {
    const task = taskFixture();
    const summary = describeNagPlan({
      intervalSeconds: task.nagIntervalSeconds,
      maxCount: task.nagMaxCount,
      escalationMode: task.escalationMode,
    });
    expect(summary).toBe("Every 15 min, 6 times (1 hr, 15 min)");
  });

  it("renders every preset subtitle to a stable string", () => {
    expect(NAG_PRESETS.map((p) => `${p.label} — ${describeNagPreset(p)}`)).toEqual([
      "Just once — Alerts once and then leaves you alone",
      "Every minute — Repeats until marked done",
      "Every 5 minutes — 6 times (25 min), or until marked done",
      "Every 15 minutes — 6 times (1 hr, 15 min), or until marked done",
      "Every 30 minutes — 6 times (2 hr, 30 min), or until marked done",
      "Every hour — 6 times (5 hr), or until marked done",
      "Every day — Repeats until marked done",
    ]);
  });

  it("opens an off-preset task in Custom rather than snapping its schedule", () => {
    // The bug this guards: a task saved at 20-minute spacing silently becoming
    // a 15-minute task because the editor picked the nearest preset.
    expect(matchNagPreset(1200, 12)).toBeNull();
    expect(matchNagPreset(900, 6)?.id).toBe("15m");
  });

  it("describes badgr's nag-off as still alerting once (§9.1)", () => {
    const once = NAG_PRESETS.find((p) => p.id === "once")!;
    expect(once.maxCount).toBe(1);
    expect(describeNagPlan({ intervalSeconds: once.intervalSeconds, maxCount: 1 })).toBe(
      "Once, no repeat"
    );
  });

  it("renders the Rounds row summary identically for a fixture task (plan §3.4, §9.3.1)", () => {
    const task = taskFixture({ roundsIntervalSeconds: 3600, roundsMaxCount: 2 });
    const summary = describeRoundsPlan({
      intervalSeconds: task.roundsIntervalSeconds,
      maxCount: task.roundsMaxCount,
      durationSeconds: task.roundsDurationSeconds,
    });
    expect(summary).toBe("Every 1 hr, 2 times");
  });
});
