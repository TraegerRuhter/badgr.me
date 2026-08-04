-- Pre-alarm lead time (docs/plans/due-parity-build-plan.md §3.6): seconds of
-- heads-up before a task's fire time, mirroring `leadTimeSeconds` on the shared
-- `Task` type. Null means no pre-alarm, which is what every existing row wants.
--
-- The pre-alarm costs a notification slot, so both clients account for it in
-- `allocateNotificationBudget` before scheduling (invariant U6).

alter table tasks
  add column if not exists lead_time_seconds integer;
