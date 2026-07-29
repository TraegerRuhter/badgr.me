import type { Task } from "@alarmed/core";
import type { RandomSource } from "./random";
import { SUITE_ARGON2ID, type KdfParams } from "./suite";

/**
 * Deterministic byte source for tests. Emits a counter-derived pattern so a
 * sealed envelope is reproducible byte-for-byte.
 *
 * Test-only, and exported from a clearly named module so it can never be
 * mistaken for something safe to wire into an app.
 */
export function fakeRandom(seed = 1): RandomSource {
  let n = seed;
  return (byteLength: number) => {
    const out = new Uint8Array(byteLength);
    for (let i = 0; i < byteLength; i++) out[i] = (n = (n * 1103515245 + 12345) & 0xffffffff) >>> 24;
    return out;
  };
}

/**
 * Deliberately weak KDF parameters so the suite runs fast. Real parameters live
 * in DEFAULT_KDF and are asserted separately, so speeding up tests can never
 * quietly weaken production.
 */
export const TEST_KDF: KdfParams = { suite: SUITE_ARGON2ID, m: 64, t: 1, p: 1 };

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-0001",
    title: "Take out the recycling",
    notes: null,
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-19T14:00:00.000Z",
    fireAt: "2026-07-20T09:00:00.000Z",
    nagIntervalSeconds: 300,
    nagMaxCount: null,
    nagUntil: null,
    escalationMode: "shrink",
    completedAt: null,
    dismissedAt: null,
    repeatRule: "weekly",
    priority: 0,
    deviceOrigin: "mobile",
    deletedAt: null,
    snoozeCount: 0,
    ...overrides,
  };
}
