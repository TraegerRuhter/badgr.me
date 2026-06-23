-- Phase 0 schema (spec §4): tasks + nag_events, plus the trigger that keeps
-- updated_at honest for last-write-wins sync conflict resolution (spec §5).

create extension if not exists pgcrypto;

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  fire_at timestamptz not null,
  nag_interval_seconds integer not null check (nag_interval_seconds > 0),
  nag_max_count integer check (nag_max_count > 0),
  nag_until timestamptz,
  escalation_mode text not null default 'none'
    check (escalation_mode in ('none', 'shrink', 'sound')),
  completed_at timestamptz,
  dismissed_at timestamptz,
  repeat_rule text,
  priority integer not null default 0,
  device_origin text not null check (device_origin in ('mobile', 'web')),
  deleted_at timestamptz
);

create index if not exists tasks_fire_at_idx on tasks (fire_at) where deleted_at is null;
create index if not exists tasks_updated_at_idx on tasks (updated_at);

create table if not exists nag_events (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks (id) on delete cascade,
  scheduled_for timestamptz not null,
  fired boolean not null default false,
  acknowledged boolean not null default false
);

create index if not exists nag_events_task_id_idx on nag_events (task_id);

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger tasks_set_updated_at
  before update on tasks
  for each row
  execute function set_updated_at();

-- Single-user app (spec explicitly excludes multi-user/sharing): there's no
-- per-row owner column, so RLS just gates access behind authentication
-- rather than partitioning rows by user id.
alter table tasks enable row level security;
alter table nag_events enable row level security;

create policy "authenticated users can read tasks"
  on tasks for select
  using (auth.uid() is not null);

create policy "authenticated users can write tasks"
  on tasks for all
  using (auth.uid() is not null)
  with check (auth.uid() is not null);

create policy "authenticated users can read nag_events"
  on nag_events for select
  using (auth.uid() is not null);

create policy "authenticated users can write nag_events"
  on nag_events for all
  using (auth.uid() is not null)
  with check (auth.uid() is not null);
