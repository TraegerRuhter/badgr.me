/**
 * Quick "when should this fire" choices for the composer — the slide-deck's
 * one-tap date selection (Today / +3 Hours / +1 Week row), tuned to this
 * app's rhythms. Pure date math so both clients land on identical times.
 */

export type WhenChoice = "now" | "hour" | "tonight" | "tomorrow";

export const WHEN_CHOICES: readonly { id: WhenChoice; label: string }[] = [
  { id: "now", label: "Now" },
  { id: "hour", label: "In 1 hour" },
  { id: "tonight", label: "Tonight" },
  { id: "tomorrow", label: "Tomorrow" },
];

const TONIGHT_HOUR = 21;
const MORNING_HOUR = 9;

/**
 * Resolves a quick choice to a concrete fire time.
 * - "now" fires in 10s — long enough to lock the phone, short enough to
 *   prove the nag immediately.
 * - "tonight" means 21:00 today, rolling to tomorrow night if it's already
 *   past 20:30 (a "tonight" less than half an hour away is really "now").
 * - "tomorrow" means 09:00 tomorrow.
 */
export function quickFireAt(choice: WhenChoice, now: Date = new Date()): Date {
  switch (choice) {
    case "now":
      return new Date(now.getTime() + 10_000);
    case "hour":
      return new Date(now.getTime() + 3600_000);
    case "tonight": {
      const tonight = new Date(now);
      tonight.setHours(TONIGHT_HOUR, 0, 0, 0);
      if (tonight.getTime() - now.getTime() < 30 * 60_000) {
        tonight.setDate(tonight.getDate() + 1);
      }
      return tonight;
    }
    case "tomorrow": {
      const morning = new Date(now);
      morning.setDate(morning.getDate() + 1);
      morning.setHours(MORNING_HOUR, 0, 0, 0);
      return morning;
    }
  }
}
