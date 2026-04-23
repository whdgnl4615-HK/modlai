// GET /api/datasources/status
// Returns last sync status per channel/entity for this user

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

  const db = await getSupabaseAdmin();
  if (!db) return res.status(200).json({ jobs: [], summary: {} });

  // Last 20 jobs
  const { data: jobs } = await db
    .from('sync_jobs')
    .select('*')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(20);

  // Also get counts of synced data
  const [products, orders, customers] = await Promise.all([
    db.from('external_products').select('*', { count: 'exact', head: true }).eq('org_id', orgId),
    db.from('external_orders').select('*', { count: 'exact', head: true }).eq('org_id', orgId),
    db.from('external_customers').select('*', { count: 'exact', head: true }).eq('org_id', orgId),
  ]);

  return res.status(200).json({
    jobs: jobs || [],
    summary: {
      products: products.count || 0,
      orders: orders.count || 0,
      customers: customers.count || 0,
    },
  });
}
