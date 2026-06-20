# Alarmed

A reminder app that keeps nagging until you actually deal with it. Native
iPhone app (sideloaded, no Mac/Apple Developer account required) plus a
synced browser companion. See the full spec in the original task description
for the architecture and phased roadmap.

## Status

Phase 0 — skeleton. `@alarmed/core` has the task types, validation, and the
nag-burst/notification-budget math (with tests); both apps render the same
hardcoded task list from it. No persistence, sync, or real notifications yet.

## Structure

```
packages/
  core/   shared types, nag math, zod validation, sample fixtures
  ui/     shared design tokens (colors, spacing, typography)
apps/
  mobile/ Expo (React Native) app
  web/    Vite React PWA
supabase/ schema + RLS migrations (see supabase/README.md to apply)
```

## Development

Requires Node 20+ and pnpm.

```
pnpm install

pnpm --filter @alarmed/core test       # nag-math unit tests
pnpm --filter @alarmed/web dev         # PWA dev server
pnpm --filter @alarmed/mobile start    # Expo dev server (scan QR with Expo Go)
```
