import {
  ADJUST_STEPS,
  appendChecklistItem,
  atTimeOfDay,
  groupTasksIntoSections,
  isRepeatRule,
  NAG_PACK_LABELS,
  NAG_PACKS,
  overdueAgeLabel,
  parseChecklist,
  parseNotificationId,
  planNagNotifications,
  planOptionsFrom,
  powerStateFor,
  quickFireAt,
  refreshNextOccurrenceCopy,
  REPEAT_LABELS,
  REPEAT_RULES,
  swipeActionFor,
  toggleChecklistItem,
  toneLevelOffset,
  DEFAULT_SETTINGS,
  NAG_TONES,
  SETTING_LIMITS,
  TIME_OF_DAY_CHIPS,
  WHEN_CHOICES,
  type AppSettings,
  type EscalationMode,
  type NagTone,
  type RepeatRule,
  type Task,
  type TaskBucket,
  type WhenChoice,
} from "@alarmed/core";
import { colors, radii, spacing, typography, type IconName } from "@alarmed/ui";
import DateTimePicker from "@react-native-community/datetimepicker";
import { StatusBar } from "expo-status-bar";
import * as Notifications from "expo-notifications";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { nagCopyGenerator } from "./src/copy/nagAi";
import { runSync, syncEnabled } from "./src/sync/supabase";
import {
  adjustTaskFireAt,
  completeTask,
  createTask,
  deleteTask,
  getTask,
  initDatabase,
  listTasks,
  reopenTask,
  setTaskPaused,
  snoozeTask,
  updateTask,
  type NewTaskInput,
  type TaskPatch,
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
import { loadCollapsed, saveCollapsed } from "./src/sections/store";
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
  intervalSeconds: number;
  nagMaxCount: number;
  escalationMode?: EscalationMode;
}

// Nag-cadence presets — *when* the task fires comes from the when-chips;
// these only decide how relentlessly it re-fires afterward. Same set as the
// web app's, so a task behaves identically on either platform.
const PRESETS: Preset[] = [
  {
    label: "Rapid",
    sub: "every 30s × 5",
    icon: "bolt",
    intervalSeconds: 30,
    nagMaxCount: 5,
  },
  {
    label: "Hourly",
    sub: "every 1h × 6",
    icon: "clock",
    intervalSeconds: 3600,
    nagMaxCount: 6,
  },
  {
    label: "Shrink",
    sub: "1m, tightening × 6",
    icon: "shrink",
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
  const [quickOpen, setQuickOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [collapsed, setCollapsed] = useState<TaskBucket[]>(["done"]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [when, setWhen] = useState<WhenChoice | "custom" | "none">("hour");
  const [customWhen, setCustomWhen] = useState<Date>(() => quickFireAt("hour"));

  useEffect(() => {
    let cancelled = false;
    void loadCollapsed().then((stored) => {
      if (!cancelled) setCollapsed(stored);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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

  // The task list grouped into the collapsible time drawers, after the
  // search filter; a collapsed drawer keeps its header but renders no rows.
  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    const visible = q
      ? tasks.filter((t) =>
          `${t.title} ${t.notes ?? ""}`.toLowerCase().includes(q)
        )
      : tasks;
    return groupTasksIntoSections(visible);
  }, [tasks, query]);

  const editingTask = useMemo(
    () => (editingId ? tasks.find((t) => t.id === editingId) ?? null : null),
    [tasks, editingId]
  );

  const toggleSection = useCallback((bucket: TaskBucket) => {
    setCollapsed((prev) => {
      const next = prev.includes(bucket)
        ? prev.filter((b) => b !== bucket)
        : [...prev, bucket];
      void saveCollapsed(next);
      return next;
    });
  }, []);

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
      const fireAt =
        when === "none"
          ? null
          : (when === "custom" ? customWhen : quickFireAt(when)).toISOString();
      const input: NewTaskInput = {
        title: title.trim() || "Reminder",
        fireAt,
        nagIntervalSeconds: preset.intervalSeconds,
        nagMaxCount: preset.nagMaxCount,
        escalationMode: preset.escalationMode,
      };
      setTitle("");
      setWhen("hour");
      void runMutation(() => createTask(input));
    },
    [title, when, customWhen, runMutation]
  );

  const handleAdjust = useCallback(
    (taskId: string, deltaSeconds: number) =>
      runMutation(() => adjustTaskFireAt(taskId, deltaSeconds)),
    [runMutation]
  );

  // Toggling a checklist row rewrites just that line of notes — reads the
  // current task fresh rather than trusting a stale closure, since a
  // background sync could have applied a remote edit in the meantime.
  const handleToggleChecklistItem = useCallback(
    (taskId: string, lineIndex: number) =>
      runMutation(async () => {
        const current = await getTask(taskId);
        if (!current || current.notes == null) return null;
        return updateTask(taskId, {
          notes: toggleChecklistItem(current.notes, lineIndex),
        });
      }),
    [runMutation]
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
          badgr<Text style={styles.wordmarkAccent}>.me</Text>
        </Text>
        <Pressable
          style={styles.iconBtn}
          accessibilityLabel="Search"
          onPress={() => {
            setSearchOpen((open) => {
              if (open) setQuery("");
              return !open;
            });
          }}
        >
          <Icon
            name="search"
            size={19}
            color={searchOpen ? colors.accent : colors.textSecondary}
          />
        </Pressable>
        <Pressable
          style={styles.iconBtn}
          accessibilityLabel="Settings"
          onPress={() => setQuickOpen(true)}
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

      {searchOpen ? (
        <TextInput
          style={[styles.input, styles.searchInput]}
          placeholder="Search tasks and notes…"
          placeholderTextColor={colors.textSecondary}
          value={query}
          onChangeText={setQuery}
          autoFocus
        />
      ) : null}

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
        {title.trim().length > 0 ? (
          <>
            <View style={styles.whenRow}>
              {WHEN_CHOICES.map((choice) => (
                <Pressable
                  key={choice.id}
                  style={[styles.whenChip, when === choice.id && styles.whenChipActive]}
                  onPress={() => setWhen(choice.id)}
                >
                  <Text
                    style={[
                      styles.whenChipText,
                      when === choice.id && styles.whenChipTextActive,
                    ]}
                  >
                    {choice.label}
                  </Text>
                </Pressable>
              ))}
              <Pressable
                style={[styles.whenChip, when === "custom" && styles.whenChipActive]}
                onPress={() => setWhen("custom")}
              >
                <Icon
                  name="clock"
                  size={13}
                  strokeWidth={2.4}
                  color={when === "custom" ? colors.onAccent : colors.textSecondary}
                />
                <Text
                  style={[
                    styles.whenChipText,
                    when === "custom" && styles.whenChipTextActive,
                  ]}
                >
                  Pick…
                </Text>
              </Pressable>
              <Pressable
                style={[styles.whenChip, when === "none" && styles.whenChipActive]}
                onPress={() => setWhen("none")}
              >
                <Text
                  style={[
                    styles.whenChipText,
                    when === "none" && styles.whenChipTextActive,
                  ]}
                >
                  No date
                </Text>
              </Pressable>
            </View>
            {when === "custom" ? (
              <DateTimePicker
                value={customWhen}
                mode="datetime"
                display="spinner"
                minimumDate={new Date()}
                themeVariant="dark"
                onChange={(_event, selected) => {
                  if (selected) setCustomWhen(selected);
                }}
              />
            ) : null}
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
          </>
        ) : null}
      </View>

      <SectionList
        sections={sections.map((section) => ({
          ...section,
          data: collapsed.includes(section.bucket) ? [] : section.tasks,
        }))}
        keyExtractor={(task) => task.id}
        contentContainerStyle={styles.list}
        stickySectionHeadersEnabled={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={colors.accent}
            onRefresh={() => {
              // Manual pull deliberately ignores "Pause sync" — the user is
              // asking for a refresh right now.
              setRefreshing(true);
              void runSync()
                .then(() => syncFromDb())
                .catch(() => {})
                .finally(() => setRefreshing(false));
            }}
          />
        }
        ListEmptyComponent={
          <Text style={styles.caption}>
            {query.trim()
              ? "Nothing matches that search."
              : "No tasks yet — add one above."}
          </Text>
        }
        renderSectionHeader={({ section }) => {
          const isCollapsed = collapsed.includes(section.bucket);
          return (
            <View style={styles.sectionHead}>
              <Pressable
                style={styles.sectionToggle}
                accessibilityRole="button"
                accessibilityState={{ expanded: !isCollapsed }}
                onPress={() => toggleSection(section.bucket)}
              >
                <View
                  style={[
                    styles.sectionChevron,
                    isCollapsed && styles.sectionChevronCollapsed,
                  ]}
                >
                  <Icon
                    name="chevron"
                    size={16}
                    strokeWidth={2.4}
                    color={colors.textSecondary}
                  />
                </View>
                <Text style={styles.sectionLabel}>
                  {section.label.toUpperCase()}
                </Text>
                <View
                  style={[
                    styles.sectionCount,
                    section.bucket === "past" && styles.sectionCountPast,
                  ]}
                >
                  <Text
                    style={[
                      styles.sectionCountText,
                      section.bucket === "past" && styles.sectionCountTextPast,
                    ]}
                  >
                    {section.tasks.length}
                  </Text>
                </View>
              </Pressable>
              {section.bucket === "past" ? (
                <Pressable
                  style={styles.sectionAction}
                  onPress={() =>
                    runMutation(async () => {
                      for (const task of section.tasks) {
                        await completeTask(task.id);
                      }
                    })
                  }
                >
                  <Text style={styles.sectionActionText}>Mark all done</Text>
                </Pressable>
              ) : null}
              {section.bucket === "done" ? (
                <Pressable
                  style={styles.sectionAction}
                  onPress={() =>
                    runMutation(async () => {
                      for (const task of section.tasks) {
                        await deleteTask(task.id);
                      }
                    })
                  }
                >
                  <Text style={[styles.sectionActionText, styles.sectionActionDanger]}>
                    Trim list
                  </Text>
                </Pressable>
              ) : null}
            </View>
          );
        }}
        renderItem={({ item }) => (
          <TaskCard
            task={item}
            settings={settings}
            pendingCount={plannedByTask.get(item.id) ?? 0}
            expanded={expandedId === item.id}
            onToggleExpand={() =>
              setExpandedId((prev) => (prev === item.id ? null : item.id))
            }
            onAdjust={(delta) => handleAdjust(item.id, delta)}
            onToggleChecklistItem={(lineIndex) =>
              handleToggleChecklistItem(item.id, lineIndex)
            }
            onEdit={() => setEditingId(item.id)}
            onTogglePause={() =>
              runMutation(() => setTaskPaused(item.id, item.dismissedAt == null))
            }
            onComplete={() => runMutation(() => completeTask(item.id))}
            onReopen={() => runMutation(() => reopenTask(item.id))}
            onDelete={() => runMutation(() => deleteTask(item.id))}
            onSnooze={() => handleSnooze(item.id)}
          />
        )}
      />

      <QuickSheet
        open={quickOpen}
        settings={settings}
        onChange={updateSettings}
        onOpenSettings={() => {
          setQuickOpen(false);
          setSettingsOpen(true);
        }}
        onOpenHelp={() => {
          setQuickOpen(false);
          setHelpOpen(true);
        }}
        onClose={() => setQuickOpen(false)}
      />
      <SettingsSheet
        open={settingsOpen}
        settings={settings}
        permissionGranted={permissionGranted}
        onChange={updateSettings}
        onClose={() => setSettingsOpen(false)}
      />
      <HelpSheet
        open={helpOpen}
        settings={settings}
        permissionGranted={permissionGranted}
        onClose={() => setHelpOpen(false)}
      />
      {editingTask ? (
        <EditSheet
          task={editingTask}
          onSave={(patch) => {
            setEditingId(null);
            void runMutation(() => updateTask(editingTask.id, patch));
          }}
          onClose={() => setEditingId(null)}
        />
      ) : null}
      <StatusBar style="light" />
    </View>
  );
}

// Cadence choices offered in the editor; a task whose current interval isn't
// one of these shows an extra chip for it so the selection is never empty.
const INTERVAL_CHOICES: readonly { label: string; seconds: number }[] = [
  { label: "30s", seconds: 30 },
  { label: "5m", seconds: 300 },
  { label: "30m", seconds: 1800 },
  { label: "1h", seconds: 3600 },
  { label: "3h", seconds: 10800 },
];

interface EditSheetProps {
  task: Task;
  onSave: (patch: TaskPatch) => void;
  onClose: () => void;
}

function EditSheet({ task, onSave, onClose }: EditSheetProps) {
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes ?? "");
  const [dated, setDated] = useState(task.fireAt != null);
  const [fireAt, setFireAt] = useState<Date>(() => {
    const parsed = task.fireAt ? new Date(task.fireAt) : quickFireAt("hour");
    return Number.isNaN(parsed.getTime()) ? quickFireAt("hour") : parsed;
  });
  const [intervalSeconds, setIntervalSeconds] = useState(task.nagIntervalSeconds);
  const [maxCount, setMaxCount] = useState(task.nagMaxCount ?? 6);
  const [shrink, setShrink] = useState(task.escalationMode === "shrink");
  const [repeat, setRepeat] = useState<RepeatRule | null>(
    isRepeatRule(task.repeatRule) ? task.repeatRule : null
  );

  const intervals = INTERVAL_CHOICES.some((c) => c.seconds === intervalSeconds)
    ? INTERVAL_CHOICES
    : [
        ...INTERVAL_CHOICES,
        { label: formatInterval(intervalSeconds), seconds: intervalSeconds },
      ];

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.sheetHandle} />
        <View style={styles.sheetHead}>
          <Text style={styles.sheetTitle}>Edit task</Text>
          <Pressable
            style={styles.iconBtn}
            accessibilityLabel="Close editor"
            onPress={onClose}
          >
            <Icon name="close" size={18} color={colors.textSecondary} />
          </Pressable>
        </View>

        <ScrollView style={styles.sheetScroll} showsVerticalScrollIndicator={false}>
          <Text style={styles.editorLabel}>TITLE</Text>
          <TextInput
            style={styles.input}
            value={title}
            onChangeText={setTitle}
            placeholderTextColor={colors.textSecondary}
          />

          <Text style={styles.editorLabel}>NOTES</Text>
          <TextInput
            style={[styles.input, styles.editorNotes]}
            value={notes}
            onChangeText={setNotes}
            placeholder={
              'Shown as the notification body (instead of the sass). Lines like "- [ ] item" become a checklist.'
            }
            placeholderTextColor={colors.textSecondary}
            multiline
          />
          <Pressable
            style={styles.checklistAddBtn}
            onPress={() => setNotes((current) => appendChecklistItem(current))}
          >
            <Icon name="plus" size={13} color={colors.textSecondary} />
            <Text style={styles.checklistAddBtnText}>Add checklist item</Text>
          </Pressable>

          <View style={styles.settingRow}>
            <Text style={styles.settingName}>Has a date</Text>
            <Toggle value={dated} label="Has a date" onChange={setDated} />
          </View>
          {!dated ? (
            <Text style={styles.settingDesc}>
              Undated — parked with no alarm until you give it a time.
            </Text>
          ) : (
            <>
              <DateTimePicker
                value={fireAt}
                mode="datetime"
                display="spinner"
                themeVariant="dark"
                onChange={(_event, selected) => {
                  if (selected) setFireAt(selected);
                }}
              />
              <View style={styles.whenRow}>
                {TIME_OF_DAY_CHIPS.map((chip) => (
                  <Pressable
                    key={chip.label}
                    style={styles.whenChip}
                    onPress={() => setFireAt((d) => atTimeOfDay(d, chip.hour))}
                  >
                    <Text style={styles.whenChipText}>{chip.label}</Text>
                  </Pressable>
                ))}
              </View>
              <View style={styles.whenRow}>
                <Pressable
                  style={styles.whenChip}
                  onPress={() =>
                    setFireAt((d) => {
                      const today = new Date();
                      today.setHours(d.getHours(), d.getMinutes(), 0, 0);
                      return today;
                    })
                  }
                >
                  <Text style={styles.whenChipText}>Today</Text>
                </Pressable>
                <Pressable
                  style={styles.whenChip}
                  onPress={() => setFireAt((d) => new Date(d.getTime() + 86_400_000))}
                >
                  <Text style={styles.whenChipText}>+1 day</Text>
                </Pressable>
                <Pressable
                  style={styles.whenChip}
                  onPress={() =>
                    setFireAt((d) => new Date(d.getTime() + 7 * 86_400_000))
                  }
                >
                  <Text style={styles.whenChipText}>+1 week</Text>
                </Pressable>
              </View>

              <Text style={styles.editorLabel}>REPEAT</Text>
              <View style={styles.whenRow}>
                <Pressable
                  style={[styles.whenChip, repeat === null && styles.whenChipActive]}
                  onPress={() => setRepeat(null)}
                >
                  <Text
                    style={[
                      styles.whenChipText,
                      repeat === null && styles.whenChipTextActive,
                    ]}
                  >
                    Never
                  </Text>
                </Pressable>
                {REPEAT_RULES.map((rule) => (
                  <Pressable
                    key={rule}
                    style={[styles.whenChip, repeat === rule && styles.whenChipActive]}
                    onPress={() => setRepeat(rule)}
                  >
                    <Text
                      style={[
                        styles.whenChipText,
                        repeat === rule && styles.whenChipTextActive,
                      ]}
                    >
                      {REPEAT_LABELS[rule]}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </>
          )}

          <Text style={styles.editorLabel}>NAG EVERY</Text>
          <View style={styles.whenRow}>
            {intervals.map((choice) => (
              <Pressable
                key={choice.seconds}
                style={[
                  styles.whenChip,
                  intervalSeconds === choice.seconds && styles.whenChipActive,
                ]}
                onPress={() => setIntervalSeconds(choice.seconds)}
              >
                <Text
                  style={[
                    styles.whenChipText,
                    intervalSeconds === choice.seconds && styles.whenChipTextActive,
                  ]}
                >
                  {choice.label}
                </Text>
              </Pressable>
            ))}
          </View>

          <View style={styles.settingRow}>
            <View style={styles.settingText}>
              <Text style={styles.settingName}>Times</Text>
              <Text style={styles.settingDesc}>
                Lifetime cap on this task's nags.
              </Text>
            </View>
            <Stepper
              value={maxCount}
              min={1}
              max={20}
              label="nag count"
              onChange={setMaxCount}
            />
          </View>

          <View style={styles.settingRow}>
            <View style={styles.settingText}>
              <Text style={styles.settingName}>Shrink intervals</Text>
              <Text style={styles.settingDesc}>
                Each nag lands sooner than the last.
              </Text>
            </View>
            <Toggle value={shrink} label="Shrink intervals" onChange={setShrink} />
          </View>

          <View style={styles.editorActions}>
            <ActionButton icon="close" label="Cancel" tone="quiet" onPress={onClose} />
            <ActionButton
              icon="check"
              label="Save"
              tone="accent"
              onPress={() =>
                onSave({
                  title,
                  notes,
                  fireAt: dated ? fireAt.toISOString() : null,
                  nagIntervalSeconds: intervalSeconds,
                  nagMaxCount: maxCount,
                  escalationMode: shrink ? "shrink" : "none",
                  // A repeat needs a date to repeat from — clearing the date clears it too.
                  repeatRule: dated ? repeat : null,
                })
              }
            />
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

interface TaskCardProps {
  task: Task;
  settings: AppSettings;
  pendingCount: number;
  expanded: boolean;
  onToggleExpand: () => void;
  onAdjust: (deltaSeconds: number) => void;
  onToggleChecklistItem: (lineIndex: number) => void;
  onEdit: () => void;
  onTogglePause: () => void;
  onComplete: () => void;
  onReopen: () => void;
  onDelete: () => void;
  onSnooze: () => void;
}

function TaskCard({
  task,
  settings,
  pendingCount,
  expanded,
  onToggleExpand,
  onAdjust,
  onToggleChecklistItem,
  onEdit,
  onTogglePause,
  onComplete,
  onReopen,
  onDelete,
  onSnooze,
}: TaskCardProps) {
  const done = task.completedAt != null;
  const power = powerStateFor(task);
  const paused = power === "paused";
  const ageLabel = done || paused ? "" : overdueAgeLabel(task.fireAt);
  const checklist = parseChecklist(task.notes);
  const powerColor =
    power === "paused"
      ? colors.danger
      : power === "snoozed"
        ? colors.textSecondary
        : colors.accent;

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
      <Pressable
        style={styles.card}
        disabled={done}
        onPress={onToggleExpand}
        accessibilityHint="Expands quick due-date adjustments"
      >
        <View style={[styles.cardRail, done && styles.cardRailDone]} />
        <View style={styles.titleRow}>
          {!done ? (
            <Pressable
              style={[styles.powerCircle, { borderColor: powerColor }, paused && styles.powerCirclePaused]}
              accessibilityLabel={paused ? "Resume alerts" : "Pause alerts"}
              onPress={onTogglePause}
            >
              <Icon name="power" size={13} strokeWidth={2.4} color={powerColor} />
            </Pressable>
          ) : null}
          <Text style={[styles.title, done && styles.titleDone]}>{task.title}</Text>
        </View>
        <View style={styles.metaRow}>
          {done ? (
            <Text style={styles.caption}>
              Done {formatDateTime(task.completedAt as string)}
            </Text>
          ) : paused ? (
            <Text style={styles.caption}>Paused — no alerts until resumed</Text>
          ) : task.fireAt == null ? (
            <Text style={styles.caption}>No date — tap to add one</Text>
          ) : (
            <>
              <Text style={[styles.caption, ageLabel ? styles.metaOverdue : null]}>
                Fires {formatDateTime(task.fireAt)}
                {ageLabel ? ` ${ageLabel}` : ""} · every{" "}
                {formatInterval(task.nagIntervalSeconds)}
              </Text>
              {isRepeatRule(task.repeatRule) ? (
                <View style={styles.repeatBadge}>
                  <Icon name="repeat" size={10} strokeWidth={2.6} color={colors.textSecondary} />
                  <Text style={styles.repeatBadgeText}>
                    {REPEAT_LABELS[task.repeatRule]}
                  </Text>
                </View>
              ) : null}
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
        {checklist.length > 0 ? (
          <View style={styles.checklist}>
            {checklist.map((item) => (
              <Pressable
                key={item.lineIndex}
                style={styles.checklistRow}
                onPress={() => onToggleChecklistItem(item.lineIndex)}
              >
                <View
                  style={[styles.checklistBox, item.checked && styles.checklistBoxChecked]}
                >
                  {item.checked ? (
                    <Icon name="check" size={10} strokeWidth={3} color={colors.onAccent} />
                  ) : null}
                </View>
                <Text
                  style={[styles.checklistText, item.checked && styles.checklistTextChecked]}
                >
                  {item.text}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
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
        {expanded && !done ? (
          <View style={styles.adjustPanel}>
            <View style={styles.adjustRow}>
              {ADJUST_STEPS.map((step) => (
                <Pressable
                  key={`minus-${step.label}`}
                  style={({ pressed }) => [
                    styles.adjustBtn,
                    pressed && styles.adjustBtnPressed,
                  ]}
                  onPress={() => onAdjust(-step.seconds)}
                >
                  <Text style={styles.adjustBtnTextMinus}>−{step.label}</Text>
                </Pressable>
              ))}
            </View>
            <View style={styles.adjustRow}>
              {ADJUST_STEPS.map((step) => (
                <Pressable
                  key={`plus-${step.label}`}
                  style={({ pressed }) => [
                    styles.adjustBtn,
                    styles.adjustBtnPlus,
                    pressed && styles.adjustBtnPressed,
                  ]}
                  onPress={() => onAdjust(step.seconds)}
                >
                  <Text style={styles.adjustBtnTextPlus}>+{step.label}</Text>
                </Pressable>
              ))}
            </View>
            <Pressable
              style={({ pressed }) => [
                styles.adjustEdit,
                pressed && styles.adjustBtnPressed,
              ]}
              onPress={onEdit}
            >
              <Icon name="pencil" size={14} color={colors.textSecondary} />
              <Text style={styles.adjustEditText}>Edit task</Text>
            </Pressable>
          </View>
        ) : null}
      </Pressable>
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
      ? "rgba(240, 163, 47, 0.45)"
      : tone === "danger"
        ? "rgba(228, 87, 79, 0.4)"
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
  permissionGranted: boolean | null;
  onChange: (next: AppSettings) => void;
  onClose: () => void;
}

interface QuickSheetProps {
  open: boolean;
  settings: AppSettings;
  onChange: (next: AppSettings) => void;
  onOpenSettings: () => void;
  onOpenHelp: () => void;
  onClose: () => void;
}

/**
 * The compact sheet behind the sliders icon: the two most-touched switches
 * and the tone control, plus doors into full Settings and Help.
 */
function QuickSheet({
  open,
  settings,
  onChange,
  onOpenSettings,
  onOpenHelp,
  onClose,
}: QuickSheetProps) {
  const g = settings.gestures;
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.sheetHandle} />
        <View style={styles.settingRow}>
          <Text style={styles.settingName}>Swipe gestures</Text>
          <Toggle
            value={g.swipeEnabled}
            label="Swipe gestures"
            onChange={(swipeEnabled) =>
              onChange({ ...settings, gestures: { ...g, swipeEnabled } })
            }
          />
        </View>
        <View style={styles.settingRow}>
          <Text style={styles.settingName}>Pause sync</Text>
          <Toggle
            value={settings.sync.paused}
            label="Pause sync"
            disabled={!syncEnabled}
            onChange={(paused) => onChange({ ...settings, sync: { paused } })}
          />
        </View>
        <View style={styles.quickTone}>
          <Segmented
            options={NAG_TONES}
            labels={TONE_LABELS}
            value={settings.copy.tone}
            label="Nag tone"
            onChange={(tone) =>
              onChange({ ...settings, copy: { ...settings.copy, tone } })
            }
          />
        </View>
        <View style={styles.quickNav}>
          <Pressable
            style={({ pressed }) => [styles.quickNavBtn, pressed && styles.btnPressed]}
            onPress={onOpenSettings}
          >
            <Icon name="sliders" size={15} color={colors.textSecondary} />
            <Text style={styles.quickNavText}>All settings</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.quickNavBtn,
              styles.quickNavBtnAccent,
              pressed && styles.btnPressed,
            ]}
            onPress={onOpenHelp}
          >
            <Icon name="help" size={15} color={colors.accent} />
            <Text style={[styles.quickNavText, styles.quickNavTextAccent]}>Help</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

interface HelpSheetProps {
  open: boolean;
  settings: AppSettings;
  permissionGranted: boolean | null;
  onClose: () => void;
}

function HelpSheet({ open, settings, permissionGranted, onClose }: HelpSheetProps) {
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.sheetHandle} />
        <View style={styles.sheetHead}>
          <Text style={styles.sheetTitle}>Help</Text>
          <Pressable
            style={styles.iconBtn}
            accessibilityLabel="Close help"
            onPress={onClose}
          >
            <Icon name="close" size={18} color={colors.textSecondary} />
          </Pressable>
        </View>

        <ScrollView style={styles.sheetScroll} showsVerticalScrollIndicator={false}>
          <View style={styles.groupLabelRow}>
            <Icon name="bell" size={15} color={colors.textSecondary} />
            <Text style={styles.groupLabel}>SYSTEM HEALTH</Text>
          </View>

          <View style={styles.settingRow}>
            <View style={styles.settingText}>
              <Text style={styles.settingName}>Notification permission</Text>
              <Text style={styles.settingDesc}>
                {permissionGranted
                  ? "Granted — nags can fire, even force-closed."
                  : permissionGranted === false
                    ? "Blocked. Allow alerts in the system Settings app > badgr.me > Notifications."
                    : "Not decided yet — the system will ask on launch."}
              </Text>
            </View>
            <View
              style={[styles.healthPill, permissionGranted && styles.healthPillOk]}
            >
              <Text
                style={[
                  styles.healthPillText,
                  permissionGranted && styles.healthPillTextOk,
                ]}
              >
                {permissionGranted ? "OK" : "ATTENTION"}
              </Text>
            </View>
          </View>

          <View style={styles.settingRow}>
            <View style={styles.settingText}>
              <Text style={styles.settingName}>Sync</Text>
              <Text style={styles.settingDesc}>
                {!syncEnabled
                  ? "No Supabase project configured — the app runs local-only."
                  : settings.sync.paused
                    ? "Paused — resume from quick settings."
                    : "Reconciling in the background after every change."}
              </Text>
            </View>
            <View
              style={[
                styles.healthPill,
                syncEnabled && !settings.sync.paused && styles.healthPillOk,
              ]}
            >
              <Text
                style={[
                  styles.healthPillText,
                  syncEnabled && !settings.sync.paused && styles.healthPillTextOk,
                ]}
              >
                {syncEnabled && !settings.sync.paused ? "OK" : "ATTENTION"}
              </Text>
            </View>
          </View>

          <View style={styles.groupLabelRow}>
            <Icon name="bolt" size={15} color={colors.textSecondary} />
            <Text style={styles.groupLabel}>TIPS & TRICKS</Text>
          </View>

          {TIPS.map((topic) => (
            <TroubleshootItem key={topic.q} q={topic.q} a={topic.a} />
          ))}

          <View style={styles.groupLabelRow}>
            <Icon name="search" size={15} color={colors.textSecondary} />
            <Text style={styles.groupLabel}>TROUBLESHOOTING</Text>
          </View>

          {TROUBLESHOOTING.map((topic) => (
            <TroubleshootItem key={topic.q} q={topic.q} a={topic.a} />
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

const TIPS: readonly { q: string; a: string }[] = [
  {
    q: "Swipe works both ways",
    a: "Swipe a task right to complete it, left to snooze it, and swipe a finished task right to reopen it. Directions can be swapped — or swiping disabled — under Gestures above.",
  },
  {
    q: "Notes replace the sass",
    a: "If a task has notes, they become the notification body verbatim. The escalating copy ladder only ever writes the generic line — your own words are never overwritten.",
  },
  {
    q: "Snoozing sharpens the tone; adjusting doesn't",
    a: "Every snooze bumps the escalation ladder, so the copy gets more pointed. Nudging the due date from the ±panel deliberately doesn't count against you.",
  },
  {
    q: "The armed badge is live math",
    a: "The count on each card comes from the same planner that actually schedules notifications, honoring your per-task and total caps — what you see is exactly what's armed.",
  },
];

const TROUBLESHOOTING: readonly { q: string; a: string }[] = [
  {
    q: "Force-quitting is fine here",
    a: "Every nag burst is handed to the OS the moment it's scheduled, so notifications keep firing even if you swipe the app away. Reopening the app just recomputes and re-arms the schedule.",
  },
  {
    q: "Armed counts stop around 60",
    a: "iOS caps pending local notifications at 64 per app. The app reserves a little headroom and spreads the rest across your tasks — soonest and highest-priority first. The cap is tunable under Nagging above.",
  },
  {
    q: "Notifications aren't appearing",
    a: "Check the permission row above. If it needs attention, open the system Settings app > badgr.me > Notifications and allow alerts and sounds. On Android, the 'Nags' channel must also stay high-importance.",
  },
  {
    q: "Nothing is syncing between devices",
    a: "Sync needs a configured Supabase project (see the repo's supabase/README) and the Pause switch off on every device. When two devices disagree, the most recent edit wins.",
  },
];

function TroubleshootItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.tsItem}>
      <Pressable
        style={styles.tsHead}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((v) => !v)}
      >
        <View
          style={[styles.sectionChevron, !open && styles.sectionChevronCollapsed]}
        >
          <Icon name="chevron" size={14} strokeWidth={2.4} color={colors.textSecondary} />
        </View>
        <Text style={styles.tsHeadText}>{q}</Text>
      </Pressable>
      {open ? <Text style={styles.tsBody}>{a}</Text> : null}
    </View>
  );
}

const TONE_LABELS: Record<NagTone, string> = {
  gentle: "Gentle",
  standard: "Standard",
  savage: "Savage",
};

function SettingsSheet({
  open,
  settings,
  permissionGranted,
  onChange,
  onClose,
}: SettingsSheetProps) {
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

          <View style={styles.settingCol}>
            <Text style={styles.settingDesc}>
              Personality — the voice your nags speak in.
            </Text>
            <View style={styles.whenRow}>
              {NAG_PACKS.map((pack) => (
                <Pressable
                  key={pack}
                  style={[styles.whenChip, c.pack === pack && styles.whenChipActive]}
                  onPress={() => onChange({ ...settings, copy: { ...c, pack } })}
                >
                  <Text
                    style={[
                      styles.whenChipText,
                      c.pack === pack && styles.whenChipTextActive,
                    ]}
                  >
                    {NAG_PACK_LABELS[pack]}
                  </Text>
                </Pressable>
              ))}
            </View>
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
  wordmarkAccent: {
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
  whenRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 10,
  },
  whenChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  whenChipActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  whenChipText: {
    fontSize: 12.5,
    fontWeight: "700",
    letterSpacing: 0.1,
    color: colors.textSecondary,
  },
  whenChipTextActive: {
    color: colors.onAccent,
  },
  metaOverdue: {
    color: colors.danger,
    fontWeight: "700",
  },
  searchInput: {
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
  },
  editorLabel: {
    marginTop: 16,
    marginBottom: 6,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1.2,
    color: colors.textSecondary,
  },
  editorNotes: {
    minHeight: 64,
    textAlignVertical: "top",
  },
  editorActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: spacing.sm,
    marginTop: 22,
    marginBottom: 8,
  },
  adjustEdit: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.border,
  },
  adjustEditText: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.textSecondary,
  },
  healthPill: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: radii.pill,
    backgroundColor: colors.dangerSoft,
  },
  healthPillOk: {
    backgroundColor: colors.accentSoft,
  },
  healthPillText: {
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.6,
    color: colors.danger,
  },
  healthPillTextOk: {
    color: colors.accent,
  },
  tsItem: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  tsHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 12,
  },
  tsHeadText: {
    flex: 1,
    fontSize: 14,
    fontWeight: "600",
    color: colors.textPrimary,
  },
  tsBody: {
    marginLeft: 22,
    marginBottom: 12,
    fontSize: 13,
    lineHeight: 20,
    color: colors.textSecondary,
  },
  adjustPanel: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: 6,
  },
  adjustRow: {
    flexDirection: "row",
    gap: 6,
  },
  adjustBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    alignItems: "center",
  },
  adjustBtnPlus: {
    borderColor: "rgba(240, 163, 47, 0.35)",
  },
  adjustBtnPressed: {
    backgroundColor: colors.accentSoft,
    borderColor: colors.accent,
  },
  adjustBtnTextMinus: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.textSecondary,
    fontVariant: ["tabular-nums"],
  },
  adjustBtnTextPlus: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.accent,
    fontVariant: ["tabular-nums"],
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
  sectionHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: 4,
    marginBottom: 8,
  },
  sectionToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingVertical: 6,
    paddingRight: 8,
  },
  sectionChevron: {
    transform: [{ rotate: "0deg" }],
  },
  sectionChevronCollapsed: {
    transform: [{ rotate: "-90deg" }],
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1.2,
    color: colors.textSecondary,
  },
  sectionCount: {
    minWidth: 20,
    paddingHorizontal: 7,
    paddingVertical: 1,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceRaised,
    alignItems: "center",
  },
  sectionCountPast: {
    backgroundColor: colors.accentSoft,
  },
  sectionCountText: {
    fontSize: 11,
    fontWeight: "700",
    color: colors.textSecondary,
    fontVariant: ["tabular-nums"],
  },
  sectionCountTextPast: {
    color: colors.accent,
  },
  sectionAction: {
    marginLeft: "auto",
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  sectionActionText: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.2,
    color: colors.accent,
  },
  sectionActionDanger: {
    color: colors.danger,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  powerCircle: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  powerCirclePaused: {
    backgroundColor: colors.dangerSoft,
  },
  quickTone: {
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  quickNav: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: 14,
    marginBottom: 8,
  },
  quickNavBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  quickNavBtnAccent: {
    borderColor: "rgba(240, 163, 47, 0.45)",
  },
  quickNavText: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.textSecondary,
  },
  quickNavTextAccent: {
    color: colors.accent,
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
  repeatBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 7,
    paddingVertical: 1,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceRaised,
  },
  repeatBadgeText: {
    fontSize: 11,
    fontWeight: "700",
    color: colors.textSecondary,
  },
  checklist: {
    marginTop: 8,
    gap: 2,
  },
  checklistRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    paddingVertical: 3,
  },
  checklistBox: {
    width: 16,
    height: 16,
    marginTop: 1,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: colors.textSecondary,
    alignItems: "center",
    justifyContent: "center",
  },
  checklistBoxChecked: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  checklistText: {
    flex: 1,
    fontSize: 13.5,
    color: colors.textPrimary,
  },
  checklistTextChecked: {
    color: colors.textSecondary,
    textDecorationLine: "line-through",
  },
  checklistAddBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    alignSelf: "flex-start",
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.border,
  },
  checklistAddBtnText: {
    fontSize: 12,
    fontWeight: "700",
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
