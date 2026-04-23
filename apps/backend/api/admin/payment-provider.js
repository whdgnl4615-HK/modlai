// GET  /api/admin/payment-provider  → { activeProvider, available, configured }
// POST /api/admin/payment-provider  body: { provider: 'stripe' | 'balance' }
//
// Admin-only endpoint to switch the globally-active PG.

import {
  handleCors, errorResponse, requireAdmin, readJson, getSupabaseAdmin,
} from '../_lib/utils.js';

const ALL_PROVIDERS = ['stripe', 'balance'];

function isConfigured(provider) {
  if (provider === 'stripe') {
    return !!process.env.STRIPE_SECRET_KEY && !!process.env.STRIPE_PUBLISHABLE_KEY;
  }
  if (provider === 'balance') {
    return !!process.env.BALANCE_API_KEY;
  }
  return false;
}

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  let admin;
  try { admin = await requireAdmin(req); }
  catch (err) { return errorResponse(res, err.status || 401, 'unauthorized', err.message); }

  const db = await getSupabaseAdmin();
  if (!db) return errorResponse(res, 500, 'no_database', 'Database not configured');

  if (req.method === 'GET') {
    const { data } = await db
      .from('system_settings')
      .select('value')
      .eq('key', 'active_payment_provider')
      .single();
    const current = (data?.value && String(data.value).replace(/"/g, '')) || 'stripe';

    return res.status(200).json({
      activeProvider: current,
      available: ALL_PROVIDERS,
      configured: ALL_PROVIDERS.reduce((acc, p) => {
        acc[p] = isConfigured(p);
        return acc;
      }, {}),
    });
  }

  if (req.method === 'POST') {
    const { provider } = await readJson(req);
    if (!ALL_PROVIDERS.includes(provider)) {
      return errorResponse(res, 400, 'invalid_provider', `Must be one of: ${ALL_PROVIDERS.join(', ')}`);
    }
    if (!isConfigured(provider)) {
      return errorResponse(res, 400, 'provider_not_configured',
        `${provider} keys are not set in environment variables.`);
    }

    await db
      .from('system_settings')
      .upsert({
        key: 'active_payment_provider',
        value: JSON.stringify(provider),  // stored as JSONB string
        updated_by: admin.userId,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'key' });

    await db.from('admin_actions').insert({
      admin_id: admin.userId,
      action: 'set_payment_provider',
      target_id: provider,
      details: { previous: null, new: provider },
    });

    return res.status(200).json({ ok: true, activeProvider: provider });
  }

  return errorResponse(res, 405, 'method_not_allowed', 'GET or POST only');
}
