# @alarmed/web

The Vite React PWA — same task list, same nag mechanic, same look as
`@alarmed/mobile`. Both clients are thin shells around the same
`@alarmed/core` planning logic and `@alarmed/ui` design tokens; only the
on-device storage and notification queue underneath differ.

## What's identical to the native app

- **UI**: `src/App.tsx` mirrors `apps/mobile/App.tsx` element-for-element —
  same header/armed-count copy, same quick-add presets, same task row layout
  (title, fire/interval/armed caption, Done/Reopen/Delete actions), same
  empty and loading states. Styling is built from the exact same
  `colors`/`spacing`/`typography` constants in `@alarmed/ui`, so values match
  to the pixel rather than just "look similar."
- **Data model and CRUD**: `src/db/database.ts` exposes the same
  `initDatabase` / `listTasks` / `createTask` / `completeTask` / `reopenTask`
  / `deleteTask` surface as the mobile SQLite store (`deviceOrigin: "web"`
  instead of `"mobile"`), backed by `localStorage` instead of SQLite.
- **Notification planning**: `src/notifications/scheduler.ts` feeds the same
  `planNagNotifications` plan from `@alarmed/core` that the native scheduler
  uses, so which nags fire, in what order, and within what budget is
  identical on both platforms.

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

## Running it

```
pnpm --filter @alarmed/web dev         # Vite dev server
pnpm --filter @alarmed/web typecheck   # tsc -b --noEmit
pnpm --filter @alarmed/web build       # production build + PWA precache
```

Grant the browser's notification permission prompt to see armed nags fire
while the tab is open.
