-- ============================================================================
-- MIGRATION 010 — System-Wide (Platform) Fashion Models
-- ============================================================================
-- Allows "global" fashion models that any organization can use.
--
-- Semantics:
--   fashion_models.org_id IS NULL   → system-wide, visible/usable by all orgs,
--                                      only created/edited by platform admins
--                                      (users.role = 'admin')
--   fashion_models.org_id IS <uuid> → belongs to that org only (existing behavior)
--
-- This migration:
--   1. Allows org_id to be NULL (removes NOT NULL if any)
--   2. Adds is_system flag for convenience (denormalized for quick filtering)
--   3. Updates fashion_models_full view
--   4. Updates RLS policy so all orgs can SELECT system models
--      but only platform admins can modify them
-- ============================================================================

-- 1) Ensure org_id can be NULL (may already be nullable)
alter table public.fashion_models alter column org_id drop not null;

-- 2) Add is_system column (convenience flag; maintained by trigger)
alter table public.fashion_models
  add column if not exists is_system boolean not null default false;

create or replace function public.sync_fashion_model_is_system()
returns trigger
language plpgsql
security definer
as $$
begin
  new.is_system = (new.org_id is null);
  return new;
end;
$$;

drop trigger if exists sync_fashion_model_is_system on public.fashion_models;
create trigger sync_fashion_model_is_system
  before insert or update of org_id on public.fashion_models
  for each row execute function public.sync_fashion_model_is_system();

-- Backfill existing rows (if any had org_id = null already)
update public.fashion_models set is_system = true where org_id is null;

-- Index to quickly filter system models
create index if not exists fm_is_system_idx on public.fashion_models(is_system) where is_system;

-- 3) Recreate fashion_models_full view to include is_system
drop view if exists public.fashion_models_full cascade;

create or replace view public.fashion_models_full as
select
  m.*,
  (select count(*)::int from public.fashion_model_sheets s
    where s.model_id = m.id) as sheet_count,
  (select count(*)::int from public.generations g
    where g.fashion_model_id = m.id) as use_count
from public.fashion_models m;

-- 4) Update RLS policies: allow all authenticated users to SELECT system models;
--    keep modifications admin-only
drop policy if exists fm_org_all on public.fashion_models;
drop policy if exists fm_select_system on public.fashion_models;
drop policy if exists fm_select_own_org on public.fashion_models;
drop policy if exists fm_insert_admin on public.fashion_models;
drop policy if exists fm_update_admin_or_owner on public.fashion_models;
drop policy if exists fm_delete_admin_or_owner on public.fashion_models;

-- SELECT: users can see models in their org OR system-wide models
create policy fm_select_own_org on public.fashion_models
  for select using (
    org_id is null                                         -- system model, anyone
    or public.is_org_member(auth.uid(), org_id)            -- their org's model
    or public.is_admin(auth.uid())                         -- platform admins see all
  );

-- INSERT: user can create a model in an org they belong to, OR as a system model if they're a platform admin
create policy fm_insert on public.fashion_models
  for insert with check (
    (org_id is not null and public.is_org_member(auth.uid(), org_id))
    or (org_id is null and public.is_admin(auth.uid()))
  );

-- UPDATE: user can update a model in their org, OR system model if platform admin
create policy fm_update on public.fashion_models
  for update using (
    (org_id is not null and public.is_org_member(auth.uid(), org_id))
    or (org_id is null and public.is_admin(auth.uid()))
  ) with check (
    (org_id is not null and public.is_org_member(auth.uid(), org_id))
    or (org_id is null and public.is_admin(auth.uid()))
  );

-- DELETE: same as update
create policy fm_delete on public.fashion_models
  for delete using (
    (org_id is not null and public.is_org_member(auth.uid(), org_id))
    or (org_id is null and public.is_admin(auth.uid()))
  );
