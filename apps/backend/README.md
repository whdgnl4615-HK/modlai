# MODLai Backend

Serverless functions (Vercel) that proxy to AI providers, handle unified payments (Stripe + Balance), and sync with Supabase.

## Endpoints

### AI generation
| Method | Path | Purpose | Cost |
|---|---|---|---|
| POST | `/api/generate/nanobanana` | Gemini 2.5 Flash Image | 30 cr |
| POST | `/api/generate/openai` | gpt-image-1 | 50 cr |
| POST | `/api/generate/stability` | Stable Image Ultra | 20 cr |
| POST | `/api/edit` | Nano Banana edit | 30 cr |
| POST | `/api/refine-prompt` | Claude prompt refinement | free |
| POST | `/api/compare` | Claude compares results | free |
| POST | `/api/description` | Claude product copy | 10 cr |

### Payments (unified)
| Method | Path | Purpose |
|---|---|---|
| GET  | `/api/payments/config` | Active PG + package list |
| POST | `/api/payments/create-checkout` | Start checkout (any PG) |
| POST | `/api/payments/webhook/stripe` | Stripe webhook endpoint |
| POST | `/api/payments/webhook/balance` | Balance webhook endpoint |

### Fashion Models
| Method | Path | Purpose | Cost |
|---|---|---|---|
| GET  | `/api/models` | List user's models | - |
| POST | `/api/models` | Create model (draft, no sheet yet) | - |
| GET  | `/api/models/:id` | Model + sheets | - |
| PATCH| `/api/models/:id` | Update fields | - |
| DELETE| `/api/models/:id` | Archive (soft delete) | - |
| POST | `/api/models/:id/generate-sheet` | Generate character sheet (4 angles) | 120 cr |

### Channel connections & publishing
| Method | Path | Purpose |
|---|---|---|
| GET  | `/api/channels` | List user's connections |
| POST | `/api/channels` | Add/update connection (tests first) |
| GET  | `/api/channels/:channel` | Test existing connection |
| DELETE | `/api/channels/:channel` | Remove connection |
| GET  | `/api/generations/:id/commerce` | Load commerce meta (price, SKU, etc) |
| PUT  | `/api/generations/:id/commerce` | Save commerce meta |
| POST | `/api/publish/preview` | Preview mapped payload (no send) |
| POST | `/api/publish/execute` | Actually publish to channel |
| GET  | `/api/publish/history` | List past publishings |

### Data sync (read FROM channels)
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/datasources/sync` | Trigger sync (products/orders/customers) |
| GET  | `/api/datasources/status` | Last sync status + counts |
| GET  | `/api/datasources/cron` | Scheduled job (Vercel cron every 6h) |

### Insights (analytics + AI diagnosis)
| Method | Path | Purpose | Cost |
|---|---|---|---|
| GET  | `/api/insights/dashboard` | KPIs + top/bottom performers + recs | - |
| GET  | `/api/insights/products` | Paginated product list | - |
| POST | `/api/insights/diagnose` | Claude analyzes a product/master | 20 cr |

### Product catalog + imports
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/imports/upload` | Parse CSV/XLSX + AI-map columns |
| POST | `/api/imports/execute` | Run import with final mapping |
| GET  | `/api/imports/history` | Past import jobs |
| GET  | `/api/imports/masters` | List masters with publish/error/diag status |
| GET  | `/api/imports/masters/:id` | Master + generations + diagnoses + errors |
| PATCH | `/api/imports/masters/:id` | Update master fields |
| DELETE | `/api/imports/masters/:id` | Soft archive (`?permanent=true` for hard) |
| POST | `/api/imports/bulk` | Bulk archive / unarchive / delete |
| POST | `/api/imports/masters/:id/link-generation` | Link AI image to master |

### Organizations (multi-tenancy)
| Method | Path | Purpose |
|---|---|---|
| GET  | `/api/organizations` | Current user's org (null if none) |
| POST | `/api/organizations` | Create new org (becomes owner + 100cr bonus) |
| GET  | `/api/organizations/:id` | Org details + stats |
| PATCH | `/api/organizations/:id` | Update name/logo/email/settings |
| GET  | `/api/organizations/:id/members` | List members |
| POST | `/api/organizations/:id/members` | Change role |
| DELETE | `/api/organizations/:id/members?userId=` | Remove member |
| GET  | `/api/organizations/:id/invitations` | Pending invites |
| POST | `/api/organizations/:id/invitations` | Invite by email |
| DELETE | `/api/organizations/:id/invitations?inviteId=` | Revoke invite |
| POST | `/api/invitations/accept` | Accept invite via token |

### Recommendations (AI diagnosis → site apply)
| Method | Path | Purpose | Cost |
|---|---|---|---|
| POST | `/api/recommendations/apply` | Preview or commit a recommendation | - (indirect Claude usage) |
| GET  | `/api/recommendations/history` | Past applications with before/after | - |

### Admin
| Method | Path | Purpose |
|---|---|---|
| GET  | `/api/admin/stats` | Dashboard metrics |
| GET  | `/api/admin/balance?provider=...` | Merchant balance for a PG |
| GET  | `/api/admin/payment-provider` | Current PG + config status |
| POST | `/api/admin/payment-provider` | Switch active PG |
| GET  | `/api/admin/users?q=...` | Search users |
| POST | `/api/admin/users` | Grant credits, block, etc |
| GET  | `/api/admin/payments` | List all payments |

## Quickstart

```bash
npm install
cp .env.example .env.local
# Fill in API keys
npm run dev
# → http://localhost:3000
```

Without env vars, requests return a helpful 500 telling you which key is missing.
Without Supabase env vars, `requireAuth` falls back to demo mode — useful for smoke tests.

## Deploy

```bash
npm run deploy
```

Set env vars in Vercel dashboard (Settings → Environment Variables).

## Payment provider abstraction

`api/_lib/providers/` contains:

- `payment-provider.js` — abstract interface (`createCheckout`, `verifyAndParseWebhook`, `getMerchantBalance`, `refund`)
- `stripe-provider.js` — Stripe adapter
- `balance-provider.js` — Balance (getbalance.com) adapter
- `index.js` — factory reading `system_settings.active_payment_provider`

To add a third provider:

1. Create `providers/yourprovider.js` implementing the 4 methods
2. Register it in `providers/index.js`
3. Add a `check` policy to `system_settings` CHECK constraint via migration
4. That's it — the rest of the app works automatically

## Architecture

- **Stateless functions** — each endpoint is independent. Scale horizontally.
- **Atomic credits** — `deduct_credits` / `grant_credits` Postgres RPCs prevent races.
- **RLS everywhere** — Supabase Row-Level Security means users only see their own data.
- **Idempotent webhooks** — upsert keyed by `(provider, external_id)`.
- **PG agnostic** — frontend doesn't know or care which provider is active.

See [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) for more.

## Development notes

- All AI response images are returned as `data:` URLs. In production (after Supabase Storage is wired up) they'll be uploaded and returned as `https://` URLs instead. See `uploadGeneratedImage()` in `api/_lib/utils.js`.
- Every endpoint deducts credits _before_ the expensive call and refunds on failure. Credits are the source of truth for billing.
- `envMiddleware()` fails fast with a friendly error if a key is missing.
- Balance adapter has `TODO:DOC-CONFIRM` comments on speculative fields — see `docs/04-balance-setup.md` for the update checklist.
