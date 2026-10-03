-- Bank of Georgia payments (elorahub's own checkout).
-- Run once in Supabase: dashboard → SQL Editor → New query → paste → Run.
-- Safe to run more than once.

create extension if not exists pgcrypto;

-- Every payment attempt: the first purchase and each automatic renewal.
create table if not exists public.bog_orders (
  order_id text primary key,                 -- Bank of Georgia's order id
  external_id text not null unique,          -- elorahub's reference (shown in bank statements)
  email text not null,
  plan text not null check (plan in ('private', 'premium')),
  cycle text not null check (cycle in ('monthly', 'yearly')),
  kind text not null default 'initial' check (kind in ('initial', 'renewal')),
  status text not null default 'created',    -- created / processing / completed / rejected / refunded ...
  amount numeric(10, 2) not null,
  currency text not null default 'USD',
  card_saved boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists bog_orders_email_idx on public.bog_orders (email);
create index if not exists bog_orders_status_idx on public.bog_orders (status, kind, created_at);

-- One subscription per account. Renewed automatically with the saved card.
create table if not exists public.bog_subscriptions (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  plan text not null check (plan in ('private', 'premium')),
  cycle text not null check (cycle in ('monthly', 'yearly')),
  status text not null default 'active' check (status in ('active', 'past_due', 'canceled', 'expired')),
  parent_order_id text,                      -- order whose saved card is charged on renewal
  card_type text,
  amount numeric(10, 2) not null,
  currency text not null default 'USD',
  current_period_end timestamptz not null,
  cancel_at_period_end boolean not null default false,
  failures integer not null default 0,
  last_attempt_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists bog_subscriptions_due_idx on public.bog_subscriptions (status, current_period_end);

-- Server-only, like the other billing tables: no browser access at all.
alter table public.bog_orders enable row level security;
alter table public.bog_subscriptions enable row level security;
