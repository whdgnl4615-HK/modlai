# MODLai Setup Guide

Full setup takes about **30 minutes** end-to-end.

1. [Supabase (auth + DB + storage)](./01-supabase-setup.md) — 15 min
2. [AI provider keys](./02-ai-keys.md) — 5 min
3. [Stripe billing](./03-stripe-setup.md) — 10 min
4. [Balance billing (optional)](./04-balance-setup.md) — only if you want B2B Net terms
5. [Fashion Models guide](./05-fashion-models.md) — reference for the character sheet feature
6. [Publishing to Shopify + Faire](./06-publishing.md) — push products to external platforms
7. [Insights & AI Diagnosis](./07-insights.md) — analyze store data and get AI recommendations
8. [Product Import (CSV/XLSX)](./08-imports.md) — bulk import product catalogs with AI-assisted column mapping
9. [Multi-tenancy (Organizations)](./09-organizations.md) — companies, members, invitations, roles
10. [Recommendation Application](./10-recommendations.md) — closing the loop: AI diagnosis → applied changes on the site
11. [Storage & Email Setup](./11-storage-and-email.md) — Supabase Storage for generated images, Resend for emails

## Order of operations

Do these in order. Each step depends on the previous one.

### Step 1 — Supabase (required first)

Creates the database, auth, and file storage your backend needs.

→ [Follow 01-supabase-setup.md](./01-supabase-setup.md)

**You'll end up with:** 3 environment variables (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`), a working login, and empty tables ready for data.

**Important:** The guide runs 3 SQL files in order — `schema.sql`, `schema-storage.sql`, and `migration-002-payment-providers.sql`. Don't skip the last one — it's what makes the Stripe ↔ Balance switch possible.

### Step 2 — AI providers

Get API keys for at least one of the three image models. You can skip providers you don't want.

→ [Follow 02-ai-keys.md](./02-ai-keys.md)

**You'll end up with:** 1-4 more env vars (`ANTHROPIC_API_KEY` is required; others are optional).

### Step 3 — Stripe (primary PG)

Required for real payments. Skip entirely for demo/testing.

→ [Follow 03-stripe-setup.md](./03-stripe-setup.md)

**You'll end up with:** 3 more env vars and a webhook endpoint at `/api/payments/webhook/stripe`.

### Step 4 — Balance (optional B2B alternative)

Only if you have enterprise customers who need Net 30/60/90 invoicing. Requires request-based API access.

→ [Follow 04-balance-setup.md](./04-balance-setup.md)

**You'll end up with:** 4 more env vars and a webhook endpoint at `/api/payments/webhook/balance`.

### Step 5 — Run it

```bash
cd apps/backend
npm install
cp .env.example .env.local
# paste all the env vars you collected above
npm run dev
# → http://localhost:3000
```

Open the frontend:

- `apps/web/index.html` — end-user fashion studio
- `apps/web/admin.html` — operator dashboard (for you)

For both, edit the top of the file:

```js
window.MODLAI_API_BASE = 'http://localhost:3000/api';
window.MODLAI_USE_MOCK = false;
window.SUPABASE_URL = 'https://xxxxx.supabase.co';
window.SUPABASE_ANON_KEY = 'eyJ...';
```

### Step 6 — Promote yourself to admin

First log into the main app so your `auth.users` row exists, then run:

```sql
-- In Supabase SQL Editor
update public.users set role = 'admin' where email = 'you@example.com';
```

Now you can log into `admin.html`.

### Step 7 — Choose your PG

Go to `admin.html` → **PG Settings** → click Stripe or Balance.

(Stripe is the default. You only see Balance as "Configured" once you've set the Balance env vars.)

### Step 8 — Deploy

```bash
cd apps/backend
npm run deploy
```

Set env vars in Vercel dashboard. Configure production webhook URLs in Stripe/Balance dashboards to point at your Vercel URL.

## Need to understand the architecture first?

→ [Read ARCHITECTURE.md](./ARCHITECTURE.md)
