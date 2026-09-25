-- Run this once in Supabase's SQL Editor, same way as the other
-- supabase-schema-*.sql files. Gives elora real persistent memory: a
-- short, per-user profile of stable facts (name, role, ongoing projects,
-- preferences) that carries across separate conversations, not just
-- within one chat session.

create table if not exists public.user_memory (
  email text primary key,
  summary text not null default '',
  updated_at timestamptz not null default now()
);

-- Locked down the same way as roles/subscriptions/error_logs/site_banner:
-- only the service-role key (used server-side in api/chat.js and
-- api/memory.js) can read or write this table directly.
alter table public.user_memory enable row level security;
