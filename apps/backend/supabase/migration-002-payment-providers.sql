-- ============================================================
-- MODLai Migration 002: Payment Provider Abstraction
-- Run AFTER schema.sql and schema-storage.sql
--
-- What this adds:
--  * system_settings table (global switches, e.g. active_payment_provider)
--  * credit_packages table (single source of truth, shared across providers)
--  * payments.provider column (stripe | balance)
--  * payments.external_id (generic ID; replaces stripe_payment_intent_id usage)
--  * payments.invoice_url, due_date, paid_at (for Balance Net terms)
-- ============================================================

-- ─────────────────────────────────────────────
-- 1. SYSTEM SETTINGS (key-value config)
-- ─────────────────────────────────────────────
create table if not exists public.system_settings (
  key         text primary key,
  value       jsonb not null,
  description text,
  updated_by  uuid references public.users(id),
  updated_at  timestamptz not null default now()
);

-- Seed defaults
insert into public.system_settings (key, value, description) values
  ('active_payment_provider', '"stripe"'::jsonb, 'Which PG handles checkout: stripe | balance'),
  ('balance_terms_days',      '30'::jsonb,       'Default Net terms for Balance (30/60/90)'),
  ('signup_bonus_credits',    '100'::jsonb,      'Credits granted on new signup')
on conflict (key) do nothing;

alter table public.system_settings enable row level security;

-- Everyone can read (so frontend knows which provider is active)
create policy sys_settings_read_all on public.system_settings
  for select using (true);

-- Only admins can write
create policy sys_settings_admin_write on public.system_settings
  for all using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

-- ─────────────────────────────────────────────
-- 2. CREDIT PACKAGES (shared source of truth)
-- ─────────────────────────────────────────────
create table if not exists public.credit_packages (
  id            text primary key,              -- 'starter' | 'pro' | 'studio' | ...
  credits       int  not null,
  amount_cents  int  not null,
  currency      text not null default 'usd',
  label         text not null,
  is_enterprise boolean not null default false, -- if true, only available via Balance
  is_active     boolean not null default true,
  sort_order    int  not null default 0,
  created_at    timestamptz not null default now()
);

insert into public.credit_packages (id, credits, amount_cents, label, is_enterprise, sort_order) values
  ('starter', 500,    900,   '500 credits',    false, 10),
  ('pro',     2500,   3900,  '2,500 credits',  false, 20),
  ('studio',  10000,  12900, '10,000 credits', false, 30),
  ('enterprise_50k', 50000, 59900, '50,000 credits · Net 30', true, 40)
on conflict (id) do nothing;

alter table public.credit_packages enable row level security;

-- Everyone can read active packages
create policy packages_read_active on public.credit_packages
  for select using (is_active or public.is_admin(auth.uid()));

-- Only admins can write
create policy packages_admin_write on public.credit_packages
  for all using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

-- ─────────────────────────────────────────────
-- 3. PAYMENTS table - add provider abstraction
-- ─────────────────────────────────────────────
alter table public.payments
  add column if not exists provider text
    check (provider in ('stripe', 'balance'))
    default 'stripe',
  add column if not exists external_id text,
  add column if not exists invoice_url text,
  add column if not exists due_date timestamptz,
  add column if not exists paid_at timestamptz,
  add column if not exists terms_days int;

-- Backfill external_id from stripe_payment_intent_id
update public.payments
   set external_id = stripe_payment_intent_id,
       provider    = 'stripe'
 where external_id is null;

-- Add unique index on (provider, external_id)
drop index if exists payments_stripe_pi_unique;
create unique index if not exists payments_provider_external_uniq
  on public.payments(provider, external_id)
  where external_id is not null;

-- ─────────────────────────────────────────────
-- 4. Extend credit_transactions with provider
-- ─────────────────────────────────────────────
alter table public.credit_transactions
  add column if not exists provider text;

-- ─────────────────────────────────────────────
-- 5. Admin action log (for audit)
-- ─────────────────────────────────────────────
create table if not exists public.admin_actions (
  id         uuid primary key default uuid_generate_v4(),
  admin_id   uuid not null references public.users(id),
  action     text not null,     -- 'set_provider', 'grant_credits', 'block_user', 'refund', etc
  target_id  text,              -- user id, payment id, etc
  details    jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists admin_actions_admin_idx  on public.admin_actions(admin_id, created_at desc);
create index if not exists admin_actions_target_idx on public.admin_actions(target_id);

alter table public.admin_actions enable row level security;

create policy admin_actions_admin_read on public.admin_actions
  for select using (public.is_admin(auth.uid()));

-- ─────────────────────────────────────────────
-- 6. HELPER: Get active payment provider
-- ─────────────────────────────────────────────
create or replace function public.get_active_payment_provider()
returns text
language sql
stable
as $$
  select (value #>> '{}')::text
    from public.system_settings
   where key = 'active_payment_provider'
   limit 1;
$$;
