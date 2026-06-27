import type { Task } from "./types";

/**
 * Escalating nag copy (Phase 2): a deterministic phrase-bank ladder, in the
 * same spirit as how apps like Carrot escalate tone — fixed tiers of
 * hand-written lines selected by an escalation level, not a live generative
 * call. This ladder is what pre-scheduled OS notifications always carry,
 * since a local notification's text is fixed at schedule time and can't be
 * rewritten by a network call when it actually fires. An AI rewrite (see
 * `CopyGenerator`) can only ever refresh the *next* occurrence, right when a
 * snooze is handled live — this ladder is the permanent, offline-safe floor
 * underneath that.
 */

export interface CopyResult {
  title: string;
  body: string;
}

interface Tier {
  minLevel: number;
  lines: string[];
}

const FALLBACK_LINE = "Still on your list — tap to deal with it.";

const TIERS: Tier[] = [
  { minLevel: 0, lines: [FALLBACK_LINE] },
  {
    minLevel: 1,
    lines: [
      "Gentle nudge: this is still open.",
      "Friendly reminder — still waiting on this one.",
    ],
  },
  {
    minLevel: 3,
    lines: [
      "You've put this off a few times now.",
      "This still isn't done. Come on.",
    ],
  },
  {
    minLevel: 5,
    lines: [
      "This isn't going away just because you keep dismissing it.",
      "Seriously? Still ignoring this?",
    ],
  },
  {
    minLevel: 8,
    lines: [
      "At this point it's almost impressive how long you've avoided this.",
      "Wow. You really are just going to let this rot, huh?",
    ],
  },
];

function tierFor(level: number): Tier {
  let chosen = TIERS[0];
  for (const tier of TIERS) {
    if (level >= tier.minLevel) chosen = tier;
  }
  return chosen;
}

/**
 * Picks the body for one occurrence. `level` is escalation progress —
 * typically `task.snoozeCount + occurrenceIndexWithinBurst` — so a burst
 * that's never snoozed still ramps in tone the same way `shrink` mode already
 * ramps the interval, and live snoozing pushes the floor up further.
 *
 * Tone never softens as `level` rises: within a tier the lines are ordered
 * mild→harsh and we advance through them and then hold at the harshest, so two
 * consecutive snoozes can read the same but never *milder* than the last.
 *
 * The task's own notes are never overwritten by snark: notes are
 * user-authored content, the ladder only replaces the generic fallback line.
 */
export function generateTemplateCopy(task: Task, level: number): CopyResult {
  const notes = task.notes?.trim();
  if (notes && notes.length > 0) {
    return { title: task.title, body: notes };
  }

  const tier = tierFor(level);
  const withinTier = Math.min(level - tier.minLevel, tier.lines.length - 1);
  const line = tier.lines[withinTier];
  return { title: task.title, body: line };
}

export interface CopyContext {
  task: Task;
  level: number;
}

/**
 * Abstraction point for swapping the deterministic ladder above for an
 * AI-rewritten line (see each app's `RemoteCopyGenerator`). Async because a
 * remote implementation needs to make a network call; callers must apply
 * their own timeout and fall back to `generateTemplateCopy` on any failure.
 */
export interface CopyGenerator {
  generate(context: CopyContext): Promise<CopyResult>;
}

export const templateCopyGenerator: CopyGenerator = {
  generate(context: CopyContext): Promise<CopyResult> {
    return Promise.resolve(generateTemplateCopy(context.task, context.level));
  },
};
