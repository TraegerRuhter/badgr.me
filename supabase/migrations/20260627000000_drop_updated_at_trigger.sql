-- Phase 3 (spec §5): make last-write-wins sync correct.
--
-- The init migration's BEFORE UPDATE trigger stamped updated_at = now() on the
-- *server* for every write. That silently breaks LWW for offline edits: a
-- client that edited a row at T1 while offline and pushes it at T3 would have
-- its row restamped T3, so it would wrongly beat another device's later edit
-- made at T2 (T1 < T2 < T3). The client is the source of truth for when an
-- edit happened, and both clients already set updated_at on every mutation, so
-- the trigger is both redundant and harmful for sync. Drop it.
--
-- updated_at keeps its `default now()` for direct inserts that don't supply one.

drop trigger if exists tasks_set_updated_at on tasks;
drop function if exists set_updated_at();
