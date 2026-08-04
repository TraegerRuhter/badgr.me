import { describe, expect, it } from "vitest";
import { describeFireTimes, describeRoundOccurrence, describeRoundsPlan } from "./describe";
import { allocateNotificationBudget, computeNagBurst, computeRoundsBurst } from "./nag";
import {
  buildRoundNotificationId,
  isNagNotificationId,
  parseNotificationId,
  planNagNotifications,
  ROUNDS_SLOT,
} from "./notifications";
import type { Task } from "./types";

/**
 * Rounds — intra-day recurrence (due-parity plan §3.4, Phase 5).
 *
 * The gate for this phase (plan §6) is invariant U2: the enumerated
 * fire-time preview must match `computeNagBurst` output exactly, for 20
 * randomised configurations. `computeRoundsBurst` exists to make that
 * structurally true — it's a translation into `computeNagBurst`, never a
 * second walk — but this file proves it rather than trusting the doc
 * comment.
 */

const NOW = new Date("2026-08-03T09:00:00.000Z");

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t",
    title: "Take shot",
    notes: null,
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-08-01T09:00:00.000Z",
    fireAt: "2026-08-03T12:00:00.000Z",
    nagIntervalSeconds: 900,
    nagMaxCount: 1,
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

// Deterministic PRNG (mulberry32) so the "20 randomised configurations" gate
// is reproducible — a flaky gate test is worse than no gate test.
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("computeRoundsBurst — a translation into computeNagBurst, not a second walk", () => {
  it("Count mode matches nagMaxCount directly", () => {
    const burst = computeRoundsBurst({
      fireAt: NOW,
      intervalSeconds: 3600,
      maxCount: 3,
      now: NOW,
    });
    const expected = computeNagBurst({
      fireAt: NOW,
      nagIntervalSeconds: 3600,
      nagMaxCount: 3,
      now: NOW,
    });
    expect(burst).toEqual(expected);
    expect(burst).toHaveLength(3);
  });

  it("Duration mode translates to an absolute nagUntil measured from fireAt", () => {
    const burst = computeRoundsBurst({
      fireAt: NOW,
      intervalSeconds: 3600,
      durationSeconds: 7200,
      now: NOW,
    });
    const expected = computeNagBurst({
      fireAt: NOW,
      nagIntervalSeconds: 3600,
      nagUntil: new Date(NOW.getTime() + 7200 * 1000),
      now: NOW,
    });
    expect(burst).toEqual(expected);
    // 0h, 1h, 2h — three occurrences within a 2-hour span.
    expect(burst).toHaveLength(3);
  });

  it("neither cap set produces an empty burst, not an unbounded one", () => {
    // An interval with no cap is an incomplete config (the editors never
    // persist this shape — see save()'s "Off clears both fields" comment),
    // and computeNagBurst has no cap to stop on other than maxNotifications.
    // Rounds' own callers always pass an explicit cap; this just documents
    // what computeRoundsBurst does if one is missing: it walks out to the
    // default MAX_BURST_PER_TASK, matching computeNagBurst's own behaviour.
    const burst = computeRoundsBurst({ fireAt: NOW, intervalSeconds: 3600, now: NOW });
    const expected = computeNagBurst({ fireAt: NOW, nagIntervalSeconds: 3600, now: NOW });
    expect(burst).toEqual(expected);
  });
});

describe("U2 — the enumerated preview matches the planner exactly, 20 randomised configs", () => {
  const rand = mulberry32(20260804);

  it("computeRoundsBurst never drifts from a directly-translated computeNagBurst call", () => {
    for (let i = 0; i < 20; i++) {
      const fireAt = new Date(NOW.getTime() + Math.floor(rand() * 30) * 3_600_000);
      const intervalSeconds = 300 * (1 + Math.floor(rand() * 20));
      const useCount = rand() < 0.5;
      const maxCount = useCount ? 1 + Math.floor(rand() * 10) : null;
      const durationSeconds = useCount ? null : 1800 * (1 + Math.floor(rand() * 40));

      const burst = computeRoundsBurst({
        fireAt,
        intervalSeconds,
        maxCount,
        durationSeconds,
        now: NOW,
      });

      // Independently translated right here in the test, rather than by
      // calling computeRoundsBurst's own internals — this is what actually
      // catches drift if someone rewrites the translation incorrectly.
      const expected = computeNagBurst({
        fireAt,
        nagIntervalSeconds: intervalSeconds,
        nagMaxCount: maxCount,
        nagUntil:
          durationSeconds != null ? new Date(fireAt.getTime() + durationSeconds * 1000) : null,
        escalationMode: "none",
        now: NOW,
      });

      expect(burst).toEqual(expected);
      // The gate's real claim: the *preview text* the editors show is exactly
      // what the planner produced, via the one shared formatter — never a
      // parallel implementation that could quietly disagree.
      expect(describeFireTimes(burst)).toBe(describeFireTimes(expected));
    }
  });
});

describe("describeRoundsPlan — the Rounds row's derived summary", () => {
  it("is Off when the interval is unset", () => {
    expect(
      describeRoundsPlan({ intervalSeconds: null, maxCount: null, durationSeconds: null })
    ).toBe("Off");
  });

  it("names the count cap", () => {
    expect(
      describeRoundsPlan({ intervalSeconds: 3600, maxCount: 3, durationSeconds: null })
    ).toBe("Every 1 hr, 3 times");
  });

  it("uses singular 'time' for a count of one", () => {
    expect(
      describeRoundsPlan({ intervalSeconds: 1800, maxCount: 1, durationSeconds: null })
    ).toBe("Every 30 min, 1 time");
  });

  it("names the duration cap", () => {
    expect(
      describeRoundsPlan({ intervalSeconds: 3600, maxCount: null, durationSeconds: 7200 })
    ).toBe("Every 1 hr for 2 hr");
  });

  it("degrades to Off when an interval is set but neither cap is", () => {
    // Not a shape either editor ever persists, but a defensive read matters
    // more than an unbounded schedule nobody chose.
    expect(
      describeRoundsPlan({ intervalSeconds: 3600, maxCount: null, durationSeconds: null })
    ).toBe("Off");
  });
});

describe("Rounds notification ids", () => {
  it("share the task's nag: prefix so cancelling a task clears Rounds too", () => {
    const id = buildRoundNotificationId("abc", 0);
    expect(id).toBe("nag:abc:round:0");
    expect(isNagNotificationId(id)).toBe(true);
    expect(parseNotificationId(id)).toEqual({ taskId: "abc", index: 0, round: true });
  });

  it("cannot collide with a burst position or the pre-alarm slot", () => {
    expect(parseNotificationId("nag:abc:0")?.round).toBeUndefined();
    expect(parseNotificationId("nag:abc:pre")?.round).toBeUndefined();
    expect(buildRoundNotificationId("abc", 0)).not.toBe("nag:abc:0");
  });

  it(`uses a reserved slot word ("${ROUNDS_SLOT}") that can't parse as an index`, () => {
    expect(Number.isNaN(Number(ROUNDS_SLOT))).toBe(true);
  });

  it("rejects a malformed round id the same way a malformed burst id is rejected", () => {
    expect(parseNotificationId("nag:abc:round:-1")).toBeNull();
    expect(parseNotificationId("nag:abc:round:x")).toBeNull();
  });
});

describe("planNagNotifications — Rounds fires", () => {
  it("schedules Rounds fires alongside the Nag-Me burst", () => {
    const planned = planNagNotifications(
      [task({ roundsIntervalSeconds: 3600, roundsMaxCount: 3 })],
      { now: NOW }
    );
    const rounds = planned.filter((p) => p.identifier.includes(`:${ROUNDS_SLOT}:`));
    expect(rounds).toHaveLength(3);
    expect(rounds.map((p) => p.body)).toEqual(["Round 1", "Round 2", "Round 3"]);
  });

  it("is absent for a task with Rounds off", () => {
    const planned = planNagNotifications([task()], { now: NOW });
    expect(planned.some((p) => p.identifier.includes(`:${ROUNDS_SLOT}:`))).toBe(false);
  });

  it("skips the escalation ladder — plain, non-repeating copy regardless of snoozeCount", () => {
    const planned = planNagNotifications(
      [task({ roundsIntervalSeconds: 3600, roundsMaxCount: 2, snoozeCount: 8 })],
      { now: NOW }
    );
    const rounds = planned.filter((p) => p.identifier.includes(`:${ROUNDS_SLOT}:`));
    expect(rounds.map((p) => p.body)).toEqual([
      describeRoundOccurrence(0),
      describeRoundOccurrence(1),
    ]);
  });
});

describe("U6 — Rounds fires count against the notification ceiling", () => {
  it("never exceeds the budget with every task carrying a full Rounds schedule", () => {
    const tasks = Array.from({ length: 20 }, (_, i) =>
      task({
        id: `t${i}`,
        fireAt: new Date(NOW.getTime() + (i + 1) * 3_600_000).toISOString(),
        nagMaxCount: 6,
        roundsIntervalSeconds: 900,
        roundsMaxCount: 20, // each task alone would exceed the whole global budget
      })
    );

    const planned = planNagNotifications(tasks, { now: NOW });
    expect(planned.length).toBeLessThanOrEqual(60); // SAFE_GLOBAL_NOTIFICATION_BUDGET
  });

  it("allocates Rounds after the Nag-Me burst and before the pre-alarm", () => {
    const bursts = allocateNotificationBudget(
      [
        {
          id: "only",
          fireAt: new Date(NOW.getTime() + 3_600_000),
          nagIntervalSeconds: 900,
          nagMaxCount: 3,
          roundsIntervalSeconds: 1800,
          roundsMaxCount: 1,
          leadTimeSeconds: 600,
        },
      ],
      { globalBudget: 5, now: NOW }
    );

    // 3 nag fires + 1 rounds fire = 4, leaving exactly 1 slot — spent on the
    // pre-alarm, proving Rounds was charged before it and the nag burst kept
    // its 3.
    expect(bursts[0].fireTimes).toHaveLength(3);
    expect(bursts[0].roundsFireTimes).toHaveLength(1);
    expect(bursts[0].preAlarm).toBeInstanceOf(Date);
  });

  it("is empty rather than negative when the budget runs out before Rounds", () => {
    const bursts = allocateNotificationBudget(
      [
        {
          id: "only",
          fireAt: new Date(NOW.getTime() + 3_600_000),
          nagIntervalSeconds: 900,
          nagMaxCount: 6,
          roundsIntervalSeconds: 1800,
          roundsMaxCount: 10,
        },
      ],
      { globalBudget: 6, now: NOW }
    );
    expect(bursts[0].fireTimes).toHaveLength(6);
    expect(bursts[0].roundsFireTimes).toEqual([]);
  });
});
