-- ============================================================
-- MODLai Migration 007: Product Master Linkages
-- Run AFTER migration-006
--
-- Purpose: Make product_master the source of truth, linked to
--   - generations (AI images made for this master)
--   - publishings (which channel it was pushed to + status)
--   - external_products (which platform product it became)
--   - ai_diagnoses (Claude's analysis of it)
--
-- Also adds data-preservation safeguards:
--   - Soft delete column on product_masters
--   - Master-level error log
--   - Views that aggregate all linked data for easy UI rendering
-- ============================================================

-- ─────────────────────────────────────────────
-- 1. LINK TABLE: master_generations (N:M)
-- One master can have many AI-generated images over time.
-- One generation belongs to one master (usually).
-- ─────────────────────────────────────────────
create table if not exists public.product_master_generations (
  id                  uuid primary key default uuid_generate_v4(),
  user_id             uuid not null references public.users(id) on delete cascade,
  master_id           uuid not null references public.product_masters(id) on delete cascade,
  generation_id       uuid not null references public.generations(id) on delete cascade,

  -- Label role so UI can distinguish "original", "improved v2" etc.
  role                text default 'primary'
                        check (role in ('primary', 'alternative', 'before', 'after', 'variant')),
  display_order       int default 0,
  notes               text,

  created_at          timestamptz not null default now(),
  unique (master_id, generation_id)
);

create index if not exists pmg_master_idx on public.product_master_generations(master_id);
create index if not exists pmg_gen_idx    on public.product_master_generations(generation_id);
create index if not exists pmg_user_idx   on public.product_master_generations(user_id);

alter table public.product_master_generations enable row level security;
create policy pmg_owner_all on public.product_master_generations
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ─────────────────────────────────────────────
-- 2. Add master_id to publishings (already has generation_id)
-- So we can track: which master was published, not just which generation
-- ─────────────────────────────────────────────
alter table public.publishings
  add column if not exists master_id uuid references public.product_masters(id) on delete set null;

create index if not exists publishings_master_idx on public.publishings(master_id)
  where master_id is not null;

-- ─────────────────────────────────────────────
-- 3. Add master_id to external_products
-- When a master is published and then the channel syncs back, we can link
-- the external product back to its source master.
-- ─────────────────────────────────────────────
alter table public.external_products
  add column if not exists master_id uuid references public.product_masters(id) on delete set null;

create index if not exists external_products_master_idx on public.external_products(master_id)
  where master_id is not null;

-- ─────────────────────────────────────────────
-- 4. Add master_id to ai_diagnoses
-- So a master can be diagnosed even before it has an external_product
-- (i.e., before it's even published). Makes diagnose work on internal items too.
-- ─────────────────────────────────────────────
alter table public.ai_diagnoses
  add column if not exists master_id uuid references public.product_masters(id) on delete set null;

-- Make product_id nullable since we can now diagnose masters directly
alter table public.ai_diagnoses
  alter column product_id drop not null;

create index if not exists ai_diagnoses_master_idx on public.ai_diagnoses(master_id)
  where master_id is not null;

-- Either product_id OR master_id must be set
alter table public.ai_diagnoses
  drop constraint if exists ai_diagnoses_target_check;
alter table public.ai_diagnoses
  add constraint ai_diagnoses_target_check
    check (product_id is not null or master_id is not null);

-- ─────────────────────────────────────────────
-- 5. Master-level error log — any failure related to a master
-- (publish error, diagnose error, image gen error, etc)
-- ─────────────────────────────────────────────
create table if not exists public.product_master_errors (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid not null references public.users(id) on delete cascade,
  master_id       uuid not null references public.product_masters(id) on delete cascade,

  error_type      text not null,             -- 'publish', 'generate', 'diagnose', 'import', 'sync'
  channel         text,                      -- 'shopify', 'faire', etc (if applicable)
  error_code      text,
  error_message   text not null,
  context         jsonb default '{}'::jsonb,

  resolved        boolean default false,
  resolved_at     timestamptz,
  resolved_note   text,

  created_at      timestamptz not null default now()
);

create index if not exists pme_master_idx  on public.product_master_errors(master_id, created_at desc);
create index if not exists pme_user_idx    on public.product_master_errors(user_id, resolved, created_at desc);

alter table public.product_master_errors enable row level security;
create policy pme_owner_all on public.product_master_errors
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ─────────────────────────────────────────────
-- 6. DATA PRESERVATION SAFEGUARDS
-- Replace CASCADE with SET NULL where appropriate so data doesn't vanish
-- ─────────────────────────────────────────────

-- When a generation is deleted, don't delete the master that referenced it as primary
alter table public.product_masters
  drop constraint if exists product_masters_primary_generation_id_fkey,
  add constraint product_masters_primary_generation_id_fkey
    foreign key (primary_generation_id) references public.generations(id) on delete set null;

-- When an import_job is deleted, don't delete the products that came from it
-- (this was already set up correctly, but we verify)
alter table public.product_masters
  drop constraint if exists product_masters_source_import_fkey,
  add constraint product_masters_source_import_fkey
    foreign key (source_import_id) references public.import_jobs(id) on delete set null;

-- ─────────────────────────────────────────────
-- 7. UNIFIED VIEW: product_masters_with_status
-- All the info a UI card needs in one query, including publish status per channel.
-- ─────────────────────────────────────────────
create or replace view public.product_masters_with_status as
  select
    m.id,
    m.user_id,
    m.style_number,
    m.color,
    m.name,
    m.description,
    m.category,
    m.subcategory,
    m.division,
    m.subdivision,
    m.season,
    m.tags,
    m.wholesale_price_cents,
    m.retail_price_cents,
    m.cost_cents,
    m.currency,
    m.available_date,
    m.start_sell_date,
    m.vendor,
    m.country_of_origin,
    m.fabric_content,
    m.fabric_type,
    m.weight_grams,
    m.prepack,
    m.size_category,
    m.pack_quantity,
    m.min_order_qty,
    m.status,
    m.is_archived,
    m.primary_generation_id,
    m.primary_image_url,
    m.source_import_id,
    m.extra_fields,
    m.created_at,
    m.updated_at,

    -- Generation count
    coalesce((
      select count(*)::int from public.product_master_generations mg
      where mg.master_id = m.id
    ), 0) as generation_count,

    -- Variant count
    coalesce((
      select count(*)::int from public.product_master_variants v
      where v.master_id = m.id
    ), 0) as variant_count,

    -- Total inventory
    coalesce((
      select sum(v.inventory_qty)::int from public.product_master_variants v
      where v.master_id = m.id
    ), 0) as total_inventory,

    -- Channels published to, as jsonb array:
    -- [{ channel, status, external_url, external_product_id, published_at, error_message }]
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'channel', p.channel,
        'status', p.status,
        'external_url', p.external_url,
        'external_product_id', p.external_product_id,
        'published_at', p.published_at,
        'error_message', p.error_message
      ) order by p.channel)
      from public.publishings p
      where p.master_id = m.id
    ), '[]'::jsonb) as publish_status,

    -- Any unresolved errors?
    coalesce((
      select count(*)::int from public.product_master_errors e
      where e.master_id = m.id and e.resolved = false
    ), 0) as unresolved_error_count,

    -- Latest diagnosis
    (
      select jsonb_build_object(
        'id', d.id,
        'overall_score', d.overall_score,
        'created_at', d.created_at,
        'recommendation_count',
          case when jsonb_typeof(d.recommendations) = 'array'
               then jsonb_array_length(d.recommendations)
               else 0 end
      )
      from public.ai_diagnoses d
      where d.master_id = m.id
      order by d.created_at desc
      limit 1
    ) as latest_diagnosis
  from public.product_masters m
  where m.is_archived = false;

-- ─────────────────────────────────────────────
-- 8. Helper: trigger to keep master.primary_generation_id in sync
-- When a product_master_generations row is inserted as 'primary', update the master
-- ─────────────────────────────────────────────
create or replace function public.sync_master_primary_generation()
returns trigger
language plpgsql
security definer
as $$
begin
  if new.role = 'primary' then
    update public.product_masters
      set primary_generation_id = new.generation_id,
          primary_image_url = coalesce(
            (select image_url from public.generation_results
              where generation_id = new.generation_id
              and (is_best = true or liked = true)
              order by created_at desc limit 1),
            (select image_url from public.generation_results
              where generation_id = new.generation_id
              order by created_at desc limit 1),
            primary_image_url
          )
      where id = new.master_id;
  end if;
  return new;
end;
$$;

drop trigger if exists sync_master_primary_generation_trig on public.product_master_generations;
create trigger sync_master_primary_generation_trig
  after insert or update of role on public.product_master_generations
  for each row execute function public.sync_master_primary_generation();

-- ─────────────────────────────────────────────
-- 9. Helper: when a publishing is created, link its master + log errors
-- ─────────────────────────────────────────────
create or replace function public.log_publishing_error()
returns trigger
language plpgsql
security definer
as $$
begin
  if new.status = 'failed' and new.master_id is not null then
    insert into public.product_master_errors
      (user_id, master_id, error_type, channel, error_code, error_message, context)
    values
      (new.user_id, new.master_id, 'publish', new.channel,
       new.error_code, coalesce(new.error_message, 'Publish failed'),
       jsonb_build_object('publishing_id', new.id, 'generation_id', new.generation_id));
  end if;
  return new;
end;
$$;

drop trigger if exists log_publishing_error_trig on public.publishings;
create trigger log_publishing_error_trig
  after insert or update of status on public.publishings
  for each row execute function public.log_publishing_error();
