import type { Task } from "@alarmed/core";

/**
 * Canonical NDJSON: one Task per line, rows sorted by id, keys emitted in a
 * fixed order. Deterministic output means identical state produces identical
 * bytes, which is what makes test vectors meaningful and lets a human diff two
 * decrypted snapshots.
 *
 * ## Evolving this list
 *
 * The key order is part of the format, so **append only — never reorder, never
 * remove.** Reordering rewrites the bytes of every vault; removing a key makes
 * old snapshots unreadable.
 *
 * New keys go in `LATER_KEYS` rather than `V1_KEYS`, which is what lets the
 * format grow without a version bump:
 *
 *  - **Writing** always emits every key, original and later.
 *  - **Reading** requires the v1 core and backfills anything later that is
 *    absent, so a snapshot written before a field existed still opens.
 *  - An old client reading a *new* snapshot ignores the extra key it does not
 *    know about, so it opens too.
 *
 * That two-way compatibility is why this beats bumping `FORMAT_VERSION`, which
 * would make new snapshots simply unreadable to any client that had not been
 * updated — a hard cutover to buy nothing, since the added fields are optional
 * by construction. It is the same reasoning protobuf uses for optional fields.
 *
 * The cost, stated plainly: adding a key changes the canonical bytes for every
 * *newly written* vault, so `vectors.test.ts` has to be regenerated. That is a
 * deliberate act with a recorded reason, not a licence to paste in whatever
 * bytes the suite currently produces — if the vectors break and you did not add
 * a key, something is wrong and pasting hides it.
 */

/** The original seventeen. Required on read; a snapshot missing one is corrupt. */
const V1_KEYS = [
  "id",
  "title",
  "notes",
  "createdAt",
  "updatedAt",
  "fireAt",
  "nagIntervalSeconds",
  "nagMaxCount",
  "nagUntil",
  "escalationMode",
  "completedAt",
  "dismissedAt",
  "repeatRule",
  "priority",
  "deviceOrigin",
  "deletedAt",
  "snoozeCount",
] as const satisfies readonly (keyof Task)[];

/**
 * Added after v1. Optional on read, backfilled from `LATER_DEFAULTS`.
 *
 * Append here, in the order added — the position is part of the format.
 */
const LATER_KEYS = [
  "leadTimeSeconds",
  "roundsIntervalSeconds",
  "roundsMaxCount",
  "roundsDurationSeconds",
] as const satisfies readonly (keyof Task)[];

/**
 * What a snapshot written before the key existed should read as.
 *
 * Must mean "this was never set". A default that implies a real value would
 * invent state the user never chose — a pre-alarm they never asked for, in this
 * case, which would then start firing notifications.
 */
const LATER_DEFAULTS: { [K in (typeof LATER_KEYS)[number]]: Task[K] } = {
  leadTimeSeconds: null,
  roundsIntervalSeconds: null,
  roundsMaxCount: null,
  roundsDurationSeconds: null,
};

const TASK_KEYS = [...V1_KEYS, ...LATER_KEYS] as const;

export function canonicalNdjson(tasks: readonly Task[]): string {
  const sorted = [...tasks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sorted
    .map((task) => {
      const ordered: Record<string, unknown> = {};
      for (const key of TASK_KEYS) ordered[key] = task[key];
      return JSON.stringify(ordered);
    })
    .join("\n");
}

export function parseNdjson(text: string): Task[] {
  if (text.length === 0) return [];
  return text.split("\n").map((line, i) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`Malformed NDJSON at line ${i + 1}`);
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(`Expected an object at line ${i + 1}`);
    }
    const row = parsed as Record<string, unknown>;

    // The v1 core is mandatory: a row missing one of these is damaged, not old,
    // and guessing at it would be inventing task data.
    for (const key of V1_KEYS) {
      if (!(key in row)) throw new Error(`Missing field "${key}" at line ${i + 1}`);
    }
    // Later keys are optional — absent means the snapshot predates them.
    for (const key of LATER_KEYS) {
      if (!(key in row)) row[key] = LATER_DEFAULTS[key];
    }

    return row as unknown as Task;
  });
}
