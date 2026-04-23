# Architecture

## Design principles

1. **Credits are the source of truth for billing.** Every paid operation atomically deducts before the expensive call, refunds on failure. No credits = no work. This means we never bill for failed AI calls, and we never do free work.

2. **Frontend never holds secret keys.** All AI providers and Stripe/Balance require server-side calls. The frontend talks only to our backend.

3. **Row-Level Security at the DB.** Users can only read/update their own rows. Admins bypass via a policy. Application code never needs `if (isAdmin)` checks — Postgres enforces it.

4. **Stateless backend.** Vercel functions scale horizontally. All state lives in Supabase.

5. **Idempotent webhooks.** Both Stripe and Balance webhooks use `upsert` keyed by `(provider, external_id)`. Retries won't double-credit.

6. **Payment provider is abstracted.** Stripe and Balance both implement a single `PaymentProvider` interface. The rest of the app doesn't know or care which one is active.

## Payment provider abstraction

```
                   ┌─────────────────────┐
                   │  Frontend           │
                   │  "+ 충전" button    │
                   └──────────┬──────────┘
                              │
                              ▼
               /api/payments/create-checkout
               body: { packageId }
                              │
                              ▼
               ┌──────────────────────────┐
               │ getActiveProvider()      │
               │ reads system_settings    │
               │ key='active_payment_pro' │
               └──────────┬───────────────┘
                          │
                  ┌───────┴───────┐
                  ▼               ▼
          StripeProvider   BalanceProvider
            .createCheckout()
                  │               │
                  ▼               ▼
          { flow: 'elements',  { flow: 'redirect',
            clientSecret }       hostedUrl }
                  │               │
                  ▼               ▼
          Stripe Payment    window.location
          Element mounts    = hostedUrl
          inline
                  │               │
                  ▼               ▼
          Buyer pays      Buyer pays on Balance
          immediately     hosted portal (Net 30)
                  │               │
                  ▼               ▼
          Webhook sent    Webhook sent
          /webhook/stripe /webhook/balance
                  │               │
                  └───────┬───────┘
                          ▼
               verifyAndParseWebhook()
               normalized WebhookEvent
                          │
                          ▼
               grantCredits(userId, credits)
               update payments.status = 'succeeded'
```

### The interface (`PaymentProvider`)

Every adapter implements these four methods:

```typescript
createCheckout(input): CheckoutResult
  // Returns { flow, externalId, clientSecret?, hostedUrl? }
  // flow = 'elements' → mount Stripe Elements
  // flow = 'redirect' → send buyer to hostedUrl
  // flow = 'embedded' → reserved for future iframe flow

verifyAndParseWebhook(input): WebhookEvent | null
  // Verifies signature, normalizes payload to:
  // { type: 'payment.succeeded'|'payment.failed'|'payment.refunded',
  //   externalId, userId, credits, packageId, amountCents }

getMerchantBalance(): { available, pending, ... }
  // For admin dashboard. Stripe → balance + payouts.
  // Balance → available + receivables + pending invoices.

refund(externalId, amountCents): { refunded, refundId }
  // Issues a refund through the provider.
```

Adding a 3rd provider (Toss, PayPal, etc.) = one new file implementing this interface.

### Admin switch

```
admin.html "PG Settings" click Balance
              │
              ▼
  POST /api/admin/payment-provider
  { provider: 'balance' }
              │
              ▼
  UPDATE system_settings
  SET value = '"balance"'
  WHERE key = 'active_payment_provider'
              │
              ▼
  Next /api/payments/create-checkout
  call picks up Balance automatically
```

The switch is **global and immediate** — next checkout uses the new provider. In-flight checkouts complete against whichever provider started them (because PaymentIntent IDs, hosted URLs, etc. are externalized).

## Request lifecycle — image generation

```
User clicks "Generate" in browser
     │
     ▼
Frontend (apps/web/index.html)
  • Gathers: prompt, refImages, accImages, category, background, ratio
  • Gets JWT from Supabase client library
  • Calls MODLai.generate(modelKey, payload) for each selected model in parallel
     │
     ▼
Backend (apps/backend/api/generate/nanobanana.js)
  1. CORS + OPTIONS check
  2. envMiddleware — confirms GOOGLE_API_KEY is set
  3. requireAuth — verifies JWT, fetches user profile from Supabase
  4. deductCredits(userId, 30, 'generation') — atomic RPC
     │ (if credits insufficient → 402 error, no work done)
     ▼
  5. Call Gemini API with prompt + reference images
     │
     ▼
  6. On success → return { imageUrl, cost }
  6'. On failure → refundCredits + return error
     │
     ▼
Frontend
  • Renders image in the results grid
  • After all models done, calls /api/compare for Claude's analysis
  • User can rate / feedback / save / edit
```

## Data model

```
auth.users                ← Supabase Auth (email/OAuth)
    │
    ▼ (trigger)
users                     ← app profile (role, credits)
    │
    ├── fashion_models          (saved virtual models)
    │
    ├── generations             (one generation request)
    │       │
    │       ├── generation_results  (one per AI model)
    │       │       │
    │       │       └── edits       (chain of edits)
    │       │
    │       └── descriptions   (Claude-written copy)
    │
    ├── credit_transactions    (audit log)
    │
    └── payments               (Stripe + Balance)

-- Admin + config
system_settings              (active_payment_provider, etc)
credit_packages              (shared catalog)
admin_actions                (audit log)
```

## Storage

Two Supabase Storage buckets:

- **`generated-images`** — public, CDN-cached. AI outputs go here so they can be embedded in emails / product pages. Path: `{user_id}/{uuid}.png`.
- **`user-uploads`** — private, owner-only. Reference garment photos, model photos, accessory images. Path: `{user_id}/{uuid}.png`.

RLS rules enforce the `{user_id}/` prefix.

## Auth flow

```
1. User visits app → clicks Login
2. Supabase JS client → opens email form or Google OAuth
3. User authenticates → Supabase returns JWT + user record
4. Trigger `on_auth_user_created` creates public.users row
5. Frontend stores JWT in Supabase session (browser localStorage)
6. Every API call: fetch(..., { headers: { Authorization: `Bearer ${jwt}` }})
7. Backend requireAuth() → supabase.auth.getUser(jwt) → profile lookup
```

## Admin model

Admins get `role='admin'` in `public.users`. RLS policies check `is_admin(auth.uid())` and allow wider access:

- See all users, all generations, all payments
- Switch active PG (stripe ↔ balance)
- Grant/revoke credits manually
- Block/unblock users

All admin actions are logged to `admin_actions` table.

To promote someone: run `apps/backend/supabase/make-admin.sql` with their email.

## Scaling considerations

Current setup scales to roughly:
- **1000 concurrent users** — Vercel free tier (100GB-hrs)
- **500MB DB** — Supabase free tier
- **1GB storage** — Supabase free tier

When you hit those limits:
- Vercel Pro ($20/mo): unlimited
- Supabase Pro ($25/mo): 8GB DB, 100GB storage, daily backups

At ~10K active users / month, infrastructure cost is still under $100/mo.

## Fashion Model consistency (character sheets)

MODLai solves the "same model, different face every generation" problem by generating a **character sheet** — 4+ reference images at different angles — when a model is first saved. These sheets are then auto-injected as refImages in every future generation using that model.

```
First time model is saved
         │
         ▼
Claude enriches short description → rich visual description
         │
         ▼
Nano Banana generates 4 angles (front → 3/4 → side → full_body)
  Each angle uses the previous image as seed for identity lock
         │
         ▼
4 images uploaded to Supabase Storage (generated-images bucket)
         │
         ▼
fashion_model_sheets rows inserted
fashion_models.status = 'ready'

─────────────────────────────────────────

Later, user generates with this model
         │
         ▼
POST /api/generate/nanobanana { fashionModelId }
         │
         ▼
Backend loads sheet images → injects into refImages
Backend prepends identity description to prompt
         │
         ▼
AI generates with identity locked
```

Detailed behavior in [05-fashion-models.md](./05-fashion-models.md).

## Channel publishing (Shopify + Faire)

MODLai extends to external e-commerce platforms via a `PublishChannel` abstraction — the same pattern as `PaymentProvider`.

```
Generate result card → [Publish] button
            │
            ▼
  POST /api/publish/preview { generationId, channel }
            │
            ▼
  buildCanonicalProduct() assembles CanonicalProduct from:
    - generations (title, etc)
    - descriptions (Claude-written copy)
    - generation_commerce_meta (SKU, price, inventory - user input)
    - generation_results (image URLs)
            │
            ▼
  adapter.preview(product, connection)
    → returns { payload, warnings, errors, effective }
            │
            ▼
  Frontend shows diff view + validation issues
            │
            ▼
  User clicks [Publish →]
            │
            ▼
  POST /api/publish/execute { generationId, channel, confirm: true }
            │
            ▼
  adapter.publish(product, connection)
    → POST to Shopify/Faire API
            │
            ▼
  publishings row updated with external_product_id, external_url
            │
            ▼
  User can click through to platform admin
```

Each channel adapter maps CanonicalProduct → platform payload. See [06-publishing.md](./06-publishing.md) for details.

Adding a new channel (Magento, FashionGo, etc.) = one new file implementing `PublishChannel` interface. Everything else — commerce form, preview UI, publishings table — stays the same.

## Insights & AI Diagnosis

MODLai extends beyond generation into **AI-driven merchandising**: pull store data, get Claude-powered analysis of what's working and what isn't.

```
Every 6h (Vercel cron) OR user clicks [Sync]
            │
            ▼
Loop active channel_connections
            │
            ▼
PlatformDataSource (abstract)
  ShopifyDataSource — fetches products, orders, customers
  FaireDataSource   — stub, Phase 4
            │
            ▼
sync-engine.js — pagination + upsert + job tracking
            │
            ▼
external_products / external_orders / external_customers cached
            │
            ▼
rebuildProductAnalytics() → product_analytics_daily
            │
            ▼
product_performance view auto-aggregates 30-day metrics
            │
            ▼
─────────────────────────────────────────
User views Insights dashboard:
  - KPIs (revenue, orders, AOV)
  - Top 10 performers + Underperformers
  - Category breakdown
  - AI recommendations
            │
            ▼
User clicks [AI 진단] on a product
            │
            ▼
POST /api/insights/diagnose  (20 credits)
  → Claude (vision + text) analyzes:
    • Primary image quality
    • Title & description
    • Tags & pricing
    • Sales metrics
  → Returns structured JSON:
    • Overall score
    • Issues (severity + evidence)
    • Strengths
    • Recommendations (with action_type + suggested_prompt)
            │
            ▼
Saved to ai_diagnoses table (cached)
```

`PlatformDataSource` mirrors the `PublishChannel` abstraction — publishing WRITES to platforms, data sources READ from them. A platform can support both (Shopify), one, or neither.

Detail: [07-insights.md](./07-insights.md)

## Product Catalog + Import

The `product_masters` table is MODLai's internal source of truth for products — independent of any channel. A master stays forever once imported (soft delete only).

```
CSV/XLSX upload
     │
     ▼
file-parser.js
  - Strip UTF-8 BOM
  - Auto-detect delimiter (, / tab / ;)
  - Score first 5 rows for header detection
  - Emit: columns[] + rows[]
     │
     ▼
target-schema.js
  heuristicMap() — match aliases (price1 → wholesale_price)
  aiMap()        — Claude refines with sample values
     │
     ▼
User reviews + edits mapping in UI
     │
     ▼
import-engine.js
  applyMapping() — normalize column keys
  detectGranularity() — master vs master_with_variants
  runImport() — upsert to product_masters (+ variants)
     │
     ▼
product_masters (source of truth)
     │
     └─── linked FROM everywhere:
          ├── product_master_generations (N:M to AI images)
          ├── publishings.master_id       (channel publish status)
          ├── external_products.master_id (synced-back external)
          ├── ai_diagnoses.master_id      (Claude analysis)
          └── product_master_errors       (auto-logged failures)
```

### Data preservation

Every FK to `product_masters` uses `ON DELETE SET NULL`, and the master itself uses soft delete (`is_archived = true`). This means:
- A generation can be deleted without losing the master
- An import_job can be purged without losing products
- Archiving a master keeps all its linked data for audit

### Unified status view

`product_masters_with_status` pre-aggregates into a single query:
- Generation count
- Publish status array (channel, status, external_url, error)
- Unresolved error count
- Latest diagnosis score

So Catalog cards render from one query without N+1.

### Triggers

Two PL/pgSQL triggers keep denormalized fields consistent:
1. **`sync_master_primary_generation`** — when a `product_master_generations` row is inserted/updated with `role='primary'`, updates the master's `primary_generation_id` + `primary_image_url`
2. **`log_publishing_error`** — when a `publishings` row goes to `status='failed'` with a `master_id`, auto-inserts into `product_master_errors`

Detail: [08-imports.md](./08-imports.md)

## What's NOT built yet

- **Real Supabase Storage uploads** — currently images round-trip as data URLs. The helper `uploadGeneratedImage()` exists in `_lib/utils.js`; just needs to be called from generate endpoints.
- **Login/signup UI for main app** — admin.html has it, index.html doesn't (currently relies on demo mode).
- **Email notifications** — for purchases, failed payments, low credits
- **Rate limiting** — prevent abuse (recommend Upstash Redis)
- **Image moderation** — NSFW detection on outputs
- **Sentry / error tracking** — currently just `console.error`
- **Test suite** — no tests yet
- **Shopify/Cafe24 export** — publish generated products to e-commerce stores
