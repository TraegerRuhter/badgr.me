# Alarmed

A reminder app that keeps nagging until you actually deal with it. Native
iPhone app (sideloaded, no Mac/Apple Developer account required) plus a
synced browser companion. See the full spec in the original task description
for the architecture and phased roadmap.

## Status

Phase 1 — local CRUD + the scheduler. The native app now persists tasks to a
local SQLite store and schedules real nag notifications: it pre-schedules a
burst of local notifications per task (so they keep firing while the app is
closed), cancels a task's remaining nags when it's completed, and respects the
64-notification iOS budget across all tasks. The notification-planning math
lives in `@alarmed/core` with unit tests; the Expo app wires it to
`expo-sqlite` + `expo-notifications`. See `apps/mobile/README.md` for the
on-device test plan.

The web PWA still renders the hardcoded sample list (its turn is Phase 4), and
sync to Supabase is Phase 3. No notification action buttons or escalation yet
(Phase 2).

## Structure

```
packages/
  core/   shared types, nag math, notification planning, validation, fixtures
  ui/     shared design tokens (colors, spacing, typography)
apps/
  mobile/ Expo (React Native) app — SQLite store + notification scheduler
  web/    Vite React PWA
supabase/ schema + RLS migrations (see supabase/README.md to apply)
```

## Development

Requires Node 20+ and pnpm.

```
pnpm install

pnpm --filter @alarmed/core test       # nag-math + notification-planning tests
pnpm --filter @alarmed/web dev         # PWA dev server
pnpm --filter @alarmed/mobile start    # Expo dev server (scan QR with Expo Go)
```

Note: notifications and SQLite are native modules. Expo Go can't fully exercise
scheduled-notification behavior, so verifying the nag mechanic needs a
development/preview build (see `apps/mobile/README.md`).
