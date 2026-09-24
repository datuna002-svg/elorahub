-- Run this once in your Supabase project's SQL editor, same way as
-- supabase-schema.sql (Supabase dashboard → SQL Editor → New query →
-- paste this whole file → Run). This adds the real credits/plan system:
-- Private subscribers get 500 chat credits, Premium get 1500, refilled
-- each time Paddle tells us their subscription renewed.

create table if not exists public.subscriptions (
  email text primary key,
  plan text not null default 'free' check (plan in ('free', 'private', 'premium')),
  credits_total integer not null default 0,
  credits_remaining integer not null default 0,
  paddle_subscription_id text,
  updated_at timestamptz not null default now()
);

-- Locked down the same way as roles/error_logs: only the service-role
-- key (used server-side in /api/paddle-webhook.js and /api/chat.js)
-- can read or write this table. The browser never touches it directly.
alter table public.subscriptions enable row level security;
-- No policies added on purpose — see supabase-schema.sql for why that's
-- correct, not an oversight.

-- Atomically takes 1 credit, so two chat messages sent at the same
-- moment can't both read "5 left" and both write back "4" (losing a
-- decrement). Returns the row's new credits_remaining, or null if they
-- had none left (or no row exists for that email).
create or replace function public.spend_one_credit(user_email text)
returns integer
language sql
security definer
set search_path = public
as $$
  update public.subscriptions
  set credits_remaining = credits_remaining - 1,
      updated_at = now()
  where email = lower(user_email)
    and credits_remaining > 0
  returning credits_remaining;
$$;
