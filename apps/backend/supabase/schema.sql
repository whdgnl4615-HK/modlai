-- ============================================================
-- MODLai Database Schema
-- Run this in Supabase SQL Editor
-- ============================================================

-- ─────────────────────────────────────────────
-- 0. EXTENSIONS
-- ─────────────────────────────────────────────
create extension if not exists "uuid-ossp";

-- ─────────────────────────────────────────────
-- 1. USERS (public table linked to auth.users)
-- ─────────────────────────────────────────────
create table public.users (
  id                 uuid primary key references auth.users(id) on delete cascade,
  email              text not null,
  display_name       text,
  avatar_url         text,
  role               text not null default 'user' check (role in ('user', 'admin')),
  credits            int  not null default 100,            -- signup bonus
  stripe_customer_id text,
  is_blocked         boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index users_email_idx on public.users(email);
create index users_role_idx  on public.users(role);

-- Auto-create public.users row whenever a new auth.users is created
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.users (id, email, display_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    new.raw_user_meta_data->>'avatar_url'
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- updated_at trigger helper
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create trigger users_touch before update on public.users
  for each row execute function public.touch_updated_at();

-- ─────────────────────────────────────────────
-- 2. FASHION MODELS (saved virtual models)
-- ─────────────────────────────────────────────
create table public.fashion_models (
  id             uuid primary key default uuid_generate_v4(),
  user_id        uuid not null references public.users(id) on delete cascade,
  name           text not null,
  appearance     text not null,
  ref_image_url  text,
  is_archived    boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index fashion_models_user_idx on public.fashion_models(user_id);

create trigger fashion_models_touch before update on public.fashion_models
  for each row execute function public.touch_updated_at();

-- ─────────────────────────────────────────────
-- 3. GENERATIONS (one request that may spawn multiple AI outputs)
-- ─────────────────────────────────────────────
create table public.generations (
  id                  uuid primary key default uuid_generate_v4(),
  user_id             uuid not null references public.users(id) on delete cascade,
  prompt              text not null,             -- final composed prompt
  user_prompt         text,                      -- what the user actually typed
  category            text,                      -- top, outer, dress, etc
  background          text,                      -- studio-white, beach, etc
  aspect_ratio        text default '3:4',
  ref_images          jsonb default '{}'::jsonb, -- {main: url, back: url, ...}
  acc_images          jsonb default '{}'::jsonb, -- {shoes: url, bag: url, ...}
  fashion_model_id    uuid references public.fashion_models(id) on delete set null,
  total_cost          int not null default 0,
  created_at          timestamptz not null default now()
);

create index generations_user_idx       on public.generations(user_id);
create index generations_created_idx    on public.generations(user_id, created_at desc);
create index generations_fashion_idx    on public.generations(fashion_model_id);

-- ─────────────────────────────────────────────
-- 4. GENERATION RESULTS (one row per AI model output)
-- ─────────────────────────────────────────────
create table public.generation_results (
  id              uuid primary key default uuid_generate_v4(),
  generation_id   uuid not null references public.generations(id) on delete cascade,
  user_id         uuid not null references public.users(id) on delete cascade,
  model_key       text not null,                  -- nanobanana, openai, stability
  image_url       text,                           -- null if generation failed
  thumb_url       text,                           -- optional smaller version
  cost            int not null default 0,
  rating          int check (rating >= 1 and rating <= 5),
  liked           boolean not null default false,
  feedback        text,
  is_best         boolean not null default false,
  error_message   text,                           -- if generation failed
  meta            jsonb default '{}'::jsonb,      -- model-specific metadata
  created_at      timestamptz not null default now()
);

create index gen_results_generation_idx on public.generation_results(generation_id);
create index gen_results_user_idx       on public.generation_results(user_id, created_at desc);
create index gen_results_model_idx      on public.generation_results(model_key);
create index gen_results_rating_idx     on public.generation_results(user_id, rating) where rating is not null;

-- ─────────────────────────────────────────────
-- 5. EDITS (Nano Banana edits form a chain)
-- ─────────────────────────────────────────────
create table public.edits (
  id                uuid primary key default uuid_generate_v4(),
  user_id           uuid not null references public.users(id) on delete cascade,
  source_result_id  uuid references public.generation_results(id) on delete set null,
  parent_edit_id    uuid references public.edits(id) on delete set null,
  prompt            text not null,
  image_url         text not null,
  cost              int not null default 0,
  created_at        timestamptz not null default now()
);

create index edits_user_idx   on public.edits(user_id, created_at desc);
create index edits_source_idx on public.edits(source_result_id);
create index edits_parent_idx on public.edits(parent_edit_id);

-- ─────────────────────────────────────────────
-- 6. DESCRIPTIONS (Claude-generated product copy)
-- ─────────────────────────────────────────────
create table public.descriptions (
  id             uuid primary key default uuid_generate_v4(),
  generation_id  uuid not null references public.generations(id) on delete cascade,
  user_id        uuid not null references public.users(id) on delete cascade,
  language       text not null default 'ko' check (language in ('ko', 'en')),
  content        jsonb not null,                   -- {title, tagline, description, highlights, styling_tips, tags, seo_title, seo_description}
  feedback       text,
  created_at     timestamptz not null default now()
);

create index descriptions_generation_idx on public.descriptions(generation_id);
create index descriptions_user_idx       on public.descriptions(user_id, created_at desc);

-- ─────────────────────────────────────────────
-- 7. CREDIT TRANSACTIONS (audit trail)
-- ─────────────────────────────────────────────
create table public.credit_transactions (
  id                        uuid primary key default uuid_generate_v4(),
  user_id                   uuid not null references public.users(id) on delete cascade,
  amount                    int  not null,                          -- positive: granted, negative: spent
  kind                      text not null check (kind in (
                              'purchase', 'generation', 'edit', 'description',
                              'refund', 'admin_grant', 'admin_revoke', 'signup_bonus'
                            )),
  reference_id              text,                                    -- uuid of related generation/edit/payment
  stripe_payment_intent_id  text,
  note                      text,
  created_at                timestamptz not null default now()
);

create index credit_tx_user_idx    on public.credit_transactions(user_id, created_at desc);
create index credit_tx_kind_idx    on public.credit_transactions(kind);
create index credit_tx_stripe_idx  on public.credit_transactions(stripe_payment_intent_id);

-- ─────────────────────────────────────────────
-- 8. PAYMENTS (Stripe transactions)
-- ─────────────────────────────────────────────
create table public.payments (
  id                        uuid primary key default uuid_generate_v4(),
  user_id                   uuid not null references public.users(id) on delete cascade,
  stripe_payment_intent_id  text unique not null,
  amount_cents              int  not null,
  currency                  text not null default 'usd',
  credits_granted           int  not null,
  package_id                text not null,                           -- starter | pro | studio
  status                    text not null check (status in ('pending', 'succeeded', 'failed', 'refunded')),
  failure_reason            text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create index payments_user_idx    on public.payments(user_id, created_at desc);
create index payments_status_idx  on public.payments(status);

create trigger payments_touch before update on public.payments
  for each row execute function public.touch_updated_at();

-- ─────────────────────────────────────────────
-- 9. ATOMIC CREDIT OPERATIONS (RPC functions)
-- Use these from the backend instead of raw UPDATE to prevent races.
-- ─────────────────────────────────────────────

-- Deduct credits atomically. Returns true on success, false if insufficient.
create or replace function public.deduct_credits(
  p_user_id uuid,
  p_amount int,
  p_kind text,
  p_reference_id text default null,
  p_note text default null
)
returns boolean
language plpgsql
security definer
as $$
declare
  v_new_credits int;
begin
  update public.users
     set credits = credits - p_amount
   where id = p_user_id
     and credits >= p_amount
     and not is_blocked
  returning credits into v_new_credits;

  if v_new_credits is null then
    return false;
  end if;

  insert into public.credit_transactions (user_id, amount, kind, reference_id, note)
  values (p_user_id, -p_amount, p_kind, p_reference_id, p_note);

  return true;
end;
$$;

-- Grant credits atomically (purchase, refund, admin grant)
create or replace function public.grant_credits(
  p_user_id uuid,
  p_amount int,
  p_kind text,
  p_reference_id text default null,
  p_stripe_payment_intent_id text default null,
  p_note text default null
)
returns void
language plpgsql
security definer
as $$
begin
  update public.users
     set credits = credits + p_amount
   where id = p_user_id;

  insert into public.credit_transactions (
    user_id, amount, kind, reference_id, stripe_payment_intent_id, note
  )
  values (
    p_user_id, p_amount, p_kind, p_reference_id, p_stripe_payment_intent_id, p_note
  );
end;
$$;

-- ─────────────────────────────────────────────
-- 10. ADMIN HELPER
-- ─────────────────────────────────────────────
create or replace function public.is_admin(uid uuid)
returns boolean
language sql
stable
security definer
as $$
  select exists (
    select 1 from public.users
     where id = uid and role = 'admin' and not is_blocked
  );
$$;

-- ─────────────────────────────────────────────
-- 11. ROW LEVEL SECURITY
-- ─────────────────────────────────────────────
alter table public.users                enable row level security;
alter table public.fashion_models       enable row level security;
alter table public.generations          enable row level security;
alter table public.generation_results   enable row level security;
alter table public.edits                enable row level security;
alter table public.descriptions         enable row level security;
alter table public.credit_transactions  enable row level security;
alter table public.payments             enable row level security;

-- users: self + admin
create policy users_self_select on public.users
  for select using (auth.uid() = id or public.is_admin(auth.uid()));
create policy users_self_update on public.users
  for update using (auth.uid() = id) with check (auth.uid() = id and role = (select role from public.users where id = auth.uid()));
  -- prevents user from self-promoting to admin
create policy users_admin_update on public.users
  for update using (public.is_admin(auth.uid()));

-- fashion_models: owner + admin
create policy fm_owner_all    on public.fashion_models
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy fm_admin_select on public.fashion_models
  for select using (public.is_admin(auth.uid()));

-- generations: owner read, backend (service role) write
create policy gen_owner_select on public.generations
  for select using (auth.uid() = user_id or public.is_admin(auth.uid()));

-- generation_results: owner read + rate/feedback update, backend writes
create policy gen_res_owner_select on public.generation_results
  for select using (auth.uid() = user_id or public.is_admin(auth.uid()));
create policy gen_res_owner_update on public.generation_results
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- edits: owner + admin
create policy edits_owner_select on public.edits
  for select using (auth.uid() = user_id or public.is_admin(auth.uid()));

-- descriptions: owner + admin
create policy desc_owner_select on public.descriptions
  for select using (auth.uid() = user_id or public.is_admin(auth.uid()));
create policy desc_owner_update on public.descriptions
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- credit_transactions: own history + admin all
create policy ctx_owner_select on public.credit_transactions
  for select using (auth.uid() = user_id or public.is_admin(auth.uid()));

-- payments: own history + admin all
create policy pay_owner_select on public.payments
  for select using (auth.uid() = user_id or public.is_admin(auth.uid()));

-- NOTE: All inserts and most updates go through the service_role key
-- from our backend (Vercel functions), which bypasses RLS. That's intentional:
-- we want application logic (credit checks, Stripe validation) to gate writes.

-- ─────────────────────────────────────────────
-- 12. STORAGE BUCKETS (create via dashboard or separate script)
-- See schema-storage.sql for bucket setup
-- ─────────────────────────────────────────────

-- ─────────────────────────────────────────────
-- 13. USEFUL VIEWS
-- ─────────────────────────────────────────────

-- Model performance: average rating by model
create or replace view public.model_performance as
  select
    model_key,
    count(*)                      as total_generations,
    count(rating)                 as rated_count,
    avg(rating)::numeric(3,2)     as avg_rating,
    count(*) filter (where liked) as liked_count,
    count(*) filter (where is_best) as best_count
  from public.generation_results
  where image_url is not null
  group by model_key;

-- Revenue summary (admin view)
create or replace view public.revenue_summary as
  select
    date_trunc('day', created_at)::date as day,
    count(*)                            as payments_count,
    sum(amount_cents)::bigint           as revenue_cents,
    sum(credits_granted)                as credits_sold
  from public.payments
  where status = 'succeeded'
  group by 1
  order by 1 desc;

-- Per-user stats (admin)
create or replace view public.user_stats as
  select
    u.id,
    u.email,
    u.display_name,
    u.role,
    u.credits,
    u.is_blocked,
    u.created_at,
    (select count(*) from public.generations g where g.user_id = u.id) as gen_count,
    (select count(*) from public.generation_results r where r.user_id = u.id and r.image_url is not null) as image_count,
    (select coalesce(sum(amount_cents), 0) from public.payments p where p.user_id = u.id and p.status = 'succeeded') as lifetime_cents
  from public.users u;
