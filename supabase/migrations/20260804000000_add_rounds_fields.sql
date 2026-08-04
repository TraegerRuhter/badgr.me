-- Rounds — intra-day recurrence (docs/plans/due-parity-build-plan.md §3.4):
-- the reminder itself fires again every rounds_interval_seconds, capped by
-- count or by a duration measured from fire_at, mirroring the
-- `roundsIntervalSeconds` / `roundsMaxCount` / `roundsDurationSeconds` fields
-- on the shared `Task` type. Null means Rounds is off, which is what every
-- existing row wants. Not Due's "DayMinder", and not "Burst"
-- (computeNagBurst already owns that word) — see plan §9.3.1.
--
-- Rounds fires cost notification slots like the pre-alarm does, so both
-- clients account for them in allocateNotificationBudget (invariant U6).

alter table tasks
  add column if not exists rounds_interval_seconds integer,
  add column if not exists rounds_max_count integer,
  add column if not exists rounds_duration_seconds integer;
