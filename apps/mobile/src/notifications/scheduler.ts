import {
  buildNotificationId,
  isNagNotificationId,
  parseNotificationId,
  planNagNotifications,
  type CopyResult,
  type PlanOptions,
  type Task,
} from "@alarmed/core";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

/**
 * The scheduler (spec §3.2–§3.3): the only module that talks to the OS
 * notification queue. It turns the pure plan from `@alarmed/core` into pending
 * local notifications, and is the single source of truth for what's scheduled.
 *
 * The nag "loop" is an illusion built from a pre-scheduled stack: iOS won't run
 * a background timer, but it will fire up to 64 notifications we queue ahead of
 * time, even when the app is force-closed.
 */

const ANDROID_CHANNEL_ID = "nags";

// expo-notifications forbids ":" and "-" in category identifiers.
const NAG_CATEGORY_ID = "nagActions";
export const NAG_ACTION_DONE = "done";
export const NAG_ACTION_SNOOZE = "snooze";

/**
 * Registers the Done/Snooze action buttons. `opensAppToForeground: true` on
 * both is deliberate, not the default Carrot-ish "fire and forget" UX:
 * iOS only delivers the action to our JS listener if the app gets a chance to
 * run, and these nags are designed to survive a fully force-closed app — so
 * the action has to be able to wake it.
 */
export async function setupNotificationCategories(): Promise<void> {
  await Notifications.setNotificationCategoryAsync(NAG_CATEGORY_ID, [
    {
      identifier: NAG_ACTION_DONE,
      buttonTitle: "Done",
      options: { opensAppToForeground: true },
    },
    {
      identifier: NAG_ACTION_SNOOZE,
      buttonTitle: "Snooze",
      options: { opensAppToForeground: true },
    },
  ]);
}

/** Show the nag even when the app is in the foreground. */
export function configureNotificationHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

/** Android requires an explicit high-importance channel for alerts to pop. */
export async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
    name: "Nags",
    importance: Notifications.AndroidImportance.HIGH,
    sound: "default",
  });
}

export async function requestNotificationPermissions(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  const requested = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowBadge: true, allowSound: true },
  });
  return requested.granted;
}

/** Cancels every pending nag for one task — used when it's completed/dismissed (spec §3.2). */
export async function cancelTaskNotifications(taskId: string): Promise<void> {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  await Promise.all(
    scheduled
      .filter((n) => parseNotificationId(n.identifier)?.taskId === taskId)
      .map((n) => Notifications.cancelScheduledNotificationAsync(n.identifier))
  );
}

/** Cancels only badgr.me's nags, leaving any unrelated notifications untouched. */
async function cancelAllNagNotifications(): Promise<void> {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  await Promise.all(
    scheduled
      .filter((n) => isNagNotificationId(n.identifier))
      .map((n) => Notifications.cancelScheduledNotificationAsync(n.identifier))
  );
}

export interface RescheduleResult {
  scheduledCount: number;
}

/**
 * Schedules (or, by reusing the identifier, replaces) a single nag
 * notification. Shared by the full reschedule and the post-snooze AI overlay
 * so the trigger/content shape stays identical between them.
 */
function scheduleNag(
  identifier: string,
  fireAt: Date,
  copy: CopyResult
): Promise<string> {
  const trigger: Notifications.DateTriggerInput = {
    type: Notifications.SchedulableTriggerInputTypes.DATE,
    date: fireAt,
  };
  if (Platform.OS === "android") {
    trigger.channelId = ANDROID_CHANNEL_ID;
  }
  return Notifications.scheduleNotificationAsync({
    identifier,
    content: {
      title: copy.title,
      body: copy.body,
      sound: "default",
      categoryIdentifier: NAG_CATEGORY_ID,
    },
    trigger,
  });
}

/**
 * Recomputes the entire pending set from the current tasks and re-arms the
 * device to match (cancel stale, schedule the budgeted burst). Idempotent and
 * safe to call after any task change and on every app foreground (spec §3.3).
 */
export async function rescheduleAllNotifications(
  tasks: Task[],
  options?: PlanOptions
): Promise<RescheduleResult> {
  await cancelAllNagNotifications();

  const planned = planNagNotifications(tasks, options);

  await Promise.all(
    planned.map((p) =>
      scheduleNag(p.identifier, p.fireAt, { title: p.title, body: p.body })
    )
  );

  return { scheduledCount: planned.length };
}

/**
 * Best-effort overwrite of just the immediate next occurrence's copy, used
 * after a snooze once the nag-ai proxy (or its template fallback) returns a
 * line. Scheduling under the same `nag:{taskId}:0` identifier replaces
 * whatever the template-ladder resync already armed for that occurrence.
 */
export async function overlayNextOccurrenceCopy(
  taskId: string,
  fireAt: Date,
  copy: CopyResult
): Promise<void> {
  await scheduleNag(buildNotificationId(taskId, 0), fireAt, copy);
}

/** How many nag notifications are currently armed on the device (for debugging). */
export async function getScheduledNagCount(): Promise<number> {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  return scheduled.filter((n) => isNagNotificationId(n.identifier)).length;
}
