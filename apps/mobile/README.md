# @alarmed/mobile

The Expo (React Native) app — the part of Alarmed that actually pesters you.
This is where the nag mechanic lives, because iOS only lets a real app fire
reliable local notifications.

## Phase 1 scope

- **Local SQLite store** (`src/db/database.ts`) — the on-device source of truth
  for tasks (spec §4.3). Offline create / complete / reopen / soft-delete. The
  scheduler reads from here, never from the network, so nags fire with no signal.
- **Notification scheduler** (`src/notifications/scheduler.ts`) — the only code
  that talks to the OS notification queue (spec §3.2–§3.3). It:
  - pre-schedules a *burst* of dated local notifications per task, so they keep
    firing even when the app is force-closed (iOS won't run a background timer);
  - tags each notification `nag:{taskId}:{index}` so a task's whole burst can be
    cancelled when it's completed/dismissed;
  - recomputes the full pending set on every change and re-arms the device,
    respecting the 64-notification iOS budget across all tasks.
- The *decisions* (which fires, in what order, within budget) are the pure
  `planNagNotifications` / `allocateNotificationBudget` functions in
  `@alarmed/core`, unit-tested there.

Out of scope until later phases: notification action buttons + escalation
(Phase 2), Supabase sync (Phase 3).

## Running it

```
pnpm --filter @alarmed/mobile start      # Metro dev server
pnpm --filter @alarmed/mobile typecheck  # tsc --noEmit
```

**Expo Go is not enough to test the nag.** Scheduled local notifications and
`expo-sqlite` need a real build. Per the spec's no-Mac pipeline (§7), use EAS:

```
eas build --platform ios --profile preview   # IPA, install via AltStore
```

## Manual test plan — prove the nag nags *and* stops

Phase 1's bar (spec §10) is: *"Prove the nag actually nags and actually stops,"*
surviving a force-close. On a real build:

1. Launch the app and **grant** the notification permission prompt.
2. Type a title, tap the **"10s · 30s × 5"** preset. The row should show
   `5 armed` and the header `5 notifications armed`.
3. **Force-close the app** (swipe it away).
4. Wait. A notification fires ~10s later, then again every ~30s — *with the app
   killed*. That's the pre-scheduled burst doing its job.
5. Reopen the app before the 5 fires are done and tap **Done** on the task.
   Its remaining notifications are cancelled; the armed count drops. The nag
   stops.
6. (Budget) Add several aggressive nags at once and confirm the total armed
   count never exceeds 60 — the scheduler caps the global budget.

## Known limits (spec §11)

- **64 pending-notification cap** is a hard OS limit shared across all nags.
- A burst that runs dry before you open the app pauses nagging until next
  launch (foreground re-arm is wired but iOS can't pre-schedule infinitely).
- Critical alerts (break-through DND) aren't available to a free sideloaded
  build.

## Verified in this environment

A device/simulator isn't available here, so behavior was checked by: the
`@alarmed/core` unit tests (planning + budget), a clean `tsc --noEmit`, and a
successful `expo export --platform ios` JS bundle of the full native graph.
On-device firing must be confirmed on a real build per the plan above.
