# Stripe Setup

Handle credit purchases with Stripe. Test mode is free and works with fake card numbers.

## 1. Create a Stripe account

https://dashboard.stripe.com/register

You don't need to activate the account (submit real business info) to test.

## 2. Get test keys

1. Dashboard top-right — make sure you're in **Test mode** (toggle)
2. **Developers** → **API keys**
3. Copy:
   - `STRIPE_PUBLISHABLE_KEY` — `pk_test_...` (safe to expose)
   - `STRIPE_SECRET_KEY` — `sk_test_...` (server only!)
4. Add to `.env.local`

## 3. Set up webhook

The webhook is how Stripe tells your backend "payment succeeded, grant credits."

### Local development

Install the Stripe CLI: https://stripe.com/docs/stripe-cli

```bash
stripe login
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

It will print a webhook signing secret like `whsec_...`. Copy it:

```env
STRIPE_WEBHOOK_SECRET=whsec_...
```

Keep the `stripe listen` command running while you test.

### Production

1. Dashboard → **Developers** → **Webhooks** → **Add endpoint**
2. URL: `https://your-backend.vercel.app/api/stripe/webhook`
3. Events: select `payment_intent.succeeded` and `payment_intent.payment_failed`
4. After creating, click the endpoint → **Signing secret** → reveal → copy
5. Set `STRIPE_WEBHOOK_SECRET` in Vercel env vars

## 4. Test the flow

With backend running and `stripe listen` going:

1. Open `apps/web/index.html`
2. Click **+ 충전** in the sidebar
3. Pick a package → click **$X 결제하기**
4. Enter test card: `4242 4242 4242 4242`, any future expiry, any CVC
5. Watch the `stripe listen` terminal — you should see `payment_intent.succeeded`
6. Check the Supabase `payments` table — a row should exist
7. Check the Supabase `users` table — credits should increase

## Test cards

| Card | Outcome |
|---|---|
| `4242 4242 4242 4242` | Success |
| `4000 0000 0000 9995` | Declined (insufficient funds) |
| `4000 0025 0000 3155` | Requires 3D Secure |

## Going live

1. Complete Stripe activation (business info, bank account)
2. Toggle Dashboard to **Live mode**
3. Get new live keys (`pk_live_...`, `sk_live_...`)
4. Create a new webhook pointing to production
5. Update Vercel env vars with live values
6. Redeploy

## Handling refunds

Refunds today: done manually from Stripe Dashboard. To make it automated:

1. Subscribe the webhook to `charge.refunded`
2. In `api/stripe/webhook.js`, add a case that calls `grantCredits(userId, -credits, 'refund', ...)` to deduct the credits back

(Not implemented yet — add when you need it.)
