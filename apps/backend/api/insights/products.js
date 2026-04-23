// GET /api/insights/products?channel=shopify&status=active&sort=revenue|views|conv|created&limit=50&offset=0&q=
// Paginated product listing with performance data merged in

import {
  handleCors, errorResponse, requireAuth, getSupabaseAdmin,
} from '../_lib/utils.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'GET') return errorResponse(res, 405, 'method_not_allowed');

  let user;
  try { user = await requireAuth(req); }
  catch (err) { return errorResponse(res, err.status || 401, 'unauthorized', err.message); }

  let orgId;
  try { orgId = requireOrg(user); }
  catch (err) { return errorResponse(res, err.status || 403, err.code || 'no_org', err.message); }

  const channel = req.query?.channel;
  const status  = req.query?.status;  // 'active' | 'archived' | 'draft' | undefined
  const sort    = req.query?.sort || 'revenue'; // revenue | views | conv | created
  const limit   = Math.min(parseInt(req.query?.limit || '50', 10), 200);
  const offset  = Math.max(parseInt(req.query?.offset || '0', 10), 0);
  const q       = (req.query?.q || '').trim();

  const db = await getSupabaseAdmin();
  if (!db) return res.status(200).json({ products: [], total: 0 });

  let query = db.from('product_performance')
    .select('*', { count: 'exact' })
    .eq('org_id', orgId);

  if (channel) query = query.eq('channel', channel);
  if (status)  query = query.eq('status', status);
  if (q) query = query.ilike('title', `%${q}%`);

  // Sort
  const sortCol = {
    revenue: 'revenue_30d',
    views:   'views_30d',
    orders:  'orders_30d',
    conv:    'conv_rate_30d',
    created: 'id',  // proxy for recent
  }[sort] || 'revenue_30d';
  query = query.order(sortCol, { ascending: false, nullsFirst: false });

  query = query.range(offset, offset + limit - 1);

  const { data, count, error } = await query;
  if (error) return errorResponse(res, 500, 'query_failed', error.message);

  // Also fetch diagnosis status per product
  const productIds = (data || []).map(p => p.id);
  let diagnoses = {};
  if (productIds.length) {
    const { data: diags } = await db
      .from('ai_diagnoses')
      .select('product_id, overall_score, created_at, recommendations')
      .in('product_id', productIds)
      .order('created_at', { ascending: false });
    for (const d of (diags || [])) {
      if (!diagnoses[d.product_id]) {
        diagnoses[d.product_id] = {
          overall_score: d.overall_score,
          last_diagnosed_at: d.created_at,
          recommendation_count: Array.isArray(d.recommendations) ? d.recommendations.length : 0,
        };
      }
    }
  }

  const products = (data || []).map(p => ({
    ...p,
    diagnosis: diagnoses[p.id] || null,
  }));

  return res.status(200).json({
    products,
    total: count || 0,
    offset,
    limit,
  });
}
