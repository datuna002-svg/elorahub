-- Run this once in your Supabase project's SQL editor (Supabase dashboard
-- → SQL Editor → New query → paste this whole file → Run).
-- See SUPABASE-SETUP.md for the full step-by-step setup.

-- Who has elevated access to the owner console, beyond an ordinary
-- signed-in user. Only rows in here (checked server-side, never trusted
-- from the browser) can see admin data.
create table if not exists public.roles (
  email text primary key,
  role text not null check (role in ('owner', 'administrator', 'moderator')),
  added_at timestamptz not null default now()
);

-- Seed the owner. Change the email below FIRST if this isn't your real
-- owner address, then run the file.
insert into public.roles (email, role)
values ('datuna002@gmail.com', 'owner')
on conflict (email) do update set role = 'owner';

-- Real system/error events, written by the serverless functions
-- themselves whenever something actually goes wrong (or, for testing,
-- from the owner console's "test event" button). No fake/seeded rows —
-- an empty table just means nothing has gone wrong yet.
create table if not exists public.error_logs (
  id bigserial primary key,
  level text not null default 'info' check (level in ('info', 'warning', 'error')),
  source text,
  message text not null,
  created_at timestamptz not null default now()
);

create index if not exists error_logs_created_at_idx on public.error_logs (created_at desc);

-- Lock both tables down by Row Level Security. The service role key
-- (used only by the serverless functions in /api, never sent to the
-- browser) bypasses RLS automatically, so this is what actually makes
-- "only the server can read/write this" true — not just a UI check.
alter table public.roles enable row level security;
alter table public.error_logs enable row level security;
-- No policies are added on purpose: with RLS on and zero policies, every
-- request using the public anon key is denied by default. Only the
-- service-role-key requests from your /api functions can reach these
-- tables at all.
