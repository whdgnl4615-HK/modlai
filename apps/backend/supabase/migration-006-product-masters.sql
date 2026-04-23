-- ============================================================
-- MODLai Migration 006: Product Masters + Import
-- Run AFTER migration-005
--
-- Adds:
--   * product_masters       — MODLai's internal product catalog (pre-publish)
--   * product_master_variants — size/color/prepack breakdown per master
--   * import_jobs           — file upload history + mapping record
-- ============================================================

-- ─────────────────────────────────────────────
-- PRODUCT_MASTERS
-- The user's own catalog, independent of any external channel.
-- One row per (style_number, color) — matching typical fashion industry convention.
-- Can later be linked to external_products via publishings.
-- ─────────────────────────────────────────────
create table if not exists public.product_masters (
  id                     uuid primary key default uuid_generate_v4(),
  user_id                uuid not null references public.users(id) on delete cascade,

  -- Core identity
  style_number           text not null,          -- e.g. 'MC181T'
  color                  text,                   -- e.g. 'WHITE'
  name                   text,                   -- e.g. 'CHARLIE VEST'
  description            text,

  -- Categorization
  category               text,                   -- e.g. 'TOP', 'PANTS', 'JACKET'
  subcategory            text,
  division               text,
  subdivision            text,
  season                 text,                   -- e.g. 'Summer 2025'
  tags                   text[] default '{}',

  -- Pricing (stored in cents for consistency with other tables)
  wholesale_price_cents  int,
  retail_price_cents     int,
  cost_cents             int,
  currency               text default 'usd',

  -- Supply chain
  available_date         date,
  start_sell_date        date,
  vendor                 text,
  country_of_origin      text,
  hs_tariff_no           text,
  fabric_content         text,
  fabric_type            text,
  weight_grams           int,

  -- Pack/box info (common ERP fields)
  prepack                text,                   -- e.g. 'S/M/L 1:2:1' or size ratio
  size_category          text,                   -- e.g. 'ADULT', 'REGULAR'
  pack_quantity          int,
  min_order_qty          int,

  -- Status
  status                 text default 'active'
                           check (status in ('active', 'discontinued', 'draft', 'archived')),
  is_archived            boolean default false,

  -- Linkage to MODLai generations (once AI images are made for this master)
  primary_generation_id  uuid references public.generations(id) on delete set null,
  primary_image_url      text,

  -- Linkage to imports
  source_import_id       uuid,                   -- → import_jobs.id (set FK later)
  source_row_index       int,                    -- row number in the source file

  -- Free-form metadata for channel-specific fields the user imported
  extra_fields           jsonb default '{}'::jsonb,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  -- One master per style+color per user
  unique (user_id, style_number, color)
);

create index if not exists pm_user_style_idx    on public.product_masters(user_id, style_number);
create index if not exists pm_user_category_idx on public.product_masters(user_id, category);
create index if not exists pm_user_season_idx   on public.product_masters(user_id, season);
create index if not exists pm_status_idx        on public.product_masters(user_id, status) where is_archived = false;

alter table public.product_masters enable row level security;
create policy pm_owner_all on public.product_masters
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy pm_admin_select on public.product_masters
  for select using (public.is_admin(auth.uid()));

create trigger pm_touch before update on public.product_masters
  for each row execute function public.touch_updated_at();

-- ─────────────────────────────────────────────
-- PRODUCT_MASTER_VARIANTS
-- Size / SKU breakdown per master.
-- Populated when source file has size-level rows, OR on demand by user.
-- ─────────────────────────────────────────────
create table if not exists public.product_master_variants (
  id                    uuid primary key default uuid_generate_v4(),
  user_id               uuid not null references public.users(id) on delete cascade,
  master_id             uuid not null references public.product_masters(id) on delete cascade,

  -- Variant identity
  sku                   text,                   -- full SKU, e.g. 'MC181T-WHITE-S'
  size                  text,                   -- 'S', 'M', 'L', 'XL', '28', etc.
  size_order            int,                    -- for sorting (S=1, M=2, L=3)
  extra_option          text,                   -- any additional option

  -- Quantities
  prepack_qty           int default 0,          -- qty in a pack
  inventory_qty         int default 0,

  -- Price overrides (if different from master)
  wholesale_price_cents int,
  retail_price_cents    int,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  unique (master_id, size)
);

create index if not exists pmv_master_idx on public.product_master_variants(master_id);
create index if not exists pmv_user_idx   on public.product_master_variants(user_id);
create index if not exists pmv_sku_idx    on public.product_master_variants(user_id, sku) where sku is not null;

alter table public.product_master_variants enable row level security;
create policy pmv_owner_all on public.product_master_variants
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create trigger pmv_touch before update on public.product_master_variants
  for each row execute function public.touch_updated_at();

-- ─────────────────────────────────────────────
-- IMPORT_JOBS
-- One row per file upload. Tracks parsing + mapping + import outcome.
-- ─────────────────────────────────────────────
create table if not exists public.import_jobs (
  id                  uuid primary key default uuid_generate_v4(),
  user_id             uuid not null references public.users(id) on delete cascade,

  -- Source
  filename            text,
  file_size_bytes     int,
  file_type           text,                     -- 'csv' | 'xlsx'
  sheet_name          text,                     -- for xlsx
  header_row_index    int,                      -- which row was detected as header (0-indexed)

  -- Detected structure
  source_columns      jsonb,                    -- [{ index, name, sample_values }]
  row_count           int,

  -- AI + user mapping
  mapping             jsonb,                    -- { source_col_name: target_field_name }
  mapping_source      text default 'ai',        -- 'ai' | 'user' | 'hybrid'

  -- Granularity detected
  granularity         text,                     -- 'master' | 'master_with_variants'

  -- Status
  status              text not null default 'draft'
                         check (status in ('draft', 'mapping', 'previewing', 'importing',
                                          'completed', 'failed', 'cancelled')),

  -- Results
  masters_created     int default 0,
  masters_updated     int default 0,
  variants_created    int default 0,
  rows_skipped        int default 0,
  errors              jsonb default '[]'::jsonb, -- [{ row_index, error_message }]

  error_message       text,
  duration_ms         int,

  created_at          timestamptz not null default now(),
  completed_at        timestamptz,
  updated_at          timestamptz not null default now()
);

create index if not exists ij_user_created_idx on public.import_jobs(user_id, created_at desc);
create index if not exists ij_status_idx       on public.import_jobs(user_id, status);

alter table public.import_jobs enable row level security;
create policy ij_owner_all on public.import_jobs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create trigger ij_touch before update on public.import_jobs
  for each row execute function public.touch_updated_at();

-- Now we can wire up the FK from product_masters → import_jobs
alter table public.product_masters
  drop constraint if exists product_masters_source_import_fkey,
  add constraint product_masters_source_import_fkey
    foreign key (source_import_id) references public.import_jobs(id) on delete set null;

-- ─────────────────────────────────────────────
-- View: product_masters with variant counts + generation linkage
-- ─────────────────────────────────────────────
create or replace view public.product_masters_full as
  select
    m.*,
    coalesce((
      select count(*) from public.product_master_variants v where v.master_id = m.id
    ), 0)::int as variant_count,
    coalesce((
      select sum(v.inventory_qty)::int from public.product_master_variants v where v.master_id = m.id
    ), 0) as total_inventory,
    (g.id is not null) as has_generation,
    g.created_at as generation_created_at
  from public.product_masters m
  left join public.generations g on g.id = m.primary_generation_id;
