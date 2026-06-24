-- Phase 2 (spec §3.4): tracks how many times a task's nag has been snoozed,
-- mirroring the `snoozeCount` field on the shared `Task` type. Drives
-- escalating notification copy on both clients; Supabase sync (Phase 3) will
-- carry it like any other column.

alter table tasks
  add column if not exists snooze_count integer not null default 0;
