import {
  parseNotificationId,
  planNagNotifications,
  planOptionsFrom,
  refreshNextOccurrenceCopy,
  swipeActionFor,
  toneLevelOffset,
  DEFAULT_SETTINGS,
  NAG_TONES,
  SETTING_LIMITS,
  type AppSettings,
  type EscalationMode,
  type NagTone,
  type Task,
} from "@alarmed/core";
import { colors, radii, spacing, typography, type IconName } from "@alarmed/ui";
import { StatusBar } from "expo-status-bar";
import * as Notifications from "expo-notifications";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { nagCopyGenerator } from "./src/copy/nagAi";
import { runSync, syncEnabled } from "./src/sync/supabase";
import {
  completeTask,
  createTask,
  deleteTask,
  getTask,
  initDatabase,
  listTasks,
  reopenTask,
  snoozeTask,
  type NewTaskInput,
} from "./src/db/database";
import {
  configureNotificationHandler,
  ensureAndroidChannel,
  NAG_ACTION_DONE,
  NAG_ACTION_SNOOZE,
  overlayNextOccurrenceCopy,
  rescheduleAllNotifications,
  requestNotificationPermissions,
  setupNotificationCategories,
} from "./src/notifications/scheduler";
import { loadSettings, saveSettings } from "./src/settings/store";
import { Icon } from "./src/ui/Icon";
import { Segmented } from "./src/ui/Segmented";
import { Stepper } from "./src/ui/Stepper";
import { SwipeableCard } from "./src/ui/SwipeableCard";
import { Toggle } from "./src/ui/Toggle";

configureNotificationHandler();

interface Preset {
  label: string;
  sub: string;
  icon: IconName;
  firstDelayMs: number;
  intervalSeconds: number;
  nagMaxCount: number;
  escalationMode?: EscalationMode;
}

// Quick-add presets — same set as the web app's, so a task built from a
// given preset behaves identically on either platform.
const PRESETS: Preset[] = [
  {
    label: "Rapid",
    sub: "10s · 30s × 5",
    icon: "bolt",
    firstDelayMs: 10_000,
    intervalSeconds: 30,
    nagMaxCount: 5,
  },
  {
    label: "Hourly",
    sub: "1m · 1h × 6",
    icon: "clock",
    firstDelayMs: 60_000,
    intervalSeconds: 3600,
    nagMaxCount: 6,
  },
  {
    label: "Shrink",
    sub: "10s · 1m × 6",
    icon: "shrink",
    firstDelayMs: 10_000,
    intervalSeconds: 60,
    nagMaxCount: 6,
    escalationMode: "shrink",
  },
];

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

function formatInterval(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

export default function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [permissionGranted, setPermissionGranted] = useState<boolean | null>(null);
  const [armedCount, setArmedCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Callbacks read settings through a ref so they stay referentially stable —
  // otherwise every settings tweak would re-run the init effect chain.
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  // Pending notifications grouped by task, derived from the same pure planner
  // (and the same settings-derived budget/tone) the scheduler uses — so the
  // counts shown match what's actually armed.
  const plannedByTask = useMemo(() => {
    const grouped = new Map<string, number>();
    for (const planned of planNagNotifications(tasks, planOptionsFrom(settings))) {
      grouped.set(planned.taskId, (grouped.get(planned.taskId) ?? 0) + 1);
    }
    return grouped;
  }, [tasks, settings]);

  const syncFromDb = useCallback(async () => {
    const loaded = await listTasks();
    const { scheduledCount } = await rescheduleAllNotifications(
      loaded,
      planOptionsFrom(settingsRef.current)
    );
    setTasks(loaded);
    setArmedCount(scheduledCount);
  }, []);

  // Best-effort Supabase reconcile: push local edits up, pull remote ones down,
  // then refresh the local view. Runs in the background so the UI never blocks
  // on the network, and swallows failures so the app stays offline-first.
  // "Pause sync" stops the reconcile without touching the local flow.
  const backgroundSync = useCallback(() => {
    if (!syncEnabled || settingsRef.current.sync.paused) return;
    void runSync()
      .then(() => syncFromDb())
      .catch(() => {});
  }, [syncFromDb]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await initDatabase();
        await ensureAndroidChannel();
        await setupNotificationCategories();
        await syncFromDb();
        if (!cancelled) backgroundSync();
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    void loadSettings().then((loaded) => {
      if (cancelled) return;
      settingsRef.current = loaded;
      setSettings(loaded);
      // Whatever the init pass armed used defaults — re-arm under the
      // persisted knobs once they're known.
      void syncFromDb();
    });
    // Deliberately not awaited before first paint: the list renders behind
    // the system permission dialog instead of a spinner. Notifications
    // scheduled before the user answers aren't delivered, so re-arm once
    // permission lands.
    void requestNotificationPermissions().then((granted) => {
      if (cancelled) return;
      setPermissionGranted(granted);
      if (granted) void syncFromDb();
    });
    return () => {
      cancelled = true;
    };
  }, [syncFromDb, backgroundSync]);

  // Re-arm the burst and catch up with remote edits when the app returns to
  // the foreground — launch-only re-arm meant a burst that ran dry while the
  // app sat backgrounded stayed dry until the next manual action.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      void syncFromDb();
      backgroundSync();
    });
    return () => subscription.remove();
  }, [syncFromDb, backgroundSync]);

  // Budget/tone changes must re-arm the pending set (the armed notifications
  // were computed under the old knobs), so every settings write reschedules.
  // The ref is assigned synchronously so the re-arm sees the new values.
  const updateSettings = useCallback(
    (next: AppSettings) => {
      settingsRef.current = next;
      setSettings(next);
      void saveSettings(next);
      void syncFromDb();
    },
    [syncFromDb]
  );

  const runMutation = useCallback(
    async (mutate: () => Promise<unknown>) => {
      try {
        setError(null);
        await mutate();
        await syncFromDb();
        backgroundSync();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [syncFromDb, backgroundSync]
  );

  const addPreset = useCallback(
    (preset: Preset) => {
      const input: NewTaskInput = {
        title: title.trim() || "Reminder",
        fireAt: new Date(Date.now() + preset.firstDelayMs).toISOString(),
        nagIntervalSeconds: preset.intervalSeconds,
        nagMaxCount: preset.nagMaxCount,
        escalationMode: preset.escalationMode,
      };
      setTitle("");
      void runMutation(() => createTask(input));
    },
    [title, runMutation]
  );

  const handleSnooze = useCallback(
    (taskId: string) =>
      runMutation(async () => {
        const current = settingsRef.current;
        const updated = await snoozeTask(taskId, {
          snoozeSeconds: current.nag.snoozeMinutes * 60,
        });
        if (!updated) return;
        // Best-effort: the resync above already re-armed every occurrence with
        // the offline-safe template-ladder line. If the nag-ai proxy is
        // reachable (and AI rewrites aren't turned off), overlay a fresher
        // line onto just the next one — shared core helper guards against
        // resurrecting a task dealt with meanwhile.
        void refreshNextOccurrenceCopy(updated, {
          generator: current.copy.aiRewrites ? nagCopyGenerator : null,
          getTask,
          scheduleNextOccurrence: overlayNextOccurrenceCopy,
          levelOffset: toneLevelOffset(current.copy.tone),
        }).catch(() => {});
      }),
    [runMutation]
  );

  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        const parsed = parseNotificationId(response.notification.request.identifier);
        if (!parsed) return;
        if (response.actionIdentifier === NAG_ACTION_DONE) {
          void runMutation(() => completeTask(parsed.taskId));
        } else if (response.actionIdentifier === NAG_ACTION_SNOOZE) {
          void handleSnooze(parsed.taskId);
        }
      }
    );
    return () => subscription.remove();
  }, [runMutation, handleSnooze]);

  if (loading) {
    return (
      <View style={[styles.container, styles.center]}>
        <ActivityIndicator color={colors.accent} />
        <Text style={styles.caption}>Opening local store…</Text>
        <StatusBar style="light" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.masthead}>
        <View style={styles.logoMark}>
          <Icon name="bell" size={24} color={colors.onAccent} strokeWidth={2.2} />
        </View>
        <Text style={styles.wordmark}>
          Alarm<Text style={styles.wordmarkEmber}>ed</Text>
        </Text>
        <Pressable
          style={styles.iconBtn}
          accessibilityLabel="Settings"
          onPress={() => setSettingsOpen(true)}
        >
          <Icon name="sliders" size={20} color={colors.textSecondary} />
        </Pressable>
      </View>
      <View style={styles.sublineRow}>
        {armedCount > 0 ? <View style={styles.armedDot} /> : null}
        <Text style={styles.subline}>
          {armedCount} notification{armedCount === 1 ? "" : "s"} armed
          {permissionGranted === false ? " · notifications denied" : ""}
        </Text>
      </View>

      {permissionGranted === false ? (
        <Text style={styles.warning}>
          Notification permission is off, so nags can&apos;t fire. Enable it in
          Settings.
        </Text>
      ) : null}
      {error ? <Text style={styles.warning}>{error}</Text> : null}

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          placeholder="What should nag you?"
          placeholderTextColor={colors.textSecondary}
          value={title}
          onChangeText={setTitle}
          returnKeyType="done"
        />
        <View style={styles.presetRow}>
          {PRESETS.map((preset) => (
            <Pressable
              key={preset.label}
              style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
              onPress={() => addPreset(preset)}
            >
              <Icon name={preset.icon} size={20} color={colors.accent} />
              <Text style={styles.chipLabel}>{preset.label}</Text>
              <Text style={styles.chipSub}>{preset.sub}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <FlatList
        data={tasks}
        keyExtractor={(task) => task.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Text style={styles.caption}>No tasks yet — add one above.</Text>
        }
        renderItem={({ item }) => (
          <TaskCard
            task={item}
            settings={settings}
            pendingCount={plannedByTask.get(item.id) ?? 0}
            onComplete={() => runMutation(() => completeTask(item.id))}
            onReopen={() => runMutation(() => reopenTask(item.id))}
            onDelete={() => runMutation(() => deleteTask(item.id))}
            onSnooze={() => handleSnooze(item.id)}
          />
        )}
      />

      <SettingsSheet
        open={settingsOpen}
        settings={settings}
        onChange={updateSettings}
        onClose={() => setSettingsOpen(false)}
      />
      <StatusBar style="light" />
    </View>
  );
}

interface TaskCardProps {
  task: Task;
  settings: AppSettings;
  pendingCount: number;
  onComplete: () => void;
  onReopen: () => void;
  onDelete: () => void;
  onSnooze: () => void;
}

function TaskCard({
  task,
  settings,
  pendingCount,
  onComplete,
  onReopen,
  onDelete,
  onSnooze,
}: TaskCardProps) {
  const done = task.completedAt != null;

  // A done task can only be swiped back open; an open task maps each side
  // through the (possibly swapped) gesture settings.
  const rightAction = done
    ? onReopen
    : swipeActionFor(settings, "right") === "complete"
      ? onComplete
      : onSnooze;
  const leftAction = done
    ? null
    : swipeActionFor(settings, "left") === "complete"
      ? onComplete
      : onSnooze;
  const rightIcon: IconName = done
    ? "reopen"
    : swipeActionFor(settings, "right") === "complete"
      ? "check"
      : "snooze";
  const leftIcon: IconName =
    !done && swipeActionFor(settings, "left") === "complete" ? "check" : "snooze";

  return (
    <SwipeableCard
      enabled={settings.gestures.swipeEnabled}
      onSwipeRight={rightAction}
      onSwipeLeft={leftAction}
      rightIcon={rightIcon}
      leftIcon={leftIcon}
    >
      <View style={styles.card}>
        <View style={[styles.cardRail, done && styles.cardRailDone]} />
        <Text style={[styles.title, done && styles.titleDone]}>{task.title}</Text>
        <View style={styles.metaRow}>
          {done ? (
            <Text style={styles.caption}>
              Done {formatDateTime(task.completedAt as string)}
            </Text>
          ) : (
            <>
              <Text style={styles.caption}>
                Fires {formatDateTime(task.fireAt)} · every{" "}
                {formatInterval(task.nagIntervalSeconds)}
              </Text>
              <View
                style={[styles.armedBadge, pendingCount === 0 && styles.armedBadgeZero]}
              >
                <Icon
                  name="bell"
                  size={11}
                  strokeWidth={2.6}
                  color={pendingCount === 0 ? colors.textSecondary : colors.accent}
                />
                <Text
                  style={[
                    styles.armedBadgeText,
                    pendingCount === 0 && styles.armedBadgeTextZero,
                  ]}
                >
                  {pendingCount}
                </Text>
              </View>
            </>
          )}
        </View>
        <View style={styles.actions}>
          {done ? (
            <ActionButton icon="reopen" label="Reopen" tone="quiet" onPress={onReopen} />
          ) : (
            <>
              <ActionButton icon="check" label="Done" tone="accent" onPress={onComplete} />
              <ActionButton icon="snooze" label="Snooze" tone="quiet" onPress={onSnooze} />
            </>
          )}
          <View style={styles.actionsSpacer} />
          <ActionButton icon="trash" label="Delete" tone="danger" onPress={onDelete} />
        </View>
      </View>
    </SwipeableCard>
  );
}

interface ActionButtonProps {
  icon: IconName;
  label: string;
  tone: "accent" | "quiet" | "danger";
  onPress: () => void;
}

function ActionButton({ icon, label, tone, onPress }: ActionButtonProps) {
  const color =
    tone === "accent"
      ? colors.accent
      : tone === "danger"
        ? colors.danger
        : colors.textSecondary;
  const borderColor =
    tone === "accent"
      ? "rgba(255, 107, 74, 0.45)"
      : tone === "danger"
        ? "rgba(255, 93, 143, 0.4)"
        : colors.border;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.btn,
        { borderColor },
        pressed && styles.btnPressed,
      ]}
    >
      <Icon name={icon} size={15} color={color} />
      <Text style={[styles.btnText, { color }]}>{label}</Text>
    </Pressable>
  );
}

interface SettingsSheetProps {
  open: boolean;
  settings: AppSettings;
  onChange: (next: AppSettings) => void;
  onClose: () => void;
}

const TONE_LABELS: Record<NagTone, string> = {
  gentle: "Gentle",
  standard: "Standard",
  savage: "Savage",
};

function SettingsSheet({ open, settings, onChange, onClose }: SettingsSheetProps) {
  const g = settings.gestures;
  const n = settings.nag;
  const c = settings.copy;
  const rightVerb =
    swipeActionFor(settings, "right") === "complete" ? "completes" : "snoozes";
  const leftVerb =
    swipeActionFor(settings, "left") === "complete" ? "completes" : "snoozes";

  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.sheetHandle} />
        <View style={styles.sheetHead}>
          <Text style={styles.sheetTitle}>Settings</Text>
          <Pressable
            style={styles.iconBtn}
            accessibilityLabel="Close settings"
            onPress={onClose}
          >
            <Icon name="close" size={18} color={colors.textSecondary} />
          </Pressable>
        </View>

        <ScrollView style={styles.sheetScroll} showsVerticalScrollIndicator={false}>
          <View style={styles.groupLabelRow}>
            <Icon name="swipe" size={15} color={colors.textSecondary} />
            <Text style={styles.groupLabel}>GESTURES</Text>
          </View>

          <View style={styles.settingRow}>
            <View style={styles.settingText}>
              <Text style={styles.settingName}>Swipe on tasks</Text>
              <Text style={styles.settingDesc}>
                Drag a task card sideways to act on it.
              </Text>
            </View>
            <Toggle
              value={g.swipeEnabled}
              label="Swipe on tasks"
              onChange={(swipeEnabled) =>
                onChange({ ...settings, gestures: { ...g, swipeEnabled } })
              }
            />
          </View>

          <View style={[styles.settingRow, !g.swipeEnabled && styles.settingRowOff]}>
            <View style={styles.settingText}>
              <Text style={styles.settingName}>Swap directions</Text>
              <Text style={styles.settingDesc}>
                Right {rightVerb} · left {leftVerb}.
              </Text>
            </View>
            <Toggle
              value={g.swapDirections}
              label="Swap swipe directions"
              disabled={!g.swipeEnabled}
              onChange={(swapDirections) =>
                onChange({ ...settings, gestures: { ...g, swapDirections } })
              }
            />
          </View>

          <View style={styles.groupLabelRow}>
            <Icon name="bell" size={15} color={colors.textSecondary} />
            <Text style={styles.groupLabel}>NAGGING</Text>
          </View>

          <View style={styles.settingRow}>
            <View style={styles.settingText}>
              <Text style={styles.settingName}>Snooze length</Text>
              <Text style={styles.settingDesc}>
                How long a snoozed nag stays quiet.
              </Text>
            </View>
            <Stepper
              value={n.snoozeMinutes}
              min={SETTING_LIMITS.snoozeMinutes.min}
              max={SETTING_LIMITS.snoozeMinutes.max}
              step={n.snoozeMinutes >= 30 ? 15 : n.snoozeMinutes >= 10 ? 5 : 1}
              unit="m"
              label="snooze length"
              onChange={(snoozeMinutes) =>
                onChange({ ...settings, nag: { ...n, snoozeMinutes } })
              }
            />
          </View>

          <View style={styles.settingRow}>
            <View style={styles.settingText}>
              <Text style={styles.settingName}>Nags per task</Text>
              <Text style={styles.settingDesc}>
                Cap on pre-armed notifications for one task.
              </Text>
            </View>
            <Stepper
              value={n.maxPerTask}
              min={SETTING_LIMITS.maxPerTask.min}
              max={SETTING_LIMITS.maxPerTask.max}
              label="nags per task"
              onChange={(maxPerTask) =>
                onChange({ ...settings, nag: { ...n, maxPerTask } })
              }
            />
          </View>

          <View style={styles.settingRow}>
            <View style={styles.settingText}>
              <Text style={styles.settingName}>Total armed cap</Text>
              <Text style={styles.settingDesc}>
                Across all tasks — stays under the 64-slot OS limit.
              </Text>
            </View>
            <Stepper
              value={n.globalBudget}
              min={SETTING_LIMITS.globalBudget.min}
              max={SETTING_LIMITS.globalBudget.max}
              step={4}
              label="total armed cap"
              onChange={(globalBudget) =>
                onChange({ ...settings, nag: { ...n, globalBudget } })
              }
            />
          </View>

          <View style={styles.groupLabelRow}>
            <Icon name="bolt" size={15} color={colors.textSecondary} />
            <Text style={styles.groupLabel}>TONE</Text>
          </View>

          <View style={styles.settingCol}>
            <Text style={styles.settingDesc}>
              How hard the escalation ladder leans as you keep ignoring a task.
            </Text>
            <Segmented
              options={NAG_TONES}
              labels={TONE_LABELS}
              value={c.tone}
              label="Nag tone"
              onChange={(tone) => onChange({ ...settings, copy: { ...c, tone } })}
            />
          </View>

          <View style={styles.settingRow}>
            <View style={styles.settingText}>
              <Text style={styles.settingName}>AI rewrites</Text>
              <Text style={styles.settingDesc}>
                {nagCopyGenerator
                  ? "Fresh AI-written lines after each snooze."
                  : "No nag-ai endpoint configured — template ladder only."}
              </Text>
            </View>
            <Toggle
              value={c.aiRewrites}
              label="AI rewrites"
              onChange={(aiRewrites) =>
                onChange({ ...settings, copy: { ...c, aiRewrites } })
              }
            />
          </View>

          <View style={styles.groupLabelRow}>
            <Icon name="reopen" size={15} color={colors.textSecondary} />
            <Text style={styles.groupLabel}>SYNC</Text>
          </View>

          <View style={[styles.settingRow, !syncEnabled && styles.settingRowOff]}>
            <View style={styles.settingText}>
              <Text style={styles.settingName}>Pause sync</Text>
              <Text style={styles.settingDesc}>
                {syncEnabled
                  ? "Stop background reconciliation for now."
                  : "No Supabase project configured."}
              </Text>
            </View>
            <Toggle
              value={settings.sync.paused}
              label="Pause sync"
              disabled={!syncEnabled}
              onChange={(paused) => onChange({ ...settings, sync: { paused } })}
            />
          </View>

          <Pressable
            style={({ pressed }) => [styles.resetBtn, pressed && styles.resetBtnPressed]}
            onPress={() => onChange(DEFAULT_SETTINGS)}
          >
            <Text style={styles.resetBtnText}>Reset to defaults</Text>
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    paddingTop: 60,
  },
  center: {
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
  },
  masthead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: spacing.md,
  },
  logoMark: {
    width: 42,
    height: 42,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.accent,
    shadowColor: colors.accent,
    shadowOpacity: 0.45,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  wordmark: {
    ...typography.display,
    flex: 1,
    color: colors.textPrimary,
  },
  wordmarkEmber: {
    color: colors.accent,
  },
  iconBtn: {
    width: 42,
    height: 42,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  sublineRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: spacing.md,
    marginTop: spacing.xs,
    marginBottom: spacing.md,
  },
  armedDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.accent,
  },
  subline: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  warning: {
    ...typography.caption,
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: colors.dangerSoft,
    color: colors.danger,
    overflow: "hidden",
  },
  composer: {
    paddingHorizontal: spacing.md,
    marginBottom: spacing.lg,
  },
  input: {
    ...typography.body,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    color: colors.textPrimary,
  },
  presetRow: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: 10,
  },
  chip: {
    flex: 1,
    alignItems: "center",
    gap: 4,
    paddingTop: 12,
    paddingBottom: 10,
    paddingHorizontal: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipPressed: {
    backgroundColor: colors.accentSoft,
    borderColor: colors.accent,
    transform: [{ scale: 0.96 }],
  },
  chipLabel: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.1,
    color: colors.textPrimary,
  },
  chipSub: {
    fontSize: 11,
    color: colors.textSecondary,
  },
  list: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xl,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingTop: 14,
    paddingBottom: 12,
    paddingLeft: 20,
    paddingRight: 16,
  },
  cardRail: {
    position: "absolute",
    left: 8,
    top: 14,
    bottom: 14,
    width: 3,
    borderRadius: 2,
    backgroundColor: colors.accent,
  },
  cardRailDone: {
    backgroundColor: colors.border,
  },
  title: {
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: -0.2,
    color: colors.textPrimary,
  },
  titleDone: {
    textDecorationLine: "line-through",
    color: colors.textSecondary,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: 6,
  },
  caption: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  armedBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 1,
    borderRadius: radii.pill,
    backgroundColor: colors.accentSoft,
  },
  armedBadgeZero: {
    backgroundColor: colors.surfaceRaised,
  },
  armedBadgeText: {
    fontSize: 11.5,
    fontWeight: "700",
    color: colors.accent,
  },
  armedBadgeTextZero: {
    color: colors.textSecondary,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: 12,
  },
  actionsSpacer: {
    flex: 1,
  },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  btnPressed: {
    backgroundColor: colors.surfaceRaised,
    transform: [{ scale: 0.95 }],
  },
  btnText: {
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 0.1,
  },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: "rgba(9, 7, 18, 0.62)",
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 20,
    paddingBottom: 40,
    maxHeight: "82%",
  },
  sheetScroll: {
    flexGrow: 0,
  },
  settingCol: {
    gap: 10,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  resetBtn: {
    marginTop: 22,
    paddingVertical: 11,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    alignItems: "center",
  },
  resetBtnPressed: {
    borderColor: colors.danger,
    backgroundColor: colors.dangerSoft,
  },
  resetBtnText: {
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 0.2,
    color: colors.textSecondary,
  },
  sheetHandle: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    marginTop: 10,
    marginBottom: 6,
    backgroundColor: colors.border,
  },
  sheetHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  sheetTitle: {
    fontSize: 20,
    fontWeight: "800",
    letterSpacing: -0.4,
    color: colors.textPrimary,
  },
  groupLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 10,
    marginBottom: 4,
  },
  groupLabel: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1.2,
    color: colors.textSecondary,
  },
  settingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  settingRowOff: {
    opacity: 0.45,
  },
  settingText: {
    flex: 1,
  },
  settingName: {
    fontSize: 15,
    fontWeight: "600",
    color: colors.textPrimary,
  },
  settingDesc: {
    fontSize: 12.5,
    marginTop: 2,
    color: colors.textSecondary,
  },
});
