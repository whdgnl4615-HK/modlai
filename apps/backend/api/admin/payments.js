// GET /api/admin/payments?status=succeeded&provider=stripe&limit=50&offset=0

import {
  handleCors, errorResponse, requireAdmin, getSupabaseAdmin,
} from '../_lib/utils.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'GET') return errorResponse(res, 405, 'method_not_allowed', 'GET only');

  try { await requireAdmin(req); }
  catch (err) { return errorResponse(res, err.status || 401, 'unauthorized', err.message); }

  const db = await getSupabaseAdmin();
  if (!db) return errorResponse(res, 500, 'no_database', 'Database not configured');

  const status   = req.query?.status;
  const provider = req.query?.provider;
  const limit    = Math.min(parseInt(req.query?.limit || '50', 10), 200);
  const offset   = parseInt(req.query?.offset || '0', 10);

  let query = db.from('payments').select('*, users!inner(email, display_name)', { count: 'exact' });
  if (status)   query = query.eq('status', status);
  if (provider) query = query.eq('provider', provider);
  query = query.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

  const { data, count, error } = await query;
  if (error) return errorResponse(res, 500, 'query_failed', error.message);

  return res.status(200).json({ payments: data || [], total: count || 0, limit, offset });
}
