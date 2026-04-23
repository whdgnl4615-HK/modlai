-- ============================================================
-- MODLai Migration 009: Recommendation Applications
-- Run AFTER migration-008.
--
-- Tracks the full "diagnosis → action → measurement" loop:
--   1. AI generates a recommendation
--   2. User reviews and applies it (with or without edits)
--   3. We push the change to the channel
--   4. Later, we can measure the impact
-- ============================================================

create table if not exists public.recommendation_applications (
  id                  uuid primary key default uuid_generate_v4(),
  org_id              uuid not null references public.organizations(id) on delete cascade,
  user_id             uuid references public.users(id) on delete set null,
  applied_by_email    text,  -- snapshot in case user is later removed

  -- What was applied
  diagnosis_id        uuid references public.ai_diagnoses(id) on delete set null,
  recommendation_index int,                  -- which rec in diagnoses.recommendations[] array
  action_type         text not null,         -- regenerate_image | rewrite_title | rewrite_description | update_tags | adjust_price
  action_summary      text,                  -- human-readable description

  -- Target (a master OR an external product)
  master_id           uuid references public.product_masters(id) on delete set null,
  product_id          uuid references public.external_products(id) on delete set null,

  -- Before/after snapshots (jsonb for flexibility)
  before_state        jsonb not null default '{}'::jsonb,
  after_state         jsonb not null default '{}'::jsonb,

  -- Channel push result
  pushed_to_channel   text,                  -- shopify | faire | null (internal-only)
  push_status         text default 'pending' check (push_status in ('pending','pushed','failed','skipped')),
  push_error          text,
  external_id         text,                  -- id/URL of the updated product on the channel

  -- Impact measurement (filled later by a job comparing metrics)
  impact_measured_at  timestamptz,
  impact_summary      jsonb,                 -- { revenue_delta: 120, orders_delta: 2, ... }

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists rec_apps_org_idx         on public.recommendation_applications(org_id, created_at desc);
create index if not exists rec_apps_diagnosis_idx   on public.recommendation_applications(diagnosis_id);
create index if not exists rec_apps_master_idx      on public.recommendation_applications(master_id);
create index if not exists rec_apps_product_idx     on public.recommendation_applications(product_id);
create index if not exists rec_apps_action_idx      on public.recommendation_applications(action_type);

alter table public.recommendation_applications enable row level security;

create trigger rec_apps_touch before update on public.recommendation_applications
  for each row execute function public.touch_updated_at();

drop policy if exists rec_apps_org_all on public.recommendation_applications;
create policy rec_apps_org_all on public.recommendation_applications
  for all using (
    public.can_access_org(auth.uid(), org_id)
  ) with check (
    public.can_access_org(auth.uid(), org_id)
  );

-- Mark which recommendations from a diagnosis were applied.
-- Attach an 'applied' marker to ai_diagnoses.recommendations for UI state.
-- We do this at read time by joining, so no change to the recommendations column.

-- View: diagnoses with per-recommendation applied status
create or replace view public.ai_diagnoses_with_apps as
  select
    d.*,
    coalesce(
      (select jsonb_agg(jsonb_build_object(
        'index', ra.recommendation_index,
        'action_type', ra.action_type,
        'push_status', ra.push_status,
        'applied_at', ra.created_at,
        'application_id', ra.id
      ))
      from public.recommendation_applications ra
      where ra.diagnosis_id = d.id),
      '[]'::jsonb
    ) as applied_recommendations;
