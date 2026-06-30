# Supabase setup

The clients are wired for sync (Phase 3) but it's **opt-in**: with no
project configured, both apps run fully offline exactly as before. Point them
at your own Supabase project to turn sync on.

## Stand up the project

1. Create a free project at https://supabase.com.
2. Apply the migrations in `migrations/` in order — open the SQL Editor and run
   each file, or install the Supabase CLI and run `supabase link` +
   `supabase db push` from this directory. They:
   - create the `tasks` / `nag_events` tables and RLS policies (`20260620…`),
   - add `snooze_count` for Phase 2 escalation (`20260624…`),
   - drop the server-side `updated_at` trigger so last-write-wins sync is
     correct (`20260627…`) — see that file's comment for why the trigger
     would otherwise break offline edits.
3. Enable **anonymous** auth (Authentication → Providers → Anonymous). RLS on
   `tasks`/`nag_events` only requires `auth.uid()` to be set — this is a
   single-user app with no per-row owner column — so an anonymous session is
   enough. The clients call `signInAnonymously()` automatically.

## Point the apps at it

Copy your project URL and **anon** key (safe to ship — RLS gates access).

Web — `apps/web/.env.local`:

```
VITE_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ…
```

Mobile — `apps/mobile/.env.local` (Expo inlines `EXPO_PUBLIC_*`):

```
EXPO_PUBLIC_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=eyJ…
```

Leave the URL unset to keep sync off. When set, each app best-effort
reconciles on launch and after every change: local edits push up, remote
edits pull down, last-write-wins on `updatedAt`, soft-deletes converge. Sync
runs in the background and never blocks the UI — failures (offline, auth) are
swallowed so the app stays offline-first.

## How it works

The sync logic is split the same way as the rest of the app: the pure
last-write-wins engine (`reconcileTasks` / `syncTasks`) lives in
`@alarmed/core` and is fully unit-tested; the Supabase client and the
`Task ⇄ row` mapping live in `@alarmed/supabase`; each app supplies its local
store (SQLite on mobile, localStorage on web) as the other half of the sync.
