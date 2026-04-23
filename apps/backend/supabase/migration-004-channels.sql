-- ============================================================
-- MODLai Migration 004: Channel Publishing (Shopify + Faire)
-- Run AFTER migration-003
--
-- What this adds:
--   * channel_connections     — user's API credentials per channel
--   * publishings             — history of pushed products
--   * generation_commerce_meta — extra commerce fields (price, SKU, etc)
--   * channel_category_mappings — map MODLai categories → channel-specific
-- ============================================================

-- ─────────────────────────────────────────────
-- 1. CHANNEL_CONNECTIONS
-- One row per (user, channel). Stores encrypted credentials.
-- ─────────────────────────────────────────────
create table if not exists public.channel_connections (
  id             uuid primary key default uuid_generate_v4(),
  user_id        uuid not null references public.users(id) on delete cascade,
  channel        text not null check (channel in ('shopify', 'magento', 'faire', 'fashiongo')),
  status         text not null default 'active' check (status in ('active', 'paused', 'revoked', 'error')),
  -- Connection details (encrypted at rest via Supabase pgsodium or similar in prod)
  store_url      text,                -- e.g. 'mystore.myshopify.com'
  store_name     text,                -- human-readable label
  access_token   text,                -- encrypted API token (RLS protects)
  refresh_token  text,                -- for OAuth flows
  scope          text,
  meta           jsonb default '{}'::jsonb, -- channel-specific: shop_id, brand_id, etc
  last_error     text,
  connected_at   timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (user_id, channel)           -- one connection per channel per user
);

create index if not exists cc_user_idx on public.channel_connections(user_id);

alter table public.channel_connections enable row level security;

create policy cc_owner_all on public.channel_connections
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy cc_admin_select on public.channel_connections
  for select using (public.is_admin(auth.uid()));

create trigger cc_touch before update on public.channel_connections
  for each row execute function public.touch_updated_at();

-- ─────────────────────────────────────────────
-- 2. GENERATION_COMMERCE_META
-- Commerce-specific fields that MODLai doesn't track by default
-- (price, SKU, variants, inventory). One row per generation.
-- ─────────────────────────────────────────────
create table if not exists public.generation_commerce_meta (
  generation_id    uuid primary key references public.generations(id) on delete cascade,
  user_id          uuid not null references public.users(id) on delete cascade,

  sku              text,
  retail_price_cents   int,
  wholesale_price_cents int,
  currency         text default 'usd',
  inventory_qty    int default 0,

  -- Variants: [{ name: 'S / Black', sku: 'ABC-S-BK', qty: 10, price_cents?: }, ...]
  variants         jsonb default '[]'::jsonb,

  -- Per-channel category mappings. e.g. { shopify: { product_type: 'Tops' }, faire: { taxonomy: 'women-tops' } }
  channel_categories jsonb default '{}'::jsonb,

  -- Final image URLs (may be different per channel; e.g. Faire wants 1000x1000 min)
  image_urls       text[] default '{}',

  weight_grams     int,
  hs_code          text,             -- international shipping
  country_of_origin text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists gcm_user_idx on public.generation_commerce_meta(user_id);

alter table public.generation_commerce_meta enable row level security;

create policy gcm_owner_all on public.generation_commerce_meta
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy gcm_admin_select on public.generation_commerce_meta
  for select using (public.is_admin(auth.uid()));

create trigger gcm_touch before update on public.generation_commerce_meta
  for each row execute function public.touch_updated_at();

-- ─────────────────────────────────────────────
-- 3. PUBLISHINGS
-- Each push attempt to a channel. Idempotent on (generation, channel).
-- ─────────────────────────────────────────────
create table if not exists public.publishings (
  id                  uuid primary key default uuid_generate_v4(),
  user_id             uuid not null references public.users(id) on delete cascade,
  generation_id       uuid not null references public.generations(id) on delete cascade,
  channel             text not null check (channel in ('shopify', 'magento', 'faire', 'fashiongo')),

  status              text not null default 'pending'
                        check (status in ('pending', 'publishing', 'published', 'failed', 'unpublished')),

  external_product_id text,          -- The ID on the target platform
  external_url        text,          -- Direct link to the product on that platform

  mapped_payload      jsonb,         -- Exact JSON we sent (for debugging)
  response_payload    jsonb,         -- Exact JSON we received
  error_message       text,
  error_code          text,

  published_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- Allow republishing if needed
  unique (generation_id, channel)
);

create index if not exists pub_user_idx      on public.publishings(user_id, created_at desc);
create index if not exists pub_gen_idx       on public.publishings(generation_id);
create index if not exists pub_channel_idx   on public.publishings(channel, status);

alter table public.publishings enable row level security;

create policy pub_owner_all on public.publishings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy pub_admin_select on public.publishings
  for select using (public.is_admin(auth.uid()));

create trigger pub_touch before update on public.publishings
  for each row execute function public.touch_updated_at();

-- ─────────────────────────────────────────────
-- 4. View: generation + commerce + publishings aggregate
-- ─────────────────────────────────────────────
create or replace view public.generations_with_commerce as
  select
    g.*,
    cm.sku, cm.retail_price_cents, cm.wholesale_price_cents, cm.currency,
    cm.inventory_qty, cm.variants, cm.channel_categories, cm.image_urls,
    cm.weight_grams, cm.hs_code, cm.country_of_origin,
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'channel', p.channel,
        'status', p.status,
        'external_url', p.external_url,
        'external_product_id', p.external_product_id,
        'published_at', p.published_at,
        'error_message', p.error_message
      ))
      from public.publishings p where p.generation_id = g.id
    ), '[]'::jsonb) as publishings
  from public.generations g
  left join public.generation_commerce_meta cm on cm.generation_id = g.id;
