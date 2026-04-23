# MODLai

AI-powered fashion image generation platform with multi-model comparison (Nano Banana, OpenAI, Stability), automatic product descriptions, and a credit-based economy.

**한국어/English** · **Light Forest theme** · **Stripe + Balance billing** · **Supabase backed**

---

## 📐 Architecture

```
┌─────────────────────────────────────────────────────────┐
│  apps/web                                                │
│    - index.html  — end-user fashion studio              │
│    - admin.html  — operator dashboard                    │
└────────────────────────────┬────────────────────────────┘
                             │ HTTPS (JWT)
                             ▼
┌─────────────────────────────────────────────────────────┐
│  apps/backend       Vercel serverless functions          │
│    /api/generate/*     AI image generation proxies       │
│    /api/edit          AI image editing                   │
│    /api/refine-prompt  Claude prompt refinement          │
│    /api/compare        Claude result comparison          │
│    /api/description    Claude product copy               │
│    /api/models/*       Fashion models + character sheets │
│    /api/channels/*     Shopify/Faire store connections   │
│    /api/publish/*      Push products to channels         │
│    /api/datasources/*  Sync data FROM channels           │
│    /api/insights/*     Analytics + AI diagnosis          │
│    /api/imports/*      CSV/XLSX import + product masters │
│    /api/payments/*     Unified checkout (Stripe|Balance) │
│    /api/admin/*        Admin dashboard APIs              │
└────────────────────────────┬────────────────────────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
        ┌──────────┐  ┌────────────┐  ┌──────────────┐
        │ Supabase │  │ AI models  │  │ Stripe |     │
        │  (auth + │  │ (Google,   │  │ Balance      │
        │   DB +   │  │  OpenAI,   │  │ (admin picks │
        │  storage)│  │ Stability) │  │  one)        │
        └──────────┘  └────────────┘  └──────────────┘
```

Admin switches the active payment provider at runtime. Stripe and Balance both implement the same `PaymentProvider` interface, so the rest of the app stays unchanged regardless of which is live.

## 🎯 What's inside

| Path | Description |
|---|---|
| `apps/web/index.html` | Single-file fashion studio. Mock mode works without backend. |
| `apps/web/admin.html` | Operator dashboard — stats, balance, PG switch, users, payments. |
| `apps/backend/` | Vercel serverless API (Node 20). |
| `apps/backend/api/_lib/providers/` | `PaymentProvider` abstraction with Stripe + Balance adapters. |
| `apps/backend/supabase/` | SQL migrations (schema, storage, payment providers). |
| `docs/` | Setup guides, architecture notes. |

## 🚀 Quick start

### Option A — Just run the frontend (mock mode, no setup)

```bash
open apps/web/index.html        # End-user app
open apps/web/admin.html        # Admin dashboard
```

Both work with fake data. Good for design review and UX testing.

### Option B — Real deployment (30 min setup)

1. **Set up Supabase** → [docs/01-supabase-setup.md](docs/01-supabase-setup.md)
2. **Set up AI providers** → [docs/02-ai-keys.md](docs/02-ai-keys.md)
3. **Set up Stripe** → [docs/03-stripe-setup.md](docs/03-stripe-setup.md) (primary PG)
4. **Optionally request Balance access** → [docs/04-balance-setup.md](docs/04-balance-setup.md) (B2B Net-terms alternative)
5. **Deploy backend**:
   ```bash
   cd apps/backend
   npm install
   cp .env.example .env.local    # paste your keys
   npm run dev                   # http://localhost:3000
   ```
6. **Configure frontend** — edit `apps/web/index.html` and `apps/web/admin.html`:
   ```js
   window.MODLAI_API_BASE = 'http://localhost:3000/api';
   window.MODLAI_USE_MOCK = false;
   window.SUPABASE_URL = 'https://xxxxx.supabase.co';
   window.SUPABASE_ANON_KEY = 'eyJ...';
   ```

## 💳 Payment Provider Switching

MODLai supports two PGs through a single unified interface:

- **Stripe** — instant card payment, good for individuals/SMB
- **Balance** — B2B Net 30/60/90 invoicing, good for enterprise

Only one is active at a time. Admin switches via the dashboard:

1. Log into `admin.html`
2. Go to **PG Settings**
3. Click the provider card to switch

Packages (`starter`, `pro`, `studio`, `enterprise_50k`) are shared between providers. The only PG-specific field is `is_enterprise` — these packages are only purchasable when Balance is active.

## 🎭 Fashion Models — Character Sheet Consistency

MODLai solves a common AI-generation problem: "same model, different face every time."

When you create a virtual model, the system auto-generates a **character sheet** — 4 reference images at different angles (front, 3/4, side, full-body). These are stored permanently and auto-injected into every future generation using that model, so the face/body stays identical.

- Save a model once (120 credits for the sheet)
- Reuse unlimited times (no extra cost)
- Works best with Nano Banana
- See [docs/05-fashion-models.md](docs/05-fashion-models.md) for details

## 🚀 Push to Shopify + Faire

Publish your AI-generated products directly to external platforms.

- **Shopify** — B2C D2C store (card payment, 완전 구현)
- **Faire** — B2B wholesale marketplace (Net 30 invoicing)
- **Preview-first UX** — see exactly what will be sent before pushing
- Abstracted via `PublishChannel` interface, so adding Magento/FashionGo later = one new adapter file
- Products always go as **draft** first — you review on the platform before going live
- See [docs/06-publishing.md](docs/06-publishing.md) for details

## 📈 Insights & AI Diagnosis

Pull your store's data (products, orders, customers) and get Claude-powered analysis of what's working.

- **Auto-sync every 6h** via Vercel cron (or manual trigger)
- **Dashboard** — KPIs, top performers, underperformers, category breakdown
- **AI Diagnosis** — Claude vision + text analyzes each product's image, copy, tags, pricing, and sales metrics (20 credits per diagnosis)
- Returns structured score + issues + actionable recommendations
- **Recommendations feed back into Generate** — one-click to create improved version
- Abstract `PlatformDataSource` — mirror of `PublishChannel`, ready for more platforms
- See [docs/07-insights.md](docs/07-insights.md) for details

## 📥 Product Catalog & Import

Your internal source of truth for products — independent of any channel.

- **Drag-drop import** of CSV/XLSX (ERP exports, Fashiongo templates, custom line sheets)
- **Claude auto-maps** columns — even unusual naming like `sgtRetailPrice`, `sizecat`, `bundle`
- **Robust parsing** — BOM, tab/semicolon delimiters, messy header rows
- **Master + Variants** support — auto-detects if file is style-level or SKU-level
- **Linked data survives** — once imported, every generated image, publish attempt, and AI diagnosis links TO the master. Nothing ever orphans.
- **Catalog cards** show at a glance: AI images count, 🟢 Shopify / 🟠 Faire publish status, ⚠ error count, 🔍 diagnosis score
- **Master Detail view** — click any card to see full history, regenerate images, re-diagnose
- See [docs/08-imports.md](docs/08-imports.md) for details

## 🔐 Production infrastructure

MODLai is a real SaaS, not a demo. The following services make it work:

- **Supabase Auth** — email/password + Google OAuth login (see `#authOverlay` in `index.html`)
- **Supabase Storage** — generated images hosted at stable public URLs (required for Faire publishing)
- **Resend** — branded transactional emails for invitations and welcome messages (3,000/month free)
- **Stripe** (or Balance) — credit purchases via `PaymentProvider` abstraction

All services fail gracefully in dev. If Supabase keys aren't set, the UI runs without auth. If Resend isn't configured, invitation URLs are shown as a `prompt()` for manual sharing. If storage upload fails, the image is returned as a `data:` URL (still works in-app, just won't publish to Faire).

See [docs/11-storage-and-email.md](docs/11-storage-and-email.md) for production setup.

## 🎯 AI Diagnosis → Site Application

Close the loop: not just get insights, but apply them to your live products.

- **One-click Apply** per recommendation in the AI Diagnosis modal
- **Smart previews**:
  - Title/Description rewrites → Claude generates 3 variants, you pick one
  - Tag updates → side-by-side comparison with checkboxes
  - Price adjustments → impact estimate shown
  - Image regen → jumps to Generate with prompt pre-filled
- **Channel push** — when applied, changes are pushed to Shopify automatically
- **Full audit trail** — every application recorded with before/after snapshots for rollback and impact measurement
- See [docs/10-recommendations.md](docs/10-recommendations.md) for details

## 🏢 Multi-tenancy (Organizations)

MODLai supports multiple companies on a single deployment.

- **Organization = tenant** — each brand gets isolated catalog, channels, models, and credits
- **1 user = 1 org** (enforced at DB level). You, as platform admin, can cross into any org via `X-Org-Id` header
- **3 roles**: owner (can delete org), admin (manage settings/members), member (create & publish)
- **Credit pool per org** — shared across all members
- **Email invitations** with 7-day token, email verification on accept
- **Settings page** consolidates everything: org info, members, channel connections, billing
- See [docs/09-organizations.md](docs/09-organizations.md) for details

## 🧭 Where to go next

- **Setting up:** [docs/SETUP.md](docs/SETUP.md)
- **Understanding code:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **Customizing:** frontend is single-file HTML at `apps/web/`. Colors, fonts, i18n strings at the top.

## 📜 License

Private — all rights reserved.
