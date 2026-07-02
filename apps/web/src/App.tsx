import { planNagNotifications, refreshNextOccurrenceCopy, type EscalationMode, type Task } from "@alarmed/core";
import { colors, spacing, typography } from "@alarmed/ui";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";

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
import { runSync, syncEnabled } from "./sync/supabase";
import {
  overlayNextOccurrenceCopy,
  rescheduleAllNotifications,
  requestNotificationPermissions,
} from "./notifications/scheduler";
import "./App.css";

interface Preset {
  label: string;
  firstDelayMs: number;
  intervalSeconds: number;
  nagMaxCount: number;
  escalationMode?: EscalationMode;
}

// Quick-add presets — same set as the native app's, so a task built from a
// given preset behaves identically on either platform.
const PRESETS: Preset[] = [
  { label: "10s · 30s × 5", firstDelayMs: 10_000, intervalSeconds: 30, nagMaxCount: 5 },
  { label: "1m · 1h × 6", firstDelayMs: 60_000, intervalSeconds: 3600, nagMaxCount: 6 },
  {
    label: "Shrink · 10s × 6",
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

  // `storage` fires here when *another* tab (same origin) writes the store —
  // reload so every open tab renders the same list and re-arms matching
  // timers. The Notification `tag` dedupes the actual pop-ups across tabs, so
  // converging the timers is safe. A null key means localStorage.clear().
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === STORAGE_KEY) void syncFromDb();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [syncFromDb]);

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
      <div style={styles.page}>
        <div style={styles.center}>
          <div className="spinner" style={{ color: colors.accent }} />
          <p style={styles.caption}>Opening local store…</p>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <div style={styles.container}>
        <h1 style={styles.header}>Alarmed</h1>
        <p style={styles.subheader}>
          {armedCount} notification{armedCount === 1 ? "" : "s"} armed
          {permissionGranted === false ? " · notifications denied" : ""}
        </p>

        {permissionGranted === false ? (
          <p style={styles.warning}>
            Notification permission is off, so nags can&apos;t fire. Enable it
            in your browser settings.
          </p>
        ) : null}
        {error ? <p style={styles.warning}>{error}</p> : null}

        <div style={styles.composer}>
          <input
            style={styles.input}
            placeholder="What should nag you?"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <div style={styles.presetRow}>
            {PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                style={styles.presetButton}
                onClick={() => addPreset(preset)}
              >
                <span style={styles.presetButtonText}>{preset.label}</span>
              </button>
            ))}
          </div>
        </div>

        <ul style={styles.list}>
          {tasks.length === 0 ? (
            <li style={styles.caption}>No tasks yet — add one above.</li>
          ) : (
            tasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                pendingCount={plannedByTask.get(task.id) ?? 0}
                onComplete={() => runMutation(() => completeTask(task.id))}
                onReopen={() => runMutation(() => reopenTask(task.id))}
                onDelete={() => runMutation(() => deleteTask(task.id))}
                onSnooze={() => handleSnooze(task.id)}
              />
            ))
          )}
        </ul>
      </div>
    </div>
  );
}

interface TaskRowProps {
  task: Task;
  pendingCount: number;
  onComplete: () => void;
  onReopen: () => void;
  onDelete: () => void;
  onSnooze: () => void;
}

function TaskRow({ task, pendingCount, onComplete, onReopen, onDelete, onSnooze }: TaskRowProps) {
  const done = task.completedAt != null;
  return (
    <li style={styles.row}>
      <p style={done ? { ...styles.title, ...styles.titleDone } : styles.title}>
        {task.title}
      </p>
      <p style={styles.caption}>
        {done
          ? `Done ${formatDateTime(task.completedAt as string)}`
          : `Fires ${formatDateTime(task.fireAt)} · every ${formatInterval(
              task.nagIntervalSeconds
            )} · ${pendingCount} armed`}
      </p>
      <div style={styles.actions}>
        {done ? (
          <button type="button" style={styles.action} onClick={onReopen}>
            <span style={styles.actionText}>Reopen</span>
          </button>
        ) : (
          <>
            <button type="button" style={styles.action} onClick={onComplete}>
              <span style={styles.actionText}>Done</span>
            </button>
            <button type="button" style={styles.action} onClick={onSnooze}>
              <span style={styles.actionText}>Snooze</span>
            </button>
          </>
        )}
        <button type="button" style={styles.action} onClick={onDelete}>
          <span style={{ ...styles.actionText, ...styles.deleteText }}>Delete</span>
        </button>
      </div>
    </li>
  );
}

const styles: Record<string, CSSProperties> = {
  page: {
    minHeight: "100svh",
    backgroundColor: colors.background,
  },
  container: {
    maxWidth: 480,
    margin: "0 auto",
    paddingTop: 60,
    paddingBottom: spacing.xl,
  },
  center: {
    minHeight: "100svh",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
  },
  header: {
    ...typography.title,
    fontSize: 28,
    margin: 0,
    paddingLeft: spacing.md,
    paddingRight: spacing.md,
    color: colors.textPrimary,
  },
  subheader: {
    ...typography.caption,
    margin: 0,
    marginTop: spacing.xs,
    marginBottom: spacing.md,
    paddingLeft: spacing.md,
    paddingRight: spacing.md,
    color: colors.textSecondary,
  },
  warning: {
    ...typography.caption,
    margin: 0,
    marginBottom: spacing.sm,
    marginLeft: spacing.md,
    marginRight: spacing.md,
    color: colors.danger,
  },
  composer: {
    paddingLeft: spacing.md,
    paddingRight: spacing.md,
    marginBottom: spacing.md,
  },
  input: {
    ...typography.body,
    display: "block",
    boxSizing: "border-box",
    width: "100%",
    backgroundColor: colors.surface,
    border: `1px solid ${colors.border}`,
    borderRadius: 8,
    paddingLeft: spacing.md,
    paddingRight: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    color: colors.textPrimary,
  },
  presetRow: {
    display: "flex",
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  presetButton: {
    flex: 1,
    backgroundColor: colors.accent,
    border: "none",
    borderRadius: 8,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    cursor: "pointer",
  },
  presetButtonText: {
    ...typography.body,
    color: colors.onAccent,
    fontWeight: 600,
  },
  list: {
    listStyle: "none",
    margin: 0,
    paddingLeft: spacing.md,
    paddingRight: spacing.md,
    paddingBottom: spacing.xl,
  },
  row: {
    backgroundColor: colors.surface,
    borderRadius: 8,
    padding: spacing.md,
    marginBottom: spacing.sm,
    border: `1px solid ${colors.border}`,
  },
  title: {
    ...typography.body,
    margin: 0,
    fontWeight: 600,
    color: colors.textPrimary,
  },
  titleDone: {
    textDecorationLine: "line-through",
    color: colors.textSecondary,
  },
  caption: {
    ...typography.caption,
    margin: 0,
    marginTop: spacing.xs,
    color: colors.textSecondary,
  },
  actions: {
    display: "flex",
    flexDirection: "row",
    gap: spacing.lg,
    marginTop: spacing.sm,
  },
  action: {
    background: "none",
    border: "none",
    cursor: "pointer",
    paddingTop: spacing.xs,
    paddingBottom: spacing.xs,
    paddingLeft: 0,
    paddingRight: 0,
  },
  actionText: {
    ...typography.body,
    color: colors.accent,
    fontWeight: 600,
  },
  deleteText: {
    color: colors.danger,
  },
};
