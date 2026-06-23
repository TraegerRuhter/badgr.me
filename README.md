# Alarmed

A reminder app that keeps nagging until you actually deal with it. Native
iPhone app (sideloaded, no Mac/Apple Developer account required) plus a
synced browser companion. See the full spec in the original task description
for the architecture and phased roadmap.

## Status

Phase 1 — local CRUD + the scheduler, on both clients. Both apps persist
tasks to a local store and schedule real nag notifications: each pre-arms a
budget-respecting burst per task, cancels a task's remaining nags when it's
completed, and never exceeds the shared notification budget. The
notification-planning math lives in `@alarmed/core` with unit tests; the
Expo app wires it to `expo-sqlite` + `expo-notifications`, and the PWA wires
the same plan to `localStorage` + the browser Notification API. Both UIs are
built from the same `@alarmed/ui` tokens, so they look and behave the same.

The native app's burst survives a force-close (the OS owns the schedule); the
PWA's nags only fire while its tab/window stays open, since closing that gap
needs a push backend. See `apps/mobile/README.md` and `apps/web/README.md`
for each platform's specifics. Sync to Supabase is Phase 3. No notification
action buttons or escalation yet (Phase 2).

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
