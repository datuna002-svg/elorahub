-- EloraHub workspace cloud sync, daily scheduled tasks, and connector token storage.
-- Run once in Supabase SQL Editor after supabase-schema.sql.
-- All reads/writes go through authenticated serverless functions using the service role.
-- No anon/authenticated policies are intentionally created.

create table if not exists public.user_workspaces (
  user_id uuid primary key references auth.users(id) on delete cascade,
  workspace jsonb not null default '{"schema":1,"projects":[],"artifacts":[],"schedules":[],"skills":[]}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.scheduled_tasks (
  id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  prompt text not null,
  cadence text not null check (cadence in ('daily','weekdays','weekly')),
  timezone text not null default 'UTC',
  next_run_at timestamptz not null,
  enabled boolean not null default true,
  last_run_at timestamptz,
  last_status text not null default 'pending' check (last_status in ('pending','running','succeeded','failed')),
  lease_token uuid,
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
create index if not exists scheduled_tasks_due_idx on public.scheduled_tasks (next_run_at) where enabled = true;
create index if not exists scheduled_tasks_user_idx on public.scheduled_tasks (user_id, updated_at desc);

create table if not exists public.scheduled_task_runs (
  run_id uuid primary key default gen_random_uuid(),
  task_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  prompt text not null,
  result text,
  error text,
  status text not null check (status in ('succeeded','failed')),
  created_at timestamptz not null default now(),
  foreign key (user_id, task_id) references public.scheduled_tasks(user_id, id) on delete cascade
);
create index if not exists scheduled_task_runs_user_idx on public.scheduled_task_runs (user_id, created_at desc);

create table if not exists public.user_connectors (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('google','github')),
  access_token_encrypted text not null,
  refresh_token_encrypted text,
  expires_at timestamptz,
  scopes text[] not null default '{}',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);

alter table public.user_workspaces enable row level security;
alter table public.scheduled_tasks enable row level security;
alter table public.scheduled_task_runs enable row level security;
alter table public.user_connectors enable row level security;
-- No policies: browser requests cannot read or write these tables directly.
