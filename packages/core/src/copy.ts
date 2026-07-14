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

/**
 * Nag personality packs (personalization): the *voice* of the escalation
 * ladder, separate from tone/intensity (Gentle/Standard/Savage) which shifts
 * how fast you climb the tiers. Each pack is the same five-tier shape keyed
 * on the same minLevels, so tone and pack compose cleanly. Every pack stays
 * within the same content rules as the nag-ai prompt: no profanity, no
 * genuine cruelty, no threats — just flavor.
 */
export type NagPack = "classic" | "drill" | "corporate" | "wholesome" | "passive";

export const NAG_PACKS: readonly NagPack[] = [
  "classic",
  "drill",
  "corporate",
  "wholesome",
  "passive",
];

export const NAG_PACK_LABELS: Record<NagPack, string> = {
  classic: "Classic",
  drill: "Drill Sergeant",
  corporate: "Corporate",
  wholesome: "Wholesome",
  passive: "Passive-Aggressive",
};

export function isNagPack(value: unknown): value is NagPack {
  return typeof value === "string" && (NAG_PACKS as readonly string[]).includes(value);
}

const PACKS: Record<NagPack, Tier[]> = {
  classic: [
    { minLevel: 0, lines: ["Still on your list — tap to deal with it."] },
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
  ],
  drill: [
    { minLevel: 0, lines: ["On your feet. This one's still standing."] },
    {
      minLevel: 1,
      lines: [
        "Move it — this task won't complete itself.",
        "Eyes on the objective. Still not done.",
      ],
    },
    {
      minLevel: 3,
      lines: [
        "I've seen recruits move faster than this.",
        "You call that follow-through? Get it done.",
      ],
    },
    {
      minLevel: 5,
      lines: [
        "Same task, same excuses. STILL. NOT. DONE.",
        "Are you allergic to finishing things?",
      ],
    },
    {
      minLevel: 8,
      lines: [
        "I could've retired in the time you've dodged this.",
        "Outstanding. A masterclass in doing absolutely nothing.",
      ],
    },
  ],
  corporate: [
    { minLevel: 0, lines: ["Circling back on this open item."] },
    {
      minLevel: 1,
      lines: [
        "Just flagging that this is still on your plate.",
        "Following up per my last notification.",
      ],
    },
    {
      minLevel: 3,
      lines: [
        "Bumping this to the top of your priorities.",
        "This action item remains unactioned.",
      ],
    },
    {
      minLevel: 5,
      lines: [
        "Let's take this offline — as in, actually do it.",
        "This has stayed open for several sync cycles now.",
      ],
    },
    {
      minLevel: 8,
      lines: [
        "At this point this task deserves its own quarterly review.",
        "Let's leverage some follow-through here, going forward.",
      ],
    },
  ],
  wholesome: [
    { minLevel: 0, lines: ["Hey, this little thing is still waiting for you."] },
    {
      minLevel: 1,
      lines: [
        "No rush — this is still here whenever you're ready.",
        "You've got this. It's a small one.",
      ],
    },
    {
      minLevel: 3,
      lines: [
        "Still cheering you on! Ready when you are.",
        "A few nudges in — you can totally knock this out.",
      ],
    },
    {
      minLevel: 5,
      lines: [
        "I believe in you. Let's give this one a go.",
        "It'll feel so good to check this off, promise.",
      ],
    },
    {
      minLevel: 8,
      lines: [
        "Whenever you're ready, no judgment — I'll be right here.",
        "Look how patient we're both being. Let's finish strong.",
      ],
    },
  ],
  passive: [
    { minLevel: 0, lines: ["Oh, this? Still here. No big deal."] },
    {
      minLevel: 1,
      lines: [
        "Not that anyone's counting the reminders. But.",
        "It's fine. I'll just wait. Again.",
      ],
    },
    {
      minLevel: 3,
      lines: [
        "No no, take your time. It's only been a while.",
        "Cool cool cool. Totally normal to ignore this.",
      ],
    },
    {
      minLevel: 5,
      lines: [
        "I'm sure you have your reasons. I'd love to hear them.",
        "Wow, still going strong on the not-doing, huh.",
      ],
    },
    {
      minLevel: 8,
      lines: [
        "Honestly? Impressive commitment to the avoidance.",
        "I've stopped expecting anything. And yet, here we are.",
      ],
    },
  ],
};

function tierFor(level: number, pack: NagPack): Tier {
  const tiers = PACKS[pack];
  let chosen = tiers[0];
  for (const tier of tiers) {
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
export function generateTemplateCopy(
  task: Task,
  level: number,
  pack: NagPack = "classic"
): CopyResult {
  const notes = task.notes?.trim();
  if (notes && notes.length > 0) {
    return { title: task.title, body: notes };
  }

  const tier = tierFor(level, pack);
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
