# Supabase setup

Phase 0 ships the schema as a plain SQL migration; there's no live project
wired up yet (that needs your own Supabase account/keys).

To stand it up:

1. Create a free project at https://supabase.com.
2. Open the SQL Editor and run `migrations/20260620000000_init.sql`, or install
   the Supabase CLI and run `supabase link` + `supabase db push` from this
   directory.
3. Enable email or anonymous auth (Authentication → Providers) — RLS on
   `tasks`/`nag_events` requires `auth.uid()` to be set, since this is a
   single-user app with no per-row owner column.
4. Copy the project URL and anon key into `apps/web/.env.local` and the
   mobile app's Expo config once the Supabase client is wired up (Phase 3).
