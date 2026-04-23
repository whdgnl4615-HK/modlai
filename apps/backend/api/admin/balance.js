// GET /api/admin/balance
// Returns the merchant-side balance (revenue, payouts, pending invoices)
// for the currently-active provider.
//
// Stripe: current balance + payout schedule
// Balance: receivables + outstanding invoices

import {
  handleCors, errorResponse, requireAdmin, getSupabaseAdmin,
} from '../_lib/utils.js';
import { getActiveProvider, getActiveProviderName } from '../_lib/providers/index.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'GET') return errorResponse(res, 405, 'method_not_allowed', 'GET only');

  try { await requireAdmin(req); }
  catch (err) { return errorResponse(res, err.status || 401, 'unauthorized', err.message); }

  try {
    const db = await getSupabaseAdmin();
    const providerName = await getActiveProviderName(db);

    // Which provider's balance does the admin want to see?
    // Default = active, but query can override (?provider=stripe)
    const requested = req.query?.provider || providerName;

    let provider;
    try { provider = await getActiveProvider(db); }
    catch (err) {
      return errorResponse(res, 500, 'provider_unconfigured',
        `${requested} is not configured: ${err.message}`);
    }
    // If user asked for a different provider than active, swap
    if (requested !== providerName) {
      try {
        const { getProviderByName } = await import('../_lib/providers/index.js');
        provider = getProviderByName(requested);
      } catch (err) {
        return errorResponse(res, 400, 'unknown_provider', err.message);
      }
    }

    const balance = await provider.getMerchantBalance();
    return res.status(200).json(balance);

  } catch (err) {
    console.error('[admin/balance]', err);
    return errorResponse(res, 500, 'balance_failed', 'Failed to fetch balance', err.message);
  }
}
