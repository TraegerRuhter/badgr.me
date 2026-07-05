import AsyncStorage from "@react-native-async-storage/async-storage";
import { BUCKET_ORDER, type TaskBucket } from "@alarmed/core";

/**
 * Which drawers are collapsed — the native counterpart to
 * apps/web/src/sections/store.ts: same key, same default ("done" starts
 * collapsed), AsyncStorage instead of localStorage.
 */
const COLLAPSED_KEY = "alarmed.collapsed";

const DEFAULT_COLLAPSED: TaskBucket[] = ["done"];

export async function loadCollapsed(): Promise<TaskBucket[]> {
  try {
    const raw = await AsyncStorage.getItem(COLLAPSED_KEY);
    if (!raw) return DEFAULT_COLLAPSED;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_COLLAPSED;
    return parsed.filter((b): b is TaskBucket =>
      (BUCKET_ORDER as readonly string[]).includes(b as string)
    );
  } catch {
    return DEFAULT_COLLAPSED;
  }
}

export async function saveCollapsed(collapsed: TaskBucket[]): Promise<void> {
  try {
    await AsyncStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed));
  } catch {
    // Best-effort; the in-memory state still applies for this session.
  }
}
