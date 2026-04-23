-- ============================================================
-- MODLai Migration 003: Advanced Fashion Models
-- Run AFTER migration-002
--
-- What this adds:
--  * fashion_models: attributes (age, gender, ethnicity, height, style_tags, etc)
--  * fashion_models: enriched_appearance (Claude-expanded full description)
--  * fashion_models: status (draft / ready / generating_sheet)
--  * fashion_model_sheets: character sheet images (4-6 angles per model)
--  * generations.fashion_model_id already exists — now actually used
-- ============================================================

-- ─────────────────────────────────────────────
-- 1. Extend fashion_models
-- ─────────────────────────────────────────────
alter table public.fashion_models
  add column if not exists enriched_appearance text,        -- Claude-expanded rich description
  add column if not exists age_range     text,              -- '20s', '30s', 'teens', etc
  add column if not exists gender        text,              -- 'female', 'male', 'non-binary', 'unspecified'
  add column if not exists ethnicity     text,              -- free text, e.g. 'Korean', 'Mixed Korean-European'
  add column if not exists height_cm     int,
  add column if not exists style_tags    text[] default '{}', -- ['minimalist', 'streetwear', ...]
  add column if not exists languages     text[] default '{}', -- ['ko', 'en'] - for voice/context
  add column if not exists status        text not null default 'draft'
    check (status in ('draft', 'generating_sheet', 'ready', 'failed')),
  add column if not exists primary_sheet_image_url text;    -- main preview image (first sheet)

create index if not exists fashion_models_status_idx on public.fashion_models(user_id, status);

-- ─────────────────────────────────────────────
-- 2. Character sheet (multiple angle reference images per model)
-- ─────────────────────────────────────────────
create table if not exists public.fashion_model_sheets (
  id                uuid primary key default uuid_generate_v4(),
  fashion_model_id  uuid not null references public.fashion_models(id) on delete cascade,
  user_id           uuid not null references public.users(id) on delete cascade,
  angle             text not null,          -- 'front', 'three_quarter', 'side', 'back', 'full_body', 'portrait'
  image_url         text not null,
  thumb_url         text,
  model_key         text,                   -- which AI generated it
  cost              int default 0,
  is_primary        boolean default false,  -- which one to use as main reference
  sort_order        int default 0,
  created_at        timestamptz not null default now()
);

create index if not exists fms_model_idx on public.fashion_model_sheets(fashion_model_id, sort_order);
create index if not exists fms_user_idx  on public.fashion_model_sheets(user_id);

alter table public.fashion_model_sheets enable row level security;

create policy fms_owner_all on public.fashion_model_sheets
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy fms_admin_select on public.fashion_model_sheets
  for select using (public.is_admin(auth.uid()));

-- ─────────────────────────────────────────────
-- 3. View: model with sheet count
-- ─────────────────────────────────────────────
create or replace view public.fashion_models_full as
  select
    m.*,
    coalesce((
      select count(*) from public.fashion_model_sheets s
       where s.fashion_model_id = m.id
    ), 0)::int as sheet_count,
    coalesce((
      select count(*) from public.generations g
       where g.fashion_model_id = m.id
    ), 0)::int as use_count
  from public.fashion_models m;

-- ─────────────────────────────────────────────
-- 4. Cost settings for model creation
-- ─────────────────────────────────────────────
insert into public.system_settings (key, value, description) values
  ('model_creation_cost', '120'::jsonb, 'Credits to generate a character sheet (4-6 images)'),
  ('model_sheet_angles',  '["front", "three_quarter", "side", "full_body"]'::jsonb, 'Default sheet angles to generate')
on conflict (key) do nothing;
