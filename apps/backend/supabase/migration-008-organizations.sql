-- ============================================================
-- MODLai Migration 008: Multi-Tenancy (Organizations)
-- Run AFTER migration-007
--
-- Transforms single-user into multi-org architecture:
--   - organizations table (the "tenant")
--   - organization_members (user ↔ org with role)
--   - organization_invitations (email-based invites)
--   - org_id added to EVERY data table
--   - RLS rewritten: user_id ownership → org membership
--
-- Principle: 1 user = 1 org (enforced by unique constraint on
--            organization_members.user_id), except for platform
--            admins (users.is_admin = true) who can access any org.
--
-- Credits move from user → organization pool.
-- ============================================================

-- ─────────────────────────────────────────────
-- ORGANIZATIONS
-- ─────────────────────────────────────────────
create table if not exists public.organizations (
  id                  uuid primary key default uuid_generate_v4(),
  name                text not null,
  slug                text unique,                        -- url-friendly, e.g. 'n41-brands'
  logo_url            text,

  -- Shared credit pool (replaces user-level credits)
  credits_balance     int not null default 0
                        check (credits_balance >= 0),

  -- Billing
  billing_email       text,
  plan                text default 'free'
                        check (plan in ('free', 'starter', 'pro', 'enterprise')),

  -- Settings (JSON for flexibility: default model, style prefs, etc.)
  settings            jsonb default '{}'::jsonb,

  -- Metadata
  created_by          uuid references public.users(id) on delete set null,
  is_active           boolean default true,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists orgs_slug_idx on public.organizations(slug) where slug is not null;

alter table public.organizations enable row level security;

create trigger orgs_touch before update on public.organizations
  for each row execute function public.touch_updated_at();

-- ─────────────────────────────────────────────
-- ORGANIZATION_MEMBERS
-- Links users to organizations with a role.
-- Constraint: each user belongs to AT MOST ONE org (except platform admins).
-- ─────────────────────────────────────────────
create table if not exists public.organization_members (
  id                  uuid primary key default uuid_generate_v4(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  user_id             uuid not null references public.users(id) on delete cascade,

  role                text not null default 'member'
                        check (role in ('owner', 'admin', 'member')),
  status              text not null default 'active'
                        check (status in ('active', 'suspended', 'left')),

  joined_at           timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  unique (organization_id, user_id)
);

-- Enforce 1-user-1-org for non-admins via unique constraint on user_id when active
-- (platform admins can override via separate path)
create unique index if not exists org_members_one_active_per_user
  on public.organization_members(user_id)
  where status = 'active';

create index if not exists org_members_org_idx  on public.organization_members(organization_id, status);
create index if not exists org_members_role_idx on public.organization_members(role) where status = 'active';

alter table public.organization_members enable row level security;

create trigger org_members_touch before update on public.organization_members
  for each row execute function public.touch_updated_at();

-- ─────────────────────────────────────────────
-- ORGANIZATION_INVITATIONS
-- Pending invites by email. Become organization_members when accepted.
-- ─────────────────────────────────────────────
create table if not exists public.organization_invitations (
  id                  uuid primary key default uuid_generate_v4(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  email               text not null,
  role                text not null default 'member'
                        check (role in ('owner', 'admin', 'member')),

  token               text not null unique,       -- random, used in invite URL
  invited_by          uuid references public.users(id) on delete set null,

  status              text not null default 'pending'
                        check (status in ('pending', 'accepted', 'revoked', 'expired')),

  expires_at          timestamptz not null default (now() + interval '7 days'),
  accepted_at         timestamptz,
  accepted_by         uuid references public.users(id) on delete set null,

  created_at          timestamptz not null default now(),

  unique (organization_id, email, status) deferrable initially deferred
);

create index if not exists org_invites_email_idx on public.organization_invitations(email, status);
create index if not exists org_invites_org_idx   on public.organization_invitations(organization_id, status);
create index if not exists org_invites_token_idx on public.organization_invitations(token);

alter table public.organization_invitations enable row level security;

-- ─────────────────────────────────────────────
-- HELPER FUNCTIONS
-- ─────────────────────────────────────────────

-- Check if user is a member of an org (any role)
create or replace function public.is_org_member(check_user_id uuid, check_org_id uuid)
returns boolean
language sql
stable
security definer
as $$
  select exists (
    select 1 from public.organization_members
    where user_id = check_user_id
      and organization_id = check_org_id
      and status = 'active'
  );
$$;

-- Check if user is an owner or admin of an org
create or replace function public.is_org_admin(check_user_id uuid, check_org_id uuid)
returns boolean
language sql
stable
security definer
as $$
  select exists (
    select 1 from public.organization_members
    where user_id = check_user_id
      and organization_id = check_org_id
      and status = 'active'
      and role in ('owner', 'admin')
  );
$$;

-- Check platform-level admin (keeps existing is_admin function)
-- public.is_admin(user_id) is already defined in schema.sql

-- Combined check: org member OR platform admin
create or replace function public.can_access_org(check_user_id uuid, check_org_id uuid)
returns boolean
language sql
stable
security definer
as $$
  select public.is_admin(check_user_id) or public.is_org_member(check_user_id, check_org_id);
$$;

-- Get a user's active organization id (null if none)
create or replace function public.get_user_active_org(check_user_id uuid)
returns uuid
language sql
stable
security definer
as $$
  select organization_id from public.organization_members
  where user_id = check_user_id and status = 'active'
  limit 1;
$$;

-- ─────────────────────────────────────────────
-- RLS ON ORGS TABLES
-- ─────────────────────────────────────────────

-- Organizations: members can see their org, platform admins see all
drop policy if exists orgs_member_select on public.organizations;
create policy orgs_member_select on public.organizations
  for select using (
    public.is_admin(auth.uid()) or public.is_org_member(auth.uid(), id)
  );

-- Org owners/admins can update their org
drop policy if exists orgs_admin_update on public.organizations;
create policy orgs_admin_update on public.organizations
  for update using (
    public.is_admin(auth.uid()) or public.is_org_admin(auth.uid(), id)
  );

-- Any authenticated user can create an org (subject to 1-user-1-org rule enforced elsewhere)
drop policy if exists orgs_create on public.organizations;
create policy orgs_create on public.organizations
  for insert with check (auth.uid() is not null);

-- Members: members see their org's members, platform admins see all
drop policy if exists om_member_select on public.organization_members;
create policy om_member_select on public.organization_members
  for select using (
    public.is_admin(auth.uid())
    or public.is_org_member(auth.uid(), organization_id)
  );

-- Org admins can manage members
drop policy if exists om_admin_all on public.organization_members;
create policy om_admin_all on public.organization_members
  for all using (
    public.is_admin(auth.uid()) or public.is_org_admin(auth.uid(), organization_id)
  );

-- Invitations: org admins can manage; invited users can see their own
drop policy if exists oi_admin_all on public.organization_invitations;
create policy oi_admin_all on public.organization_invitations
  for all using (
    public.is_admin(auth.uid())
    or public.is_org_admin(auth.uid(), organization_id)
    or email = (select email from public.users where id = auth.uid())
  );

-- ─────────────────────────────────────────────
-- ADD org_id TO ALL DATA TABLES
-- ─────────────────────────────────────────────

-- users: keep as-is (global), but add active_org_id as convenience
alter table public.users
  add column if not exists active_org_id uuid references public.organizations(id) on delete set null;

-- Core content tables
alter table public.generations         add column if not exists org_id uuid references public.organizations(id) on delete cascade;
alter table public.generation_results  add column if not exists org_id uuid references public.organizations(id) on delete cascade;
alter table public.credit_transactions add column if not exists org_id uuid references public.organizations(id) on delete cascade;
alter table public.fashion_models      add column if not exists org_id uuid references public.organizations(id) on delete cascade;

-- Channels / publishing
alter table public.channel_connections        add column if not exists org_id uuid references public.organizations(id) on delete cascade;
alter table public.publishings                add column if not exists org_id uuid references public.organizations(id) on delete cascade;
alter table public.generation_commerce_meta   add column if not exists org_id uuid references public.organizations(id) on delete cascade;

-- External data (from migration-005)
alter table public.external_products        add column if not exists org_id uuid references public.organizations(id) on delete cascade;
alter table public.external_customers       add column if not exists org_id uuid references public.organizations(id) on delete cascade;
alter table public.external_orders          add column if not exists org_id uuid references public.organizations(id) on delete cascade;
alter table public.external_order_items     add column if not exists org_id uuid references public.organizations(id) on delete cascade;
alter table public.product_analytics_daily  add column if not exists org_id uuid references public.organizations(id) on delete cascade;
alter table public.ai_diagnoses             add column if not exists org_id uuid references public.organizations(id) on delete cascade;
alter table public.ai_recommendations       add column if not exists org_id uuid references public.organizations(id) on delete cascade;
alter table public.sync_jobs                add column if not exists org_id uuid references public.organizations(id) on delete cascade;
alter table public.buyer_profiles           add column if not exists org_id uuid references public.organizations(id) on delete cascade;

-- Product masters (from migration-006)
alter table public.product_masters             add column if not exists org_id uuid references public.organizations(id) on delete cascade;
alter table public.product_master_variants     add column if not exists org_id uuid references public.organizations(id) on delete cascade;
alter table public.import_jobs                 add column if not exists org_id uuid references public.organizations(id) on delete cascade;
alter table public.product_master_generations  add column if not exists org_id uuid references public.organizations(id) on delete cascade;
alter table public.product_master_errors       add column if not exists org_id uuid references public.organizations(id) on delete cascade;

-- Permanent deletion marker (soft archive already exists via is_archived)
alter table public.product_masters
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references public.users(id) on delete set null;

-- Indexes for every new org_id
create index if not exists gen_org_idx                   on public.generations(org_id);
create index if not exists gr_org_idx                    on public.generation_results(org_id);
create index if not exists ct_org_idx                    on public.credit_transactions(org_id);
create index if not exists fm_org_idx                    on public.fashion_models(org_id);
create index if not exists cc_org_idx                    on public.channel_connections(org_id);
create index if not exists pub_org_idx                   on public.publishings(org_id);
create index if not exists gcm_org_idx                   on public.generation_commerce_meta(org_id);
create index if not exists ep_org_idx_v2                 on public.external_products(org_id);
create index if not exists ec_org_idx_v2                 on public.external_customers(org_id);
create index if not exists eo_org_idx_v2                 on public.external_orders(org_id);
create index if not exists eoi_org_idx_v2                on public.external_order_items(org_id);
create index if not exists pad_org_idx_v2                on public.product_analytics_daily(org_id);
create index if not exists aid_org_idx_v2                on public.ai_diagnoses(org_id);
create index if not exists arec_org_idx_v2               on public.ai_recommendations(org_id);
create index if not exists sj_org_idx_v2                 on public.sync_jobs(org_id);
create index if not exists bp_org_idx_v2                 on public.buyer_profiles(org_id);
create index if not exists pm_org_idx_v2                 on public.product_masters(org_id);
create index if not exists pmv_org_idx_v2                on public.product_master_variants(org_id);
create index if not exists ij_org_idx_v2                 on public.import_jobs(org_id);
create index if not exists pmg_org_idx_v2                on public.product_master_generations(org_id);
create index if not exists pme_org_idx_v2                on public.product_master_errors(org_id);

-- ─────────────────────────────────────────────
-- REWRITE RLS POLICIES — ORG BASED
-- Replaces old user_id-only policies.
-- Pattern: can_access_org(auth.uid(), org_id)
-- ─────────────────────────────────────────────

-- generations
drop policy if exists gen_owner_all on public.generations;
create policy gen_org_all on public.generations
  for all using (
    org_id is null -- legacy rows, keep visible to owner only (migration grace)
      and auth.uid() = user_id
    or org_id is not null and public.can_access_org(auth.uid(), org_id)
  ) with check (
    org_id is null and auth.uid() = user_id
    or org_id is not null and public.can_access_org(auth.uid(), org_id)
  );

-- generation_results
drop policy if exists gr_owner_all on public.generation_results;
create policy gr_org_all on public.generation_results
  for all using (
    org_id is null and auth.uid() = user_id
    or org_id is not null and public.can_access_org(auth.uid(), org_id)
  ) with check (
    org_id is null and auth.uid() = user_id
    or org_id is not null and public.can_access_org(auth.uid(), org_id)
  );

-- credit_transactions
drop policy if exists ct_owner_select on public.credit_transactions;
create policy ct_org_select on public.credit_transactions
  for select using (
    org_id is null and auth.uid() = user_id
    or org_id is not null and public.can_access_org(auth.uid(), org_id)
  );

-- fashion_models
drop policy if exists fm_owner_all on public.fashion_models;
create policy fm_org_all on public.fashion_models
  for all using (
    org_id is null and auth.uid() = user_id
    or org_id is not null and public.can_access_org(auth.uid(), org_id)
  ) with check (
    org_id is null and auth.uid() = user_id
    or org_id is not null and public.can_access_org(auth.uid(), org_id)
  );

-- channel_connections
drop policy if exists cc_owner_all on public.channel_connections;
create policy cc_org_all on public.channel_connections
  for all using (
    org_id is null and auth.uid() = user_id
    or org_id is not null and public.can_access_org(auth.uid(), org_id)
  ) with check (
    org_id is null and auth.uid() = user_id
    or org_id is not null and public.can_access_org(auth.uid(), org_id)
  );

-- publishings
drop policy if exists pub_owner_all on public.publishings;
create policy pub_org_all on public.publishings
  for all using (
    org_id is null and auth.uid() = user_id
    or org_id is not null and public.can_access_org(auth.uid(), org_id)
  ) with check (
    org_id is null and auth.uid() = user_id
    or org_id is not null and public.can_access_org(auth.uid(), org_id)
  );

-- generation_commerce_meta
drop policy if exists gcm_owner_all on public.generation_commerce_meta;
create policy gcm_org_all on public.generation_commerce_meta
  for all using (
    org_id is null and auth.uid() = user_id
    or org_id is not null and public.can_access_org(auth.uid(), org_id)
  ) with check (
    org_id is null and auth.uid() = user_id
    or org_id is not null and public.can_access_org(auth.uid(), org_id)
  );

-- external_products, orders, customers, etc.
do $$
declare
  t text;
begin
  for t in
    select unnest(array[
      'external_products','external_customers','external_orders','external_order_items',
      'product_analytics_daily','ai_diagnoses','ai_recommendations','sync_jobs','buyer_profiles',
      'product_masters','product_master_variants','import_jobs',
      'product_master_generations','product_master_errors'
    ])
  loop
    execute format('drop policy if exists %I_owner_all on public.%I', t, t);
    execute format('drop policy if exists %I_org_all on public.%I', t, t);
    execute format(
      'create policy %I_org_all on public.%I for all using (
         (org_id is null and auth.uid() = user_id)
         or (org_id is not null and public.can_access_org(auth.uid(), org_id))
       ) with check (
         (org_id is null and auth.uid() = user_id)
         or (org_id is not null and public.can_access_org(auth.uid(), org_id))
       )',
      t, t
    );
  end loop;
end $$;

-- ─────────────────────────────────────────────
-- ATOMIC CREDIT OPERATIONS — now at org level
-- ─────────────────────────────────────────────
create or replace function public.deduct_org_credits(
  p_org_id uuid,
  p_user_id uuid,
  p_amount int,
  p_reason text,
  p_reference_id uuid default null,
  p_description text default null
)
returns boolean
language plpgsql
security definer
as $$
declare
  current_balance int;
begin
  select credits_balance into current_balance
  from public.organizations
  where id = p_org_id
  for update;

  if current_balance is null then return false; end if;
  if current_balance < p_amount then return false; end if;

  update public.organizations
  set credits_balance = credits_balance - p_amount
  where id = p_org_id;

  insert into public.credit_transactions
    (user_id, org_id, amount, type, reason, reference_id, description)
  values
    (p_user_id, p_org_id, -p_amount, 'debit', p_reason, p_reference_id, p_description);

  return true;
end;
$$;

create or replace function public.add_org_credits(
  p_org_id uuid,
  p_user_id uuid,
  p_amount int,
  p_reason text,
  p_description text default null
)
returns boolean
language plpgsql
security definer
as $$
begin
  update public.organizations
  set credits_balance = credits_balance + p_amount
  where id = p_org_id;

  insert into public.credit_transactions
    (user_id, org_id, amount, type, reason, description)
  values
    (p_user_id, p_org_id, p_amount, 'credit', p_reason, p_description);

  return true;
end;
$$;

-- ─────────────────────────────────────────────
-- VIEW: organization summary for UI
-- ─────────────────────────────────────────────
create or replace view public.organizations_with_stats as
  select
    o.*,
    (select count(*)::int from public.organization_members m
       where m.organization_id = o.id and m.status = 'active') as member_count,
    (select count(*)::int from public.organization_invitations i
       where i.organization_id = o.id and i.status = 'pending') as pending_invites,
    (select count(*)::int from public.product_masters pm
       where pm.org_id = o.id and pm.is_archived = false and pm.deleted_at is null) as active_products,
    (select count(*)::int from public.generations g
       where g.org_id = o.id) as total_generations;
