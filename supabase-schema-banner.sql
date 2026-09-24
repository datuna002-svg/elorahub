-- Run this once in Supabase's SQL Editor, same way as the other
-- supabase-schema-*.sql files. Adds the sitewide announcement banner
-- shown to every visitor when an administrator turns it on.

create table if not exists public.site_banner (
  id boolean primary key default true,
  enabled boolean not null default false,
  message text not null default '',
  updated_at timestamptz not null default now(),
  constraint site_banner_singleton check (id)
);

-- Seed the single row so the first GET has something to read.
insert into public.site_banner (id, enabled, message)
values (true, false, '')
on conflict (id) do nothing;

-- Locked down the same way as roles/error_logs/subscriptions: only the
-- service-role key (used server-side in /api/banner.js) can read or
-- write this table directly. The public-facing part still works because
-- GET /api/banner is a serverless function using that key — the browser
-- never queries Supabase for this table itself.
alter table public.site_banner enable row level security;
