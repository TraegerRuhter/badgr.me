import {
  ADJUST_STEPS,
  atTimeOfDay,
  DEFAULT_SETTINGS,
  groupTasksIntoSections,
  isRepeatRule,
  NAG_TONES,
  overdueAgeLabel,
  planNagNotifications,
  planOptionsFrom,
  powerStateFor,
  quickFireAt,
  refreshNextOccurrenceCopy,
  REPEAT_LABELS,
  REPEAT_RULES,
  SETTING_LIMITS,
  swipeActionFor,
  TIME_OF_DAY_CHIPS,
  toneLevelOffset,
  WHEN_CHOICES,
  type AppSettings,
  type EscalationMode,
  type NagTone,
  type RepeatRule,
  type Task,
  type TaskBucket,
  type WhenChoice,
} from "@alarmed/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { nagCopyGenerator } from "./copy/nagAi";
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
  STORAGE_KEY,
  type NewTaskInput,
  type TaskPatch,
} from "./db/database";
import { loadCollapsed, saveCollapsed } from "./sections/store";
import { loadSettings, saveSettings, SETTINGS_KEY } from "./settings/store";
import { runSync, syncEnabled } from "./sync/supabase";
import {
  overlayNextOccurrenceCopy,
  rescheduleAllNotifications,
  requestNotificationPermissions,
} from "./notifications/scheduler";
import { Icon } from "./ui/Icon";
import { useSwipe } from "./ui/useSwipe";
import type { IconName } from "@alarmed/ui";
import "./App.css";

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
// native app's, so a task behaves identically on either platform.
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

/** datetime-local wants "YYYY-MM-DDTHH:mm" in local time. */
function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate()
  )}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

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
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [quickOpen, setQuickOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<TaskBucket[]>(loadCollapsed);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [when, setWhen] = useState<WhenChoice | "custom" | "none">("hour");
  const [customWhen, setCustomWhen] = useState<string>(() =>
    toLocalInputValue(quickFireAt("hour"))
  );

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
        await syncFromDb();
        if (!cancelled) backgroundSync();
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    // Deliberately not awaited before first paint: an unanswered permission
    // prompt leaves requestPermission() pending indefinitely, which would hold
    // the whole app on the loading spinner. The banner updates whenever the
    // user answers, and the scheduler re-checks permission at fire time.
    void requestNotificationPermissions().then((granted) => {
      if (!cancelled) setPermissionGranted(granted);
    });
    return () => {
      cancelled = true;
    };
  }, [syncFromDb, backgroundSync]);

  // setTimeout doesn't tick through system sleep and gets throttled in
  // background tabs, so a nag due while the laptop was closed never fired.
  // Re-derive the schedule (and catch up with remote edits) whenever the tab
  // becomes visible again.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      void syncFromDb();
      backgroundSync();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [syncFromDb, backgroundSync]);

  // `storage` fires here when *another* tab (same origin) writes the store —
  // reload so every open tab renders the same list and re-arms matching
  // timers. The Notification `tag` dedupes the actual pop-ups across tabs, so
  // converging the timers is safe. A null key means localStorage.clear().
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === STORAGE_KEY) void syncFromDb();
      if (event.key === null || event.key === SETTINGS_KEY) {
        const next = loadSettings();
        // Assign the ref before re-arming so the reschedule sees the new
        // knobs, not the ones from the previous render.
        settingsRef.current = next;
        setSettings(next);
        void syncFromDb();
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [syncFromDb]);

  // The task list grouped into the collapsible time drawers, after the
  // search filter (title + notes, case-insensitive). "now" is taken at
  // render, which every mutation refreshes.
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
      saveCollapsed(next);
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
      saveSettings(next);
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
      let fireAt: string | null;
      if (when === "none") {
        fireAt = null;
      } else {
        const date = when === "custom" ? new Date(customWhen) : quickFireAt(when);
        // An unparseable custom value falls back to the default choice rather
        // than creating a task that fires "now" by accident.
        fireAt = (Number.isNaN(date.getTime()) ? quickFireAt("hour") : date).toISOString();
      }
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

  if (loading) {
    return (
      <div className="center-fill">
        <div className="spinner" />
        <p className="empty-note">Opening local store…</p>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="masthead">
        <div className="logo-mark">
          <Icon name="bell" size={24} strokeWidth={2.2} />
        </div>
        <h1 className="wordmark">
          badgr<em>.me</em>
        </h1>
        <button
          type="button"
          className={`icon-btn${searchOpen ? " active" : ""}`}
          aria-label="Search"
          onClick={() => {
            setSearchOpen((open) => {
              if (open) setQuery("");
              return !open;
            });
          }}
        >
          <Icon name="search" size={19} />
        </button>
        <div className="quick-anchor">
          <button
            type="button"
            className={`icon-btn${quickOpen ? " active" : ""}`}
            aria-label="Settings"
            onClick={() => setQuickOpen((v) => !v)}
          >
            <Icon name="sliders" size={20} />
          </button>
          {quickOpen ? (
            <QuickPanel
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
          ) : null}
        </div>
      </header>
      <p className="subline">
        {armedCount > 0 ? <span className="armed-dot" aria-hidden="true" /> : null}
        {armedCount} notification{armedCount === 1 ? "" : "s"} armed
        {permissionGranted === false ? " · notifications denied" : ""}
      </p>

      {searchOpen ? (
        <input
          className="field search-field"
          placeholder="Search tasks and notes…"
          aria-label="Search tasks"
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      ) : null}

      {permissionGranted === false ? (
        <p className="banner-warn">
          Notification permission is off, so nags can&apos;t fire. Enable it in
          your browser settings.
        </p>
      ) : null}
      {error ? <p className="banner-warn">{error}</p> : null}

      <div className="composer">
        <input
          className="field"
          placeholder="What should nag you?"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        {title.trim().length > 0 ? (
          <div className="composer-reveal">
            <div className="when-row">
              {WHEN_CHOICES.map((choice) => (
                <button
                  key={choice.id}
                  type="button"
                  className={`when-chip${when === choice.id ? " active" : ""}`}
                  onClick={() => setWhen(choice.id)}
                >
                  {choice.label}
                </button>
              ))}
              <button
                type="button"
                className={`when-chip${when === "custom" ? " active" : ""}`}
                onClick={() => setWhen("custom")}
              >
                <Icon name="clock" size={13} strokeWidth={2.4} />
                Pick…
              </button>
              <button
                type="button"
                className={`when-chip${when === "none" ? " active" : ""}`}
                onClick={() => setWhen("none")}
              >
                No date
              </button>
            </div>
            {when === "custom" ? (
              <input
                type="datetime-local"
                className="field dt-input"
                aria-label="Fire date and time"
                value={customWhen}
                min={toLocalInputValue(new Date())}
                onChange={(event) => setCustomWhen(event.target.value)}
              />
            ) : null}
            <div className="chip-row">
              {PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  className="chip"
                  onClick={() => addPreset(preset)}
                >
                  <span className="chip-icon">
                    <Icon name={preset.icon} size={20} />
                  </span>
                  <span className="chip-label">{preset.label}</span>
                  <span className="chip-sub">{preset.sub}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {tasks.length === 0 ? (
        <p className="empty-note">No tasks yet — add one above.</p>
      ) : sections.length === 0 ? (
        <p className="empty-note">Nothing matches that search.</p>
      ) : (
        sections.map((section) => {
          const isCollapsed = collapsed.includes(section.bucket);
          return (
            <section
              key={section.bucket}
              className={`drawer-section${section.bucket === "past" ? " past" : ""}`}
            >
              <div className="section-head">
                <button
                  type="button"
                  className="section-toggle"
                  aria-expanded={!isCollapsed}
                  onClick={() => toggleSection(section.bucket)}
                >
                  <span
                    className={`section-chevron${isCollapsed ? " collapsed" : ""}`}
                  >
                    <Icon name="chevron" size={16} strokeWidth={2.4} />
                  </span>
                  <span className="section-label">{section.label}</span>
                  <span className="section-count">{section.tasks.length}</span>
                </button>
                {section.bucket === "past" ? (
                  <button
                    type="button"
                    className="section-action"
                    onClick={() =>
                      runMutation(async () => {
                        for (const task of section.tasks) {
                          await completeTask(task.id);
                        }
                      })
                    }
                  >
                    Mark all done
                  </button>
                ) : null}
                {section.bucket === "done" ? (
                  <button
                    type="button"
                    className="section-action danger"
                    onClick={() =>
                      runMutation(async () => {
                        for (const task of section.tasks) {
                          await deleteTask(task.id);
                        }
                      })
                    }
                  >
                    Trim list
                  </button>
                ) : null}
              </div>
              {isCollapsed ? null : (
                <ul className="task-list">
                  {section.tasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      settings={settings}
                      pendingCount={plannedByTask.get(task.id) ?? 0}
                      expanded={expandedId === task.id}
                      onToggleExpand={() =>
                        setExpandedId((prev) => (prev === task.id ? null : task.id))
                      }
                      onAdjust={(delta) => handleAdjust(task.id, delta)}
                      onEdit={() => setEditingId(task.id)}
                      onTogglePause={() =>
                        runMutation(() =>
                          setTaskPaused(task.id, task.dismissedAt == null)
                        )
                      }
                      onComplete={() => runMutation(() => completeTask(task.id))}
                      onReopen={() => runMutation(() => reopenTask(task.id))}
                      onDelete={() => runMutation(() => deleteTask(task.id))}
                      onSnooze={() => handleSnooze(task.id)}
                    />
                  ))}
                </ul>
              )}
            </section>
          );
        })
      )}

      {settingsOpen ? (
        <SettingsDrawer
          settings={settings}
          onChange={updateSettings}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}

      {helpOpen ? (
        <HelpDrawer settings={settings} onClose={() => setHelpOpen(false)} />
      ) : null}

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
    </div>
  );
}

interface TaskCardProps {
  task: Task;
  settings: AppSettings;
  pendingCount: number;
  expanded: boolean;
  onToggleExpand: () => void;
  onAdjust: (deltaSeconds: number) => void;
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

  const { offset, dragging, didJustDrag, handlers } = useSwipe({
    enabled: settings.gestures.swipeEnabled,
    onSwipeRight: rightAction,
    onSwipeLeft: leftAction,
  });

  return (
    <li className="swipe-track">
      <div
        className="swipe-hint right"
        style={{ opacity: Math.min(1, Math.max(0, offset) / 64) }}
        aria-hidden="true"
      >
        <Icon name={rightIcon} size={22} />
      </div>
      <div
        className="swipe-hint left"
        style={{ opacity: Math.min(1, Math.max(0, -offset) / 64) }}
        aria-hidden="true"
      >
        <Icon name={leftIcon} size={22} />
      </div>
      <div
        className={`task-card${done ? " done" : ""}${dragging ? " dragging" : ""}${expanded ? " expanded" : ""}`}
        style={{ transform: `translateX(${offset}px)` }}
        onClick={(e) => {
          // Buttons keep their own actions; a completed swipe isn't a tap.
          if ((e.target as HTMLElement).closest("button")) return;
          if (didJustDrag()) return;
          if (!done) onToggleExpand();
        }}
        {...handlers}
      >
        <div className="title-row">
          {!done ? (
            <button
              type="button"
              className={`power-circle ${power}`}
              aria-label={paused ? "Resume alerts" : "Pause alerts"}
              title={
                power === "paused"
                  ? "Alerts off — tap to resume"
                  : power === "snoozed"
                    ? "Snoozed — tap to pause alerts"
                    : "Alerts on — tap to pause"
              }
              onClick={onTogglePause}
            >
              <Icon name="power" size={13} strokeWidth={2.4} />
            </button>
          ) : null}
          <p className="task-title">{task.title}</p>
        </div>
        <p className="task-meta">
          {done ? (
            <span>Done {formatDateTime(task.completedAt as string)}</span>
          ) : paused ? (
            <span>Paused — no alerts until resumed</span>
          ) : task.fireAt == null ? (
            <span>No date — tap to add one</span>
          ) : (
            <>
              <span className={ageLabel ? "meta-overdue" : undefined}>
                Fires {formatDateTime(task.fireAt)}
                {ageLabel ? ` ${ageLabel}` : ""} · every{" "}
                {formatInterval(task.nagIntervalSeconds)}
              </span>
              {isRepeatRule(task.repeatRule) ? (
                <span className="repeat-badge">
                  <Icon name="repeat" size={10} strokeWidth={2.6} />
                  {REPEAT_LABELS[task.repeatRule]}
                </span>
              ) : null}
              <span className={`armed-badge${pendingCount === 0 ? " zero" : ""}`}>
                <Icon name="bell" size={11} strokeWidth={2.6} />
                {pendingCount}
              </span>
            </>
          )}
        </p>
        {expanded && !done ? (
          <div className="adjust-panel">
            <div className="adjust-row">
              {ADJUST_STEPS.map((step) => (
                <button
                  key={`minus-${step.label}`}
                  type="button"
                  className="adjust-btn minus"
                  onClick={() => onAdjust(-step.seconds)}
                >
                  −{step.label}
                </button>
              ))}
            </div>
            <div className="adjust-row">
              {ADJUST_STEPS.map((step) => (
                <button
                  key={`plus-${step.label}`}
                  type="button"
                  className="adjust-btn plus"
                  onClick={() => onAdjust(step.seconds)}
                >
                  +{step.label}
                </button>
              ))}
            </div>
            <button type="button" className="adjust-edit" onClick={onEdit}>
              <Icon name="pencil" size={14} />
              Edit task
            </button>
          </div>
        ) : null}
        <div className="card-actions">
          {done ? (
            <button type="button" className="btn btn-quiet" onClick={onReopen}>
              <Icon name="reopen" size={15} />
              Reopen
            </button>
          ) : (
            <>
              <button type="button" className="btn btn-accent" onClick={onComplete}>
                <Icon name="check" size={15} />
                Done
              </button>
              <button type="button" className="btn btn-quiet" onClick={onSnooze}>
                <Icon name="snooze" size={15} />
                Snooze
              </button>
            </>
          )}
          <button type="button" className="btn btn-danger" onClick={onDelete}>
            <Icon name="trash" size={15} />
            Delete
          </button>
        </div>
      </div>
    </li>
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
  const [fireAt, setFireAt] = useState(() =>
    toLocalInputValue(task.fireAt ? new Date(task.fireAt) : quickFireAt("hour"))
  );
  const [intervalSeconds, setIntervalSeconds] = useState(task.nagIntervalSeconds);
  const [maxCount, setMaxCount] = useState(task.nagMaxCount ?? 6);
  const [shrink, setShrink] = useState(task.escalationMode === "shrink");
  const [repeat, setRepeat] = useState<RepeatRule | null>(
    isRepeatRule(task.repeatRule) ? task.repeatRule : null
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const intervals = INTERVAL_CHOICES.some((c) => c.seconds === intervalSeconds)
    ? INTERVAL_CHOICES
    : [
        ...INTERVAL_CHOICES,
        { label: formatInterval(intervalSeconds), seconds: intervalSeconds },
      ];

  const setDatePart = (shift: (d: Date) => Date) => {
    const current = new Date(fireAt);
    const base = Number.isNaN(current.getTime()) ? new Date() : current;
    setFireAt(toLocalInputValue(shift(base)));
  };

  const save = () => {
    const parsed = new Date(fireAt);
    const nextFireAt = !dated
      ? null
      : Number.isNaN(parsed.getTime())
        ? undefined
        : parsed.toISOString();
    onSave({
      title,
      notes,
      fireAt: nextFireAt,
      nagIntervalSeconds: intervalSeconds,
      nagMaxCount: maxCount,
      escalationMode: shrink ? "shrink" : "none",
      // A repeat needs a date to repeat from — clearing the date clears it too.
      repeatRule: dated ? repeat : null,
    });
  };

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Edit task">
        <div className="drawer-head">
          <h2 className="drawer-title">Edit task</h2>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close editor"
            onClick={onClose}
          >
            <Icon name="close" size={18} />
          </button>
        </div>

        <label className="editor-label" htmlFor="edit-title">
          Title
        </label>
        <input
          id="edit-title"
          className="field"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />

        <label className="editor-label" htmlFor="edit-notes">
          Notes
        </label>
        <textarea
          id="edit-notes"
          className="field editor-notes"
          rows={3}
          placeholder="Shown as the notification body (instead of the sass)."
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />

        <div className="setting-row">
          <p className="setting-name">Has a date</p>
          <Switch checked={dated} label="Has a date" onChange={setDated} />
        </div>
        {!dated ? (
          <p className="setting-desc">
            Undated — parked with no alarm until you give it a time.
          </p>
        ) : (
          <>
            <input
              id="edit-when"
              type="datetime-local"
              className="field dt-input"
              value={fireAt}
              onChange={(event) => setFireAt(event.target.value)}
            />
            <div className="when-row">
              {TIME_OF_DAY_CHIPS.map((chip) => (
                <button
                  key={chip.label}
                  type="button"
                  className="when-chip"
                  onClick={() => setDatePart((d) => atTimeOfDay(d, chip.hour))}
                >
                  {chip.label}
                </button>
              ))}
            </div>
        <div className="when-row">
          <button
            type="button"
            className="when-chip"
            onClick={() =>
              setDatePart((d) => {
                const today = new Date();
                today.setHours(d.getHours(), d.getMinutes(), 0, 0);
                return today;
              })
            }
          >
            Today
          </button>
          <button
            type="button"
            className="when-chip"
            onClick={() =>
              setDatePart((d) => new Date(d.getTime() + 86_400_000))
            }
          >
            +1 day
          </button>
          <button
            type="button"
            className="when-chip"
            onClick={() =>
              setDatePart((d) => new Date(d.getTime() + 7 * 86_400_000))
            }
          >
            +1 week
          </button>
        </div>
            <div className="editor-label">Repeat</div>
            <div className="when-row">
              <button
                type="button"
                className={`when-chip${repeat === null ? " active" : ""}`}
                onClick={() => setRepeat(null)}
              >
                Never
              </button>
              {REPEAT_RULES.map((rule) => (
                <button
                  key={rule}
                  type="button"
                  className={`when-chip${repeat === rule ? " active" : ""}`}
                  onClick={() => setRepeat(rule)}
                >
                  {REPEAT_LABELS[rule]}
                </button>
              ))}
            </div>
          </>
        )}

        <div className="editor-label">Nag every</div>
        <div className="when-row">
          {intervals.map((choice) => (
            <button
              key={choice.seconds}
              type="button"
              className={`when-chip${intervalSeconds === choice.seconds ? " active" : ""}`}
              onClick={() => setIntervalSeconds(choice.seconds)}
            >
              {choice.label}
            </button>
          ))}
        </div>

        <div className="setting-row">
          <div>
            <p className="setting-name">Times</p>
            <p className="setting-desc">Lifetime cap on this task's nags.</p>
          </div>
          <Stepper
            value={maxCount}
            min={1}
            max={20}
            label="nag count"
            onChange={setMaxCount}
          />
        </div>

        <div className="setting-row">
          <div>
            <p className="setting-name">Shrink intervals</p>
            <p className="setting-desc">Each nag lands sooner than the last.</p>
          </div>
          <Switch checked={shrink} label="Shrink intervals" onChange={setShrink} />
        </div>

        <div className="editor-actions">
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-accent editor-save"
            onClick={save}
            disabled={title.trim().length === 0}
          >
            <Icon name="check" size={15} />
            Save
          </button>
        </div>
      </aside>
    </>
  );
}

interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}

function Switch({ checked, onChange, label }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="switch"
      onClick={() => onChange(!checked)}
    />
  );
}

interface StepperProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  label: string;
  onChange: (next: number) => void;
}

function Stepper({ value, min, max, step = 1, unit, label, onChange }: StepperProps) {
  const dec = () => onChange(Math.max(min, value - step));
  const inc = () => onChange(Math.min(max, value + step));
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button
        type="button"
        className="stepper-btn"
        aria-label={`Decrease ${label}`}
        disabled={value <= min}
        onClick={dec}
      >
        −
      </button>
      <span className="stepper-value" aria-live="polite">
        {value}
        {unit ? <span className="stepper-unit">{unit}</span> : null}
      </span>
      <button
        type="button"
        className="stepper-btn"
        aria-label={`Increase ${label}`}
        disabled={value >= max}
        onClick={inc}
      >
        +
      </button>
    </div>
  );
}

const TONE_LABELS: Record<NagTone, string> = {
  gentle: "Gentle",
  standard: "Standard",
  savage: "Savage",
};

interface SegmentedProps {
  value: NagTone;
  onChange: (next: NagTone) => void;
}

function ToneSegmented({ value, onChange }: SegmentedProps) {
  return (
    <div className="segmented" role="radiogroup" aria-label="Nag tone">
      {NAG_TONES.map((tone) => (
        <button
          key={tone}
          type="button"
          role="radio"
          aria-checked={value === tone}
          className={`segment${value === tone ? " active" : ""}`}
          onClick={() => onChange(tone)}
        >
          {TONE_LABELS[tone]}
        </button>
      ))}
    </div>
  );
}

interface SettingsDrawerProps {
  settings: AppSettings;
  onChange: (next: AppSettings) => void;
  onClose: () => void;
}

function SettingsDrawer({ settings, onChange, onClose }: SettingsDrawerProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const g = settings.gestures;
  const n = settings.nag;
  const c = settings.copy;
  const rightVerb = swipeActionFor(settings, "right") === "complete" ? "completes" : "snoozes";
  const leftVerb = swipeActionFor(settings, "left") === "complete" ? "completes" : "snoozes";

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Settings">
        <div className="drawer-head">
          <h2 className="drawer-title">Settings</h2>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close settings"
            onClick={onClose}
          >
            <Icon name="close" size={18} />
          </button>
        </div>

        <div className="setting-group-label">
          <Icon name="swipe" size={15} />
          Gestures
        </div>

        <div className="setting-row">
          <div>
            <p className="setting-name">Swipe on tasks</p>
            <p className="setting-desc">Drag a task card sideways to act on it.</p>
          </div>
          <Switch
            checked={g.swipeEnabled}
            label="Swipe on tasks"
            onChange={(swipeEnabled) =>
              onChange({ ...settings, gestures: { ...g, swipeEnabled } })
            }
          />
        </div>

        <div className={`setting-row${g.swipeEnabled ? "" : " disabled"}`}>
          <div>
            <p className="setting-name">Swap directions</p>
            <p className="setting-desc">
              Right {rightVerb} · left {leftVerb}.
            </p>
          </div>
          <Switch
            checked={g.swapDirections}
            label="Swap swipe directions"
            onChange={(swapDirections) =>
              onChange({ ...settings, gestures: { ...g, swapDirections } })
            }
          />
        </div>

        <div className="setting-group-label">
          <Icon name="bell" size={15} />
          Nagging
        </div>

        <div className="setting-row">
          <div>
            <p className="setting-name">Snooze length</p>
            <p className="setting-desc">How long a snoozed nag stays quiet.</p>
          </div>
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
        </div>

        <div className="setting-row">
          <div>
            <p className="setting-name">Nags per task</p>
            <p className="setting-desc">
              Cap on pre-armed notifications for one task.
            </p>
          </div>
          <Stepper
            value={n.maxPerTask}
            min={SETTING_LIMITS.maxPerTask.min}
            max={SETTING_LIMITS.maxPerTask.max}
            label="nags per task"
            onChange={(maxPerTask) =>
              onChange({ ...settings, nag: { ...n, maxPerTask } })
            }
          />
        </div>

        <div className="setting-row">
          <div>
            <p className="setting-name">Total armed cap</p>
            <p className="setting-desc">
              Across all tasks — stays under the 64-slot OS limit.
            </p>
          </div>
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
        </div>

        <div className="setting-group-label">
          <Icon name="bolt" size={15} />
          Tone
        </div>

        <div className="setting-col">
          <p className="setting-desc">
            How hard the escalation ladder leans as you keep ignoring a task.
          </p>
          <ToneSegmented
            value={c.tone}
            onChange={(tone) => onChange({ ...settings, copy: { ...c, tone } })}
          />
        </div>

        <div className="setting-row">
          <div>
            <p className="setting-name">AI rewrites</p>
            <p className="setting-desc">
              {nagCopyGenerator
                ? "Fresh AI-written lines after each snooze."
                : "No nag-ai endpoint configured — template ladder only."}
            </p>
          </div>
          <Switch
            checked={c.aiRewrites}
            label="AI rewrites"
            onChange={(aiRewrites) =>
              onChange({ ...settings, copy: { ...c, aiRewrites } })
            }
          />
        </div>

        <div className="setting-group-label">
          <Icon name="reopen" size={15} />
          Sync
        </div>

        <div className={`setting-row${syncEnabled ? "" : " disabled"}`}>
          <div>
            <p className="setting-name">Pause sync</p>
            <p className="setting-desc">
              {syncEnabled
                ? "Stop background reconciliation for now."
                : "No Supabase project configured."}
            </p>
          </div>
          <Switch
            checked={settings.sync.paused}
            label="Pause sync"
            onChange={(paused) =>
              onChange({ ...settings, sync: { paused } })
            }
          />
        </div>

        <button
          type="button"
          className="reset-btn"
          onClick={() => onChange(DEFAULT_SETTINGS)}
        >
          Reset to defaults
        </button>
      </aside>
    </>
  );
}

interface QuickPanelProps {
  settings: AppSettings;
  onChange: (next: AppSettings) => void;
  onOpenSettings: () => void;
  onOpenHelp: () => void;
  onClose: () => void;
}

/**
 * The compact panel behind the sliders icon: the two most-touched switches
 * and the tone control, plus doors into full Settings and Help.
 */
function QuickPanel({
  settings,
  onChange,
  onOpenSettings,
  onOpenHelp,
  onClose,
}: QuickPanelProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const g = settings.gestures;
  return (
    <>
      <div className="quick-scrim" onClick={onClose} />
      <div className="quick-panel" role="dialog" aria-label="Quick settings">
        <div className="setting-row">
          <p className="setting-name">Swipe gestures</p>
          <Switch
            checked={g.swipeEnabled}
            label="Swipe gestures"
            onChange={(swipeEnabled) =>
              onChange({ ...settings, gestures: { ...g, swipeEnabled } })
            }
          />
        </div>
        <div className="setting-row">
          <p className="setting-name">Pause sync</p>
          <Switch
            checked={settings.sync.paused}
            label="Pause sync"
            onChange={(paused) => onChange({ ...settings, sync: { paused } })}
          />
        </div>
        <div className="quick-tone">
          <ToneSegmented
            value={settings.copy.tone}
            onChange={(tone) =>
              onChange({ ...settings, copy: { ...settings.copy, tone } })
            }
          />
        </div>
        <div className="quick-nav">
          <button type="button" className="btn btn-quiet" onClick={onOpenSettings}>
            <Icon name="sliders" size={15} />
            All settings
          </button>
          <button type="button" className="btn btn-accent" onClick={onOpenHelp}>
            <Icon name="help" size={15} />
            Help
          </button>
        </div>
      </div>
    </>
  );
}

interface HelpDrawerProps {
  settings: AppSettings;
  onClose: () => void;
}

function HelpDrawer({ settings, onClose }: HelpDrawerProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Help">
        <div className="drawer-head">
          <h2 className="drawer-title">Help</h2>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close help"
            onClick={onClose}
          >
            <Icon name="close" size={18} />
          </button>
        </div>

        <div className="setting-group-label">
          <Icon name="bell" size={15} />
          System health
        </div>

        {systemHealth(settings).map((check) => (
          <div className="setting-row" key={check.name}>
            <div>
              <p className="setting-name">{check.name}</p>
              <p className="setting-desc">{check.detail}</p>
            </div>
            <span className={`health-pill${check.ok ? " ok" : ""}`}>
              {check.ok ? "OK" : "Attention"}
            </span>
          </div>
        ))}

        <div className="setting-group-label">
          <Icon name="bolt" size={15} />
          Tips &amp; tricks
        </div>

        {TIPS.map((topic) => (
          <TroubleshootItem key={topic.q} q={topic.q} a={topic.a} />
        ))}

        <div className="setting-group-label">
          <Icon name="search" size={15} />
          Troubleshooting
        </div>

        {TROUBLESHOOTING.map((topic) => (
          <TroubleshootItem key={topic.q} q={topic.q} a={topic.a} />
        ))}
      </aside>
    </>
  );
}

interface HealthCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Live status of the system-level things a nag depends on — the reference
 * app's "system settings that impact the app" list, for this platform.
 */
function systemHealth(settings: AppSettings): HealthCheck[] {
  const permission =
    "Notification" in window ? Notification.permission : "unsupported";
  const swActive =
    "serviceWorker" in navigator && navigator.serviceWorker.controller != null;

  return [
    {
      name: "Notification permission",
      ok: permission === "granted",
      detail:
        permission === "granted"
          ? "Granted — nags can fire."
          : permission === "denied"
            ? "Blocked. Enable notifications for this site in the browser's site settings, then reload."
            : permission === "default"
              ? "Not decided yet — the browser will ask when a nag arms."
              : "This browser can't show notifications at all.",
    },
    {
      name: "Offline support",
      ok: swActive,
      detail: swActive
        ? "Service worker active — the app loads offline and can be installed."
        : "Not active yet — reload the page once after first visit.",
    },
    {
      name: "Sync",
      ok: syncEnabled && !settings.sync.paused,
      detail: !syncEnabled
        ? "No Supabase project configured — the app runs local-only."
        : settings.sync.paused
          ? "Paused — flip the switch above to resume."
          : "Reconciling in the background after every change.",
    },
  ];
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
    q: "Nags only fire while a tab is open",
    a: "Browsers can't pre-schedule notifications the way a phone OS can, so this app arms timers that live inside the page. Keep a tab (or the installed app window) open — minimized is fine, closed is not. Closing this gap for real needs a Web Push backend, which is on the roadmap.",
  },
  {
    q: "A nag due while my laptop was asleep never fired",
    a: "Timers don't tick through system sleep. The app re-derives its whole schedule the moment the tab becomes visible again, so the missed nag fires on your return — but it can't wake a sleeping machine.",
  },
  {
    q: "Notifications are blocked",
    a: "If the permission row above says Blocked, the browser is refusing on your behalf. Click the icon left of the address bar, find Notifications, set it to Allow, and reload. The row flips to OK when it's fixed.",
  },
  {
    q: "Nothing is syncing between devices",
    a: "Sync needs a configured Supabase project (see the repo's supabase/README) and the Pause switch off on every device. When two devices disagree, the most recent edit wins.",
  },
];

function TroubleshootItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ts-item">
      <button
        type="button"
        className="ts-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`section-chevron${open ? "" : " collapsed"}`}>
          <Icon name="chevron" size={14} strokeWidth={2.4} />
        </span>
        {q}
      </button>
      {open ? <p className="ts-body">{a}</p> : null}
    </div>
  );
}
