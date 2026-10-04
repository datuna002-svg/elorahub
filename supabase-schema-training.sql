-- Run this once in Supabase's SQL Editor, same way as the other
-- supabase-schema-*.sql files. It turns on "Help train elora":
--
--  * training_consent  — who opted in, and when (proof of consent, GDPR).
--  * training_feedback — every 👍/👎 on a reply. For people who opted in,
--    the rated conversation is saved too (personal details scrubbed first),
--    so it can become training data for elora's own model.
--
-- Locked down like every other table: only the server (service-role key)
-- can read or write. No browser access.

create table if not exists public.training_consent (
  user_id uuid primary key references auth.users(id) on delete cascade,
  consented boolean not null default false,
  policy_version text not null default '2026-10',
  consented_at timestamptz,
  withdrawn_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.training_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  rating text not null check (rating in ('good','bad')),
  reasons text[] not null default '{}',
  mode text not null default 'chat',
  model text not null default '',
  verified boolean not null default false,
  has_content boolean not null default false,
  has_improved boolean not null default false,
  has_rejected boolean not null default false,
  messages jsonb,
  reply text,
  improved text,
  rejected text,
  quality real not null default 0.5,
  status text not null default 'pending' check (status in ('pending','approved','rejected','withdrawn')),
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists training_feedback_status_idx on public.training_feedback (status, created_at desc);
create index if not exists training_feedback_user_idx on public.training_feedback (user_id);

alter table public.training_consent enable row level security;
alter table public.training_feedback enable row level security;
-- No policies on purpose: browser requests can't read or write these tables.
