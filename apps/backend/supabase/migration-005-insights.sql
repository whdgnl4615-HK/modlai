-- ============================================================
-- MODLai Migration 005: Insights & External Data Sync
-- Run AFTER migration-004
--
-- Adds:
--   * external_products     — cached products from Shopify/Faire
--   * external_orders       — cached order history
--   * external_order_items  — line items per order
--   * external_customers    — cached customers/buyers (PII hashed)
--   * product_analytics_daily — daily rollup per product
--   * ai_diagnoses          — Claude diagnosis results (cached)
--   * ai_recommendations    — AI-suggested actions
--   * sync_jobs             — sync history + status
--   * buyer_profiles        — Faire B2B retailer profiles (Phase 4)
-- ============================================================

-- ─────────────────────────────────────────────
-- EXTERNAL_PRODUCTS — cached from channels
-- ─────────────────────────────────────────────
create table if not exists public.external_products (
  id                    uuid primary key default uuid_generate_v4(),
  user_id               uuid not null references public.users(id) on delete cascade,
  channel               text not null check (channel in ('shopify', 'faire', 'magento', 'fashiongo')),
  external_id           text not null,          -- platform's product ID
  external_url          text,                   -- storefront URL

  title                 text,
  description           text,
  vendor                text,
  product_type          text,                   -- category on that platform
  tags                  text[] default '{}',

  -- Pricing
  price_cents           int,                    -- main/first variant
  compare_at_price_cents int,                   -- original price (for discounts)
  wholesale_price_cents int,
  currency              text default 'usd',

  -- Inventory
  inventory_qty         int default 0,

  -- Media
  primary_image_url     text,
  image_urls            text[] default '{}',

  -- Rich structured data
  variants              jsonb default '[]'::jsonb,  -- full variant array

  -- Status
  status                text,                   -- 'active', 'archived', 'draft' on platform
  published_at          timestamptz,

  -- Linkage
  modlai_generation_id  uuid references public.generations(id) on delete set null,
                                                -- if this product came FROM MODLai publish

  -- Sync metadata
  raw_payload           jsonb,                  -- full platform response (for debugging)
  synced_at             timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  unique (user_id, channel, external_id)
);

create index if not exists ep_user_channel_idx on public.external_products(user_id, channel);
create index if not exists ep_modlai_gen_idx   on public.external_products(modlai_generation_id) where modlai_generation_id is not null;

alter table public.external_products enable row level security;
create policy ep_owner_all on public.external_products
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy ep_admin_select on public.external_products
  for select using (public.is_admin(auth.uid()));

create trigger ep_touch before update on public.external_products
  for each row execute function public.touch_updated_at();

-- ─────────────────────────────────────────────
-- EXTERNAL_CUSTOMERS — buyers/customers
-- PII is hashed; raw email only in encrypted payload
-- ─────────────────────────────────────────────
create table if not exists public.external_customers (
  id                  uuid primary key default uuid_generate_v4(),
  user_id             uuid not null references public.users(id) on delete cascade,
  channel             text not null,
  external_id         text not null,

  email_hash          text,                     -- sha256 of email for dedup, not reversible
  display_name        text,                     -- first initial + last name, e.g. "J. Smith"
  region              text,                     -- country/state only
  customer_type       text,                     -- 'b2c' (Shopify) or 'retailer' (Faire)

  -- Aggregates
  total_orders        int default 0,
  total_spent_cents   bigint default 0,
  first_order_at      timestamptz,
  last_order_at       timestamptz,

  tags                text[] default '{}',
  meta                jsonb default '{}'::jsonb,

  synced_at           timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  unique (user_id, channel, external_id)
);

create index if not exists ec_user_channel_idx on public.external_customers(user_id, channel);

alter table public.external_customers enable row level security;
create policy ec_owner_all on public.external_customers
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create trigger ec_touch before update on public.external_customers
  for each row execute function public.touch_updated_at();

-- ─────────────────────────────────────────────
-- EXTERNAL_ORDERS
-- ─────────────────────────────────────────────
create table if not exists public.external_orders (
  id                   uuid primary key default uuid_generate_v4(),
  user_id              uuid not null references public.users(id) on delete cascade,
  channel              text not null,
  external_id          text not null,
  external_order_number text,                   -- human-readable, e.g. "#1042"

  customer_id          uuid references public.external_customers(id) on delete set null,

  -- Money
  subtotal_cents       bigint,
  total_cents          bigint,
  currency             text default 'usd',

  -- Status
  financial_status     text,                    -- paid, pending, refunded
  fulfillment_status   text,                    -- fulfilled, partial, unfulfilled

  placed_at            timestamptz,
  cancelled_at         timestamptz,

  raw_payload          jsonb,
  synced_at            timestamptz not null default now(),
  created_at           timestamptz not null default now(),

  unique (user_id, channel, external_id)
);

create index if not exists eo_user_placed_idx on public.external_orders(user_id, placed_at desc);
create index if not exists eo_customer_idx    on public.external_orders(customer_id) where customer_id is not null;

alter table public.external_orders enable row level security;
create policy eo_owner_all on public.external_orders
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ─────────────────────────────────────────────
-- EXTERNAL_ORDER_ITEMS — line items
-- ─────────────────────────────────────────────
create table if not exists public.external_order_items (
  id                 uuid primary key default uuid_generate_v4(),
  user_id            uuid not null references public.users(id) on delete cascade,
  order_id           uuid not null references public.external_orders(id) on delete cascade,
  product_id         uuid references public.external_products(id) on delete set null,
  external_product_id text,                     -- even if we don't have the product cached

  title              text,
  sku                text,
  quantity           int not null default 1,
  price_cents        bigint,                    -- per unit
  total_cents        bigint,                    -- quantity * price (post-discount)

  created_at         timestamptz not null default now()
);

create index if not exists eoi_order_idx   on public.external_order_items(order_id);
create index if not exists eoi_product_idx on public.external_order_items(product_id);
create index if not exists eoi_user_idx    on public.external_order_items(user_id);

alter table public.external_order_items enable row level security;
create policy eoi_owner_all on public.external_order_items
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ─────────────────────────────────────────────
-- PRODUCT_ANALYTICS_DAILY — daily rollup per product
-- Populated by aggregation query, not directly by channel API
-- ─────────────────────────────────────────────
create table if not exists public.product_analytics_daily (
  id                    uuid primary key default uuid_generate_v4(),
  user_id               uuid not null references public.users(id) on delete cascade,
  product_id            uuid not null references public.external_products(id) on delete cascade,
  date                  date not null,

  -- Computed from orders
  orders_count          int default 0,
  units_sold            int default 0,
  revenue_cents         bigint default 0,

  -- Optional enriched metrics (where channel exposes them)
  views                 int,                    -- Shopify Analytics: sessions w/ product view
  add_to_cart           int,
  conversion_rate       numeric(5,4),           -- 0.0250 = 2.50%

  created_at            timestamptz not null default now(),

  unique (user_id, product_id, date)
);

create index if not exists pad_user_date_idx on public.product_analytics_daily(user_id, date desc);
create index if not exists pad_product_idx   on public.product_analytics_daily(product_id, date desc);

alter table public.product_analytics_daily enable row level security;
create policy pad_owner_all on public.product_analytics_daily
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ─────────────────────────────────────────────
-- AI_DIAGNOSES — Claude analysis of a single product
-- ─────────────────────────────────────────────
create table if not exists public.ai_diagnoses (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid not null references public.users(id) on delete cascade,
  product_id      uuid not null references public.external_products(id) on delete cascade,

  -- Structured diagnosis output
  overall_score   int,                          -- 0-100 how well this product is doing
  issues          jsonb default '[]'::jsonb,    -- [{ area, severity, summary, evidence }]
  strengths       jsonb default '[]'::jsonb,
  recommendations jsonb default '[]'::jsonb,    -- [{ action_type, title, reasoning, estimated_impact }]

  -- Context used for this diagnosis
  metrics_snapshot jsonb,                       -- sales/views numbers at time of diagnosis
  model_used      text default 'claude-sonnet-4-5',
  prompt_version  text default 'v1',
  cost_credits    int default 20,

  created_at      timestamptz not null default now()
);

create index if not exists aid_product_idx on public.ai_diagnoses(product_id, created_at desc);
create index if not exists aid_user_idx    on public.ai_diagnoses(user_id, created_at desc);

alter table public.ai_diagnoses enable row level security;
create policy aid_owner_all on public.ai_diagnoses
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ─────────────────────────────────────────────
-- AI_RECOMMENDATIONS — top-level store recommendations
-- ─────────────────────────────────────────────
create table if not exists public.ai_recommendations (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid not null references public.users(id) on delete cascade,

  rec_type        text not null,                -- 'underperforming', 'best_seller_promote', 'price_adjust',
                                                -- 'new_product_idea', 'description_rewrite', 'image_refresh'
  priority        text default 'medium',        -- 'high', 'medium', 'low'
  status          text default 'pending',       -- 'pending', 'in_progress', 'applied', 'dismissed'

  title           text not null,
  summary         text,                         -- one-line tl;dr
  reasoning       text,                         -- why Claude thinks this
  action_data     jsonb default '{}'::jsonb,    -- structured action payload

  -- Targets
  product_ids     uuid[],                       -- products affected (if any)
  estimated_impact text,                        -- '$200-500/mo' or '+15% conversion'

  applied_at      timestamptz,
  dismissed_at    timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists arec_user_status_idx on public.ai_recommendations(user_id, status, priority);

alter table public.ai_recommendations enable row level security;
create policy arec_owner_all on public.ai_recommendations
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ─────────────────────────────────────────────
-- SYNC_JOBS — sync history
-- ─────────────────────────────────────────────
create table if not exists public.sync_jobs (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid not null references public.users(id) on delete cascade,
  channel         text not null,
  entity          text not null,                -- 'products', 'orders', 'customers', 'all'
  status          text not null default 'pending', -- 'pending', 'running', 'completed', 'failed'

  -- Range
  since           timestamptz,                  -- for incremental syncs (null = full)
  until           timestamptz,

  -- Results
  items_fetched   int default 0,
  items_created   int default 0,
  items_updated   int default 0,
  items_failed    int default 0,

  error_message   text,
  duration_ms     int,
  started_at      timestamptz,
  completed_at    timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists sj_user_created_idx on public.sync_jobs(user_id, created_at desc);

alter table public.sync_jobs enable row level security;
create policy sj_owner_all on public.sync_jobs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ─────────────────────────────────────────────
-- BUYER_PROFILES (Phase 4) — B2B retailer analysis
-- Empty for now; populated later when Phase 4 builds
-- ─────────────────────────────────────────────
create table if not exists public.buyer_profiles (
  id                    uuid primary key default uuid_generate_v4(),
  user_id               uuid not null references public.users(id) on delete cascade,
  customer_id           uuid not null references public.external_customers(id) on delete cascade,

  -- Computed profile attributes
  preferred_categories  text[] default '{}',
  preferred_price_min_cents bigint,
  preferred_price_max_cents bigint,
  preferred_style_tags  text[] default '{}',
  preferred_colors      text[] default '{}',

  avg_order_cents       bigint,
  order_frequency_days  int,                    -- typical gap between orders
  seasonal_pattern      jsonb,                  -- { q1: 0.2, q2: 0.1, q3: 0.3, q4: 0.4 }

  last_analyzed_at      timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  unique (user_id, customer_id)
);

create index if not exists bp_user_idx on public.buyer_profiles(user_id);

alter table public.buyer_profiles enable row level security;
create policy bp_owner_all on public.buyer_profiles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create trigger bp_touch before update on public.buyer_profiles
  for each row execute function public.touch_updated_at();

-- ─────────────────────────────────────────────
-- VIEW: product performance leaderboard
-- ─────────────────────────────────────────────
create or replace view public.product_performance as
  select
    p.id,
    p.user_id,
    p.channel,
    p.external_id,
    p.title,
    p.primary_image_url,
    p.price_cents,
    p.inventory_qty,
    p.status,
    coalesce(sum(pad.units_sold), 0)::bigint   as units_30d,
    coalesce(sum(pad.revenue_cents), 0)::bigint as revenue_30d,
    coalesce(sum(pad.views), 0)::bigint         as views_30d,
    coalesce(sum(pad.orders_count), 0)::int     as orders_30d,
    case
      when coalesce(sum(pad.views), 0) > 0
      then (coalesce(sum(pad.orders_count), 0)::numeric / sum(pad.views)::numeric)
      else null
    end as conv_rate_30d,
    (select count(*) from public.ai_diagnoses d where d.product_id = p.id) as diagnosis_count
  from public.external_products p
  left join public.product_analytics_daily pad on pad.product_id = p.id
                                              and pad.date >= (current_date - interval '30 days')
  group by p.id;

-- ─────────────────────────────────────────────
-- Cost setting for AI diagnosis
-- ─────────────────────────────────────────────
insert into public.system_settings (key, value, description) values
  ('ai_diagnosis_cost', '20'::jsonb, 'Credits per AI product diagnosis')
on conflict (key) do nothing;
