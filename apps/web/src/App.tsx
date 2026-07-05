import {
  planNagNotifications,
  refreshNextOccurrenceCopy,
  swipeActionFor,
  type AppSettings,
  type EscalationMode,
  type Task,
} from "@alarmed/core";
import { useCallback, useEffect, useMemo, useState } from "react";

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

  // Pending notifications grouped by task, derived from the same pure planner
  // the scheduler uses — so the counts shown match what's actually armed.
  const plannedByTask = useMemo(() => {
    const grouped = new Map<string, number>();
    for (const planned of planNagNotifications(tasks)) {
      grouped.set(planned.taskId, (grouped.get(planned.taskId) ?? 0) + 1);
    }
    return grouped;
  }, [tasks]);

  const syncFromDb = useCallback(async () => {
    const loaded = await listTasks();
    const { scheduledCount } = await rescheduleAllNotifications(loaded);
    setTasks(loaded);
    setArmedCount(scheduledCount);
  }, []);

  // Best-effort Supabase reconcile: push local edits up, pull remote ones down,
  // then refresh the local view. Runs in the background so the UI never blocks
  // on the network, and swallows failures so the app stays offline-first.
  const backgroundSync = useCallback(() => {
    if (!syncEnabled) return;
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
      if (event.key === null || event.key === SETTINGS_KEY)
        setSettings(loadSettings());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [syncFromDb]);

  const updateSettings = useCallback((next: AppSettings) => {
    setSettings(next);
    saveSettings(next);
  }, []);

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
        const updated = await snoozeTask(taskId);
        if (!updated) return;
        // Best-effort: the resync above already re-armed every occurrence with
        // the offline-safe template-ladder line. If the nag-ai proxy is
        // reachable, overlay a fresher line onto just the next one — shared
        // core helper guards against resurrecting a task dealt with meanwhile.
        void refreshNextOccurrenceCopy(updated, {
          generator: nagCopyGenerator,
          getTask,
          scheduleNextOccurrence: overlayNextOccurrenceCopy,
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

      <ul className="task-list">
        {tasks.length === 0 ? (
          <li className="empty-note">No tasks yet — add one above.</li>
        ) : (
          tasks.map((task) => (
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
          ))
        )}
      </ul>

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
            <p className="setting-desc">
              Drag a task card sideways to act on it.
            </p>
          </div>
          <Switch
            checked={g.swipeEnabled}
            label="Swipe on tasks"
            onChange={(swipeEnabled) =>
              onChange({ gestures: { ...g, swipeEnabled } })
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
              onChange({ gestures: { ...g, swapDirections } })
            }
          />
        </div>
      </aside>
    </>
  );
}
