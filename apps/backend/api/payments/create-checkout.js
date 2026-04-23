// POST /api/payments/create-checkout
// Creates a checkout session using the currently-active payment provider.
//
// Request body:
//   { packageId: 'pro', returnUrl?: '...', buyer?: { companyName, taxId } }
//
// Response shape depends on provider:
//   Stripe:  { flow: 'elements', clientSecret, externalId, publishableKey }
//   Balance: { flow: 'redirect', hostedUrl, externalId, dueDate, termsDays }
//
// The frontend checks `flow` and handles accordingly:
//   - 'elements' → mount Stripe Payment Element with clientSecret
//   - 'redirect' → window.location.href = hostedUrl
//   - 'embedded' → reserved for future iframe flow

import {
  handleCors, errorResponse, requireAuth, readJson,
  getCreditPackage, getSupabaseAdmin,
} from '../_lib/utils.js';
import { getActiveProvider, getActiveProviderName } from '../_lib/providers/index.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return errorResponse(res, 405, 'method_not_allowed', 'POST only');

  let user;
  try { user = await requireAuth(req); }
  catch (err) { return errorResponse(res, err.status || 401, 'unauthorized', err.message); }

  try {
    const { packageId, returnUrl, buyer = {} } = await readJson(req);
    if (!packageId) return errorResponse(res, 400, 'missing_package', 'packageId is required');

    const pkg = await getCreditPackage(packageId);
    if (!pkg) return errorResponse(res, 404, 'invalid_package', `Unknown or inactive package: ${packageId}`);

    const admin = await getSupabaseAdmin();
    const providerName = await getActiveProviderName(admin);

    // Enterprise packages are only purchasable via Balance (Net terms)
    if (pkg.is_enterprise && providerName !== 'balance') {
      return errorResponse(
        res, 400, 'provider_mismatch',
        'This package requires invoice-based payment. Contact sales.'
      );
    }

    let provider;
    try {
      provider = await getActiveProvider(admin);
    } catch (err) {
      return errorResponse(
        res, 500, 'provider_unconfigured',
        `Active provider (${providerName}) is not configured: ${err.message}`
      );
    }

    const result = await provider.createCheckout({
      user: {
        userId: user.userId,
        email: user.email,
        displayName: user.email,
      },
      pkg,
      returnUrl,
      buyer,
    });

    // Pre-create a pending payment row so admins see attempts even before webhook fires
    if (admin && !user.demo) {
      await admin.from('payments').upsert({
        user_id: user.userId,
        provider: providerName,
        external_id: result.externalId,
        amount_cents: pkg.amount_cents,
        currency: pkg.currency,
        credits_granted: pkg.credits,
        package_id: pkg.id,
        status: 'pending',
        due_date: result.dueDate || null,
        terms_days: providerName === 'balance' ? (provider.termsDays || null) : null,
        invoice_url: result.hostedUrl || null,
      }, { onConflict: 'provider,external_id' });
    }

    // Return a normalized response shape
    return res.status(200).json({
      provider: providerName,
      flow: result.flow,
      externalId: result.externalId,
      clientSecret: result.clientSecret,    // stripe only
      hostedUrl: result.hostedUrl,          // balance only
      publishableKey: providerName === 'stripe' ? (process.env.STRIPE_PUBLISHABLE_KEY || '') : null,
      dueDate: result.dueDate,              // balance only
      package: {
        id: pkg.id,
        credits: pkg.credits,
        amountCents: pkg.amount_cents,
        currency: pkg.currency,
        label: pkg.label,
      },
    });

  } catch (err) {
    console.error('[payments/create-checkout]', err);
    return errorResponse(res, 500, 'checkout_failed', 'Failed to create checkout', err.message);
  }
}
