# badgr.me

A reminder app that keeps badgering you until you actually deal with it.
(Internal package scope remains `@alarmed/*` — the app's original working
name — since renaming packages churns every import for zero user value.) Native
iPhone app (sideloaded, no Mac/Apple Developer account required) plus a
synced browser companion. See the full spec in the original task description
for the architecture and phased roadmap.

## Status

Phase 1 (local CRUD + the scheduler) and Phase 2 (actions + escalation) are
both done, on both clients. Each app persists tasks to a local store and
schedules real nag notifications: each pre-arms a budget-respecting burst per
task, cancels a task's remaining nags when it's completed, and never exceeds
the shared notification budget. The notification-planning math lives in
`@alarmed/core` with unit tests; the Expo app wires it to `expo-sqlite` +
`expo-notifications`, and the PWA wires the same plan to `localStorage` + the
browser Notification API. Both UIs are built from the same `@alarmed/ui`
tokens, so they look and behave the same.

The native app's burst survives a force-close (the OS owns the schedule); the
PWA's nags only fire while its tab/window stays open, since closing that gap
needs a push backend. See `apps/mobile/README.md` and `apps/web/README.md`
for each platform's specifics.

Phase 3 adds optional Supabase sync. With a project configured, both clients
best-effort reconcile against Postgres on launch and after every change —
local edits push up, remote edits pull down, last-write-wins on `updatedAt`,
soft-deletes converge. The pure engine (`reconcileTasks`/`syncTasks`) lives in
`@alarmed/core`; the Supabase client and row mapping in `@alarmed/supabase`;
each app plugs in its own local store. Sync runs in the background and never
blocks the UI, so the app stays offline-first — leave the env vars unset and
it behaves exactly as before. See `supabase/README.md` to turn it on.

Phase 2 adds Done/Snooze actions and escalating nag copy: every pre-scheduled
notification's body comes from a deterministic, Carrot-style phrase-bank
ladder in `@alarmed/core` (`generateTemplateCopy`) that sharpens with each
snooze, and snoozing best-effort asks `services/nag-ai` — a thin proxy that
holds the LLM API key server-side (Groq free tier by default), never in a
client bundle — for a fresher AI-rewritten line for just the immediate next
occurrence, always falling back to the template ladder offline or on any
failure. Mobile gets
real OS-level notification action buttons (`expo-notifications` categories);
the PWA uses in-page Done/Snooze buttons instead, since its `generateSW`
service-worker strategy can't hook `notificationclick`.

## Structure

```
packages/
  core/     shared types, nag math, notification planning, copy/escalation, sync engine, validation
  ui/       shared design tokens (colors, spacing, typography)
  supabase/ Supabase client + Task<->row mapping + anon auth (the remote half of sync)
apps/
  mobile/ Expo (React Native) app — SQLite store + notification scheduler
  web/    Vite React PWA
services/
  nag-ai/ proxy holding the LLM API key server-side; rewrites one nag line per request
supabase/ schema + RLS migrations (see supabase/README.md to apply)
```

## Design

Both clients share one visual identity — a badger's coat: charcoal-fur
surfaces, the cream head-stripe for text, silvered grey for secondary,
and one honey-amber accent (honey badger energy) — built from the
tokens and the hand-drawn 24×24 stroke icon set in `@alarmed/ui`
(rendered as inline SVG on web, react-native-svg on mobile). Task rows
support swipe gestures on both platforms (right completes, left snoozes,
done rows swipe back open); the in-app Settings panel can disable
swiping or swap the directions, persisted per device and shaped/salvaged
by the shared `AppSettings` model in `@alarmed/core`.

## Live deployment

The PWA deploys to GitHub Pages on every push to `main`
(`.github/workflows/deploy.yml`): https://traegerruhter.github.io/badgr.me/
The Supabase URL + anon key baked into that build are public by design —
RLS gates access, not key secrecy.

## Development

Requires Node 22+ and pnpm.

```
pnpm install

pnpm --filter @alarmed/core test       # nag-math + notification-planning tests
pnpm --filter @alarmed/web dev         # PWA dev server
pnpm --filter @alarmed/mobile start    # Expo dev server (scan QR with Expo Go)
```

Note: notifications and SQLite are native modules. Expo Go can't fully exercise
scheduled-notification behavior, so verifying the nag mechanic needs a
development/preview build (see `apps/mobile/README.md`).
