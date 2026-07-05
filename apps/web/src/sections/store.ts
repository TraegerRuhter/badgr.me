import { BUCKET_ORDER, type TaskBucket } from "@alarmed/core";

/**
 * Which drawers are collapsed — device-local UI state, separate from
 * AppSettings so the settings blob stays about behavior. "Done" starts
 * collapsed: finished tasks are clutter until you go looking for them.
 */
export const COLLAPSED_KEY = "alarmed.collapsed";

const DEFAULT_COLLAPSED: TaskBucket[] = ["done"];

export function loadCollapsed(): TaskBucket[] {
  const raw = localStorage.getItem(COLLAPSED_KEY);
  if (!raw) return DEFAULT_COLLAPSED;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_COLLAPSED;
    return parsed.filter((b): b is TaskBucket =>
      (BUCKET_ORDER as readonly string[]).includes(b as string)
    );
  } catch {
    return DEFAULT_COLLAPSED;
  }
}

export function saveCollapsed(collapsed: TaskBucket[]): void {
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed));
}
