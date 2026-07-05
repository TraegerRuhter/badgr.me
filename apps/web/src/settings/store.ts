import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  type AppSettings,
} from "@alarmed/core";

/** Same salvage posture as the task store: a corrupt blob yields defaults. */
export const SETTINGS_KEY = "alarmed.settings";

export function loadSettings(): AppSettings {
  const raw = localStorage.getItem(SETTINGS_KEY);
  if (!raw) return DEFAULT_SETTINGS;
  try {
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: AppSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
