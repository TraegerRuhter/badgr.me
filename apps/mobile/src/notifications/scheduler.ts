import {
  isNagNotificationId,
  parseNotificationId,
  planNagNotifications,
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

/** Cancels only Alarmed's nags, leaving any unrelated notifications untouched. */
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
 * Recomputes the entire pending set from the current tasks and re-arms the
 * device to match (cancel stale, schedule the budgeted burst). Idempotent and
 * safe to call after any task change and on every app foreground (spec §3.3).
 */
export async function rescheduleAllNotifications(
  tasks: Task[]
): Promise<RescheduleResult> {
  await cancelAllNagNotifications();

  const planned = planNagNotifications(tasks);

  await Promise.all(
    planned.map((p) => {
      const trigger: Notifications.DateTriggerInput = {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: p.fireAt,
      };
      if (Platform.OS === "android") {
        trigger.channelId = ANDROID_CHANNEL_ID;
      }
      return Notifications.scheduleNotificationAsync({
        identifier: p.identifier,
        content: {
          title: p.title,
          body: p.body,
          sound: "default",
        },
        trigger,
      });
    })
  );

  return { scheduledCount: planned.length };
}

/** How many nag notifications are currently armed on the device (for debugging). */
export async function getScheduledNagCount(): Promise<number> {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  return scheduled.filter((n) => isNagNotificationId(n.identifier)).length;
}
