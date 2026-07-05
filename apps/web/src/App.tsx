import {
  DEFAULT_SETTINGS,
  groupTasksIntoSections,
  NAG_TONES,
  planNagNotifications,
  planOptionsFrom,
  refreshNextOccurrenceCopy,
  SETTING_LIMITS,
  swipeActionFor,
  toneLevelOffset,
  type AppSettings,
  type EscalationMode,
  type NagTone,
  type Task,
  type TaskBucket,
} from "@alarmed/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { nagCopyGenerator } from "./copy/nagAi";
import {
  completeTask,
  createTask,
  deleteTask,
  getTask,
  initDatabase,
  listTasks,
  reopenTask,
  snoozeTask,
  STORAGE_KEY,
  type NewTaskInput,
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
  firstDelayMs: number;
  intervalSeconds: number;
  nagMaxCount: number;
  escalationMode?: EscalationMode;
}

// Quick-add presets — same set as the native app's, so a task built from a
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
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<TaskBucket[]>(loadCollapsed);

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

  // The task list grouped into the collapsible time drawers. Recomputed with
  // the list itself; "now" is taken at render, which every mutation refreshes.
  const sections = useMemo(() => groupTasksIntoSections(tasks), [tasks]);

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
          Alarm<em>ed</em>
        </h1>
        <button
          type="button"
          className="icon-btn"
          aria-label="Settings"
          onClick={() => setSettingsOpen(true)}
        >
          <Icon name="sliders" size={20} />
        </button>
      </header>
      <p className="subline">
        {armedCount > 0 ? <span className="armed-dot" aria-hidden="true" /> : null}
        {armedCount} notification{armedCount === 1 ? "" : "s"} armed
        {permissionGranted === false ? " · notifications denied" : ""}
      </p>

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

      {tasks.length === 0 ? (
        <p className="empty-note">No tasks yet — add one above.</p>
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
              </div>
              {isCollapsed ? null : (
                <ul className="task-list">
                  {section.tasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      settings={settings}
                      pendingCount={plannedByTask.get(task.id) ?? 0}
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
    </div>
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

  const { offset, dragging, handlers } = useSwipe({
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
        className={`task-card${done ? " done" : ""}${dragging ? " dragging" : ""}`}
        style={{ transform: `translateX(${offset}px)` }}
        {...handlers}
      >
        <p className="task-title">{task.title}</p>
        <p className="task-meta">
          {done ? (
            <span>Done {formatDateTime(task.completedAt as string)}</span>
          ) : (
            <>
              <span>
                Fires {formatDateTime(task.fireAt)} · every{" "}
                {formatInterval(task.nagIntervalSeconds)}
              </span>
              <span className={`armed-badge${pendingCount === 0 ? " zero" : ""}`}>
                <Icon name="bell" size={11} strokeWidth={2.6} />
                {pendingCount}
              </span>
            </>
          )}
        </p>
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
