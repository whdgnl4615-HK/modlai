# Balance Setup (Optional — B2B Net Terms)

Balance (getbalance.com) is a B2B payments platform. Unlike Stripe, it specializes in **Net 30/60/90 invoicing** — buyers get goods/services upfront and pay later, while you get paid instantly (Balance absorbs the credit risk).

**Who should enable Balance?** Only if you have (or are pursuing) **enterprise customers** who need invoiced payment terms (law firms, agencies, wholesalers, corporations with AP teams). For individual/SMB customers, stick with Stripe.

---

## 1. Request API access

Balance's API documentation is gated. You need to request access:

1. Visit https://www.getbalance.com/get-api/
2. Fill out the form (company name, use case, expected volume)
3. Balance's sales team will contact you within a few business days
4. They'll grant you access to the dashboard (dashboard.getbalance.com) and API keys

**What to say in your application:**
> "We're a SaaS platform serving fashion brands. We want to offer enterprise customers Net 30 invoiced purchases for credit packages ($500+/mo). Expected volume: [X] invoices/month at average $Y."

You'll likely need:
- A registered business entity (LLC, Corp, Ltd)
- Basic KYB (know-your-business) documents
- A US bank account for settlement (check if non-US is supported)

## 2. Get API credentials

Once approved, your Balance dashboard will provide:

- **API Key** — for backend calls to `api.getbalance.com`
- **Webhook Secret** — for verifying incoming webhooks
- **Webhook URL** — you'll point to `https://your-backend.vercel.app/api/payments/webhook/balance`

Add to `.env.local`:
```env
BALANCE_API_KEY=<your-api-key>
BALANCE_API_BASE=https://api.getbalance.com/v2
BALANCE_WEBHOOK_SECRET=<your-webhook-secret>
BALANCE_TERMS_DAYS=30
```

`BALANCE_TERMS_DAYS` = default Net terms (30, 45, 60, or 90).

## 3. Configure webhook endpoint in Balance dashboard

1. Log into Balance dashboard
2. Navigate to Webhooks (or API Settings)
3. Add endpoint: `https://your-backend.vercel.app/api/payments/webhook/balance`
4. Subscribe to events:
   - `transaction.paid` (or `invoice.paid`) — buyer paid the invoice
   - `transaction.failed` (or `invoice.failed`) — payment failed
   - `refund.created` — refund issued
5. Copy the signing secret → set as `BALANCE_WEBHOOK_SECRET`

## 4. Activate in MODLai

1. Log into the admin dashboard (`admin.html`)
2. Go to **PG Settings**
3. Balance card should now say "Configured" (because env vars are set)
4. Click the Balance card to switch

That's it. New checkout attempts will now go through Balance.

---

## ⚠️ Important: API spec confirmation

The `balance-provider.js` adapter was built from **publicly available information** about Balance's API. Several field names and endpoint paths are educated guesses marked with `TODO:DOC-CONFIRM` comments.

**When you receive the official API docs, please verify these in `apps/backend/api/_lib/providers/balance-provider.js`:**

- [ ] `API_BASE` (assumed `https://api.getbalance.com/v2`)
- [ ] Checkout endpoint path (assumed `POST /checkout`)
- [ ] Request body field names for transaction creation (amount, currency, customer, metadata, success_url)
- [ ] Response field names (id, status, hosted_url, due_date)
- [ ] Webhook signature header name (assumed `balance-signature`)
- [ ] Webhook signature algorithm (assumed HMAC-SHA256 over raw body)
- [ ] Webhook event type names (assumed `transaction.paid`, `invoice.paid`, etc.)
- [ ] Balance retrieval endpoint (assumed `GET /balance`)
- [ ] Refund endpoint (assumed `POST /refunds`)

Each of these is a single-line fix. The surrounding logic (credit grant, payment row upsert, idempotency) doesn't depend on the exact shape.

## Cash flow implication

**Stripe**: buyer pays immediately, Stripe takes fee (~2.9% + 30¢), you get paid 2-7 days later.

**Balance**: buyer gets an invoice with Net X terms. **You can choose:**
- **Balance upfront** — Balance pays you now, collects from buyer later. Costs ~3-5% fee. (Recommended for cash flow.)
- **Wait until paid** — No fee, but you carry the receivable for 30-90 days.

Configure this preference in the Balance dashboard, not in MODLai code. The backend treats both modes the same way: credits get granted when you receive the `payment.succeeded` webhook.

## Testing without production account

Balance does provide sandbox keys once you're approved. Until then:

- Keep `MODLAI_USE_MOCK = true` for admin UI work
- Balance provider code validates even without credentials (constructor will throw; admin UI marks it "not configured")
- Once you have sandbox keys, the same `.env.local` vars apply (Balance uses key prefix to distinguish test/live)

## What if I never get Balance?

Totally fine. MODLai works great with just Stripe. The Balance adapter sits there unused and costs nothing.
