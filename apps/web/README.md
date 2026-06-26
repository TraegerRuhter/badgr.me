# @alarmed/web

The Vite React PWA — same task list, same nag mechanic, same look as
`@alarmed/mobile`. Both clients are thin shells around the same
`@alarmed/core` planning logic and `@alarmed/ui` design tokens; only the
on-device storage and notification queue underneath differ.

## What's identical to the native app

- **UI**: `src/App.tsx` mirrors `apps/mobile/App.tsx` element-for-element —
  same header/armed-count copy, same quick-add presets, same task row layout
  (title, fire/interval/armed caption, Done/Snooze/Reopen/Delete actions),
  same empty and loading states. Styling is built from the exact same
  `colors`/`spacing`/`typography` constants in `@alarmed/ui`, so values match
  to the pixel rather than just "look similar."
- **Data model and CRUD**: `src/db/database.ts` exposes the same
  `initDatabase` / `listTasks` / `createTask` / `completeTask` / `reopenTask`
  / `deleteTask` / `snoozeTask` surface as the mobile SQLite store
  (`deviceOrigin: "web"` instead of `"mobile"`), backed by `localStorage`
  instead of SQLite.
- **Notification planning**: `src/notifications/scheduler.ts` feeds the same
  `planNagNotifications` plan from `@alarmed/core` that the native scheduler
  uses, so which nags fire, in what order, and within what budget is
  identical on both platforms.
- **Escalating copy**: the same `generateTemplateCopy` ladder from
  `@alarmed/core` drives every notification's body, and snoozing best-effort
  asks the `services/nag-ai` proxy for a fresher line, exactly like mobile —
  see `src/copy/nagAi.ts`.

## What's different, and why

Browsers have no equivalent to iOS's pre-scheduled local-notification queue.
The web scheduler arms plain `setTimeout`s that fire a `Notification` while
this tab stays open; there's no backend push service wired up yet, so:

- **Closing or reloading the tab drops any pending nags.** The native app's
  burst survives a force-close because the OS owns the schedule; the web
  version does not survive the page unloading.
- A nag fires only while the PWA (tab or installed window) is open in the
  background — minimized is fine, closed is not.

Closing this gap needs a push backend (Web Push + a server to trigger it),
which is Supabase sync (Phase 3) territory, not a web-only fix.

- **No native notification action buttons.** Real OS-level action buttons on
  a web notification (`actions` on `ServiceWorkerRegistration.showNotification`,
  handled via the service worker's `notificationclick` event) need a custom
  service worker. This app uses `vite-plugin-pwa`'s `generateSW` strategy,
  which doesn't let us hook that event, so Done/Snooze here are in-page
  buttons on the task row instead of buttons on the notification itself.
  Mobile's notifications get real action buttons because `expo-notifications`
  owns the OS-level category API directly.

## Running it

```
pnpm --filter @alarmed/web dev         # Vite dev server
pnpm --filter @alarmed/web typecheck   # tsc -b --noEmit
pnpm --filter @alarmed/web build       # production build + PWA precache
```

Grant the browser's notification permission prompt to see armed nags fire
while the tab is open.

To enable AI-rewritten snooze copy, point the app at a running
`services/nag-ai` instance (see its README) via Vite's client-readable env
vars, e.g. in `apps/web/.env.local`:

```
VITE_NAG_AI_ENDPOINT=https://your-proxy.example.com/v1/nag-copy
VITE_NAG_AI_SHARED_SECRET=topsecret   # optional, must match the proxy
```

Leave `VITE_NAG_AI_ENDPOINT` unset to skip the AI step entirely and rely
solely on the template ladder.
