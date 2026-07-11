-- Undated mode: a task can be parked with no alarm time (spec §4.1, "undated"
-- reminders). Drop the NOT NULL on fire_at so those rows sync. The partial
-- index on fire_at already tolerates NULLs (they're simply not indexed).

alter table tasks
  alter column fire_at drop not null;
