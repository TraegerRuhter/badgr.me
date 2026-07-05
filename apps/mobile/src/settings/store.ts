import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  type AppSettings,
} from "@alarmed/core";

/**
 * The native counterpart to apps/web/src/settings/store.ts — same key name,
 * same salvage posture (a corrupt blob yields defaults), AsyncStorage instead
 * of localStorage.
 */
const SETTINGS_KEY = "alarmed.settings";

export async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  try {
    await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Persistence is best-effort; the in-memory value still applies.
  }
}
