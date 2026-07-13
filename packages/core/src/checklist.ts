/**
 * Notes-as-checklist (reference app parity): a task's free-text notes can
 * double as a checklist by writing lines as `- [ ] item` / `- [x] item`
 * (standard Markdown task-list syntax). No new field — this is a pure
 * read/write view over the existing `notes` string, so it needs no schema
 * change and stays fully compatible with notes that are just plain text
 * (or a mix of prose and checklist lines).
 */

export interface ChecklistItem {
  /** Index into notes.split("\n") — the toggle target. */
  lineIndex: number;
  text: string;
  checked: boolean;
}

// Captures: 1) bullet + leading space, 2) the mark (space or x/X), 3) the
// single space right after "]" if present, 4) the item text.
const CHECKLIST_LINE_RE = /^(\s*[-*]\s*)\[([ xX])\](\s?)(.*)$/;

export function parseChecklist(notes: string | null): ChecklistItem[] {
  if (!notes) return [];
  const items: ChecklistItem[] = [];
  notes.split("\n").forEach((line, lineIndex) => {
    const match = CHECKLIST_LINE_RE.exec(line);
    if (match) {
      items.push({ lineIndex, text: match[4], checked: match[2].toLowerCase() === "x" });
    }
  });
  return items;
}

export function hasChecklist(notes: string | null): boolean {
  return parseChecklist(notes).length > 0;
}

export interface ChecklistProgress {
  done: number;
  total: number;
}

export function checklistProgress(notes: string | null): ChecklistProgress {
  const items = parseChecklist(notes);
  return { done: items.filter((i) => i.checked).length, total: items.length };
}

/**
 * Flips one line's checkbox and returns the full new notes string, leaving
 * every other line (including non-checklist prose) untouched. A stale or
 * out-of-range lineIndex (e.g. the notes changed elsewhere between render
 * and tap) is a no-op rather than corrupting the text.
 */
export function toggleChecklistItem(notes: string, lineIndex: number): string {
  const lines = notes.split("\n");
  const line = lines[lineIndex];
  if (line === undefined) return notes;

  const match = CHECKLIST_LINE_RE.exec(line);
  if (!match) return notes;

  const [, bullet, mark, spacer, text] = match;
  const nextMark = mark.toLowerCase() === "x" ? " " : "x";
  lines[lineIndex] = `${bullet}[${nextMark}]${spacer}${text}`;
  return lines.join("\n");
}

/** Appends a fresh, unchecked checklist line — the editor's "add item" action. */
export function appendChecklistItem(notes: string | null, text = ""): string {
  const trimmedBase = notes ? notes.replace(/\n+$/, "") : "";
  const line = `- [ ] ${text}`;
  return trimmedBase ? `${trimmedBase}\n${line}` : line;
}
