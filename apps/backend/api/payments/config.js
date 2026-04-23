// GET /api/payments/config
// Returns:
//   - activeProvider: 'stripe' | 'balance'
//   - packages:       available credit packages
//   - publishableKey: for Stripe.js init (null if active provider is Balance)
//
// Called by frontend when opening the top-up modal, so the UI knows which
// payment flow to render.

import {
  handleCors, errorResponse, requireAuth, listCreditPackages, getSystemSetting,
} from '../_lib/utils.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'GET') return errorResponse(res, 405, 'method_not_allowed', 'GET only');

  try { await requireAuth(req); }
  catch (err) { return errorResponse(res, err.status || 401, 'unauthorized', err.message); }

  try {
    const activeProviderRaw = await getSystemSetting('active_payment_provider', 'stripe');
    const activeProvider = typeof activeProviderRaw === 'string'
      ? activeProviderRaw.replace(/"/g, '')
      : String(activeProviderRaw).replace(/"/g, '');

    const packages = await listCreditPackages();

    // Only expose publishable key if we'd actually use Stripe today
    const publishableKey = activeProvider === 'stripe'
      ? (process.env.STRIPE_PUBLISHABLE_KEY || '')
      : null;

    return res.status(200).json({
      activeProvider,
      packages,
      publishableKey,
    });
  } catch (err) {
    console.error('[payments/config]', err);
    return errorResponse(res, 500, 'config_failed', 'Failed to load payment config', err.message);
  }
}
