// POST /api/payments/webhook/[provider]
// Unified webhook handler. Stripe points to /webhook/stripe, Balance to /webhook/balance.
//
// Each provider's adapter does signature verification and parses the event into
// a normalized WebhookEvent shape, then we:
//   1. Upsert the payments row (idempotent - multiple webhook deliveries are safe)
//   2. On 'payment.succeeded' → grantCredits (which also writes credit_transactions)
//   3. On 'payment.refunded'  → grantCredits(-credits, 'refund')
//   4. On 'payment.failed'    → mark payment failed, no credit change

import { grantCredits, getSupabaseAdmin } from '../../_lib/utils.js';
import { getProviderByName } from '../../_lib/providers/index.js';

export const config = {
  api: { bodyParser: false },  // need raw body for signature verification
};

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // Vercel dynamic routing: /api/payments/webhook/[provider] → req.query.provider
  // Fallback: parse from URL if running under different framework
  const providerName = req.query?.provider
    || (req.url?.match(/\/webhook\/([^/?]+)/) || [])[1];

  if (!providerName) {
    return res.status(400).json({ error: 'missing_provider' });
  }
  if (!['stripe', 'balance'].includes(providerName)) {
    return res.status(400).json({ error: 'unknown_provider', provider: providerName });
  }

  let provider;
  try {
    provider = getProviderByName(providerName);
  } catch (err) {
    console.error('[webhook] provider not configured:', err.message);
    return res.status(500).json({ error: 'provider_not_configured', detail: err.message });
  }

  let event;
  try {
    const rawBody = await getRawBody(req);
    event = await provider.verifyAndParseWebhook({ rawBody, headers: req.headers });
  } catch (err) {
    console.error(`[webhook:${providerName}] signature/parse failed:`, err.message);
    return res.status(400).json({ error: 'invalid_webhook', detail: err.message });
  }

  // Ignored event type - acknowledge anyway so provider stops retrying
  if (!event) return res.status(200).json({ received: true, handled: false });

  const admin = await getSupabaseAdmin();

  try {
    // 1. Upsert payments row (idempotent)
    if (admin) {
      const status = event.type === 'payment.succeeded' ? 'succeeded'
                   : event.type === 'payment.failed'    ? 'failed'
                   : event.type === 'payment.refunded'  ? 'refunded'
                   : 'pending';

      await admin.from('payments').upsert({
        user_id:         event.userId,
        provider:        providerName,
        external_id:     event.externalId,
        amount_cents:    event.amountCents,
        credits_granted: event.credits,
        package_id:      event.packageId,
        status,
        failure_reason:  event.reason || null,
        ...(event.type === 'payment.succeeded' ? { paid_at: new Date().toISOString() } : {}),
      }, { onConflict: 'provider,external_id' });
    }

    // 2. Credit operations
    if (event.type === 'payment.succeeded' && event.userId && event.credits > 0) {
      try {
        await grantCredits(event.userId, event.credits, 'purchase', {
          referenceId: event.externalId,
          stripePaymentIntentId: providerName === 'stripe' ? event.externalId : null,
          note: `Package ${event.packageId} via ${providerName}`,
        });
        console.log(`[webhook:${providerName}] granted ${event.credits} credits to ${event.userId}`);
      } catch (err) {
        console.error('[webhook] grantCredits failed:', err);
      }
    }

    if (event.type === 'payment.refunded' && event.userId && event.credits > 0) {
      try {
        // Deduct the previously-granted credits
        await grantCredits(event.userId, -event.credits, 'refund', {
          referenceId: event.externalId,
          note: `Refund ${providerName} ${event.externalId}`,
        });
      } catch (err) {
        console.error('[webhook] refund credit deduction failed:', err);
      }
    }

    return res.status(200).json({ received: true, handled: true, type: event.type });

  } catch (err) {
    console.error(`[webhook:${providerName}] handler error:`, err);
    return res.status(500).json({ error: 'handler_failed', detail: err.message });
  }
}
