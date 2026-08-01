import type { Task } from "@alarmed/core";

/**
 * Canonical NDJSON: one Task per line, rows sorted by id, keys emitted in a
 * fixed order. Deterministic output means identical state produces identical
 * bytes, which is what makes test vectors meaningful and lets a human diff two
 * decrypted snapshots.
 *
 * The key order below is part of the format. Adding a Task field means adding
 * it here (at the end) and bumping the format version — a silent addition
 * would change the canonical bytes of every existing vault.
 */
const TASK_KEYS = [
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
    for (const key of TASK_KEYS) {
      if (!(key in row)) throw new Error(`Missing field "${key}" at line ${i + 1}`);
    }
    return row as unknown as Task;
  });
}
