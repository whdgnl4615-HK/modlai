// GET /api/recommendations/history?limit=50&offset=0
// Lists past recommendation applications for the org.

import {
  handleCors, errorResponse, requireAuth, requireOrg, getSupabaseAdmin,
} from '../_lib/utils.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'GET') return errorResponse(res, 405, 'method_not_allowed');

  let user;
  try { user = await requireAuth(req); }
  catch (err) { return errorResponse(res, err.status || 401, 'unauthorized', err.message); }

  let orgId;
  try { orgId = requireOrg(user); }
  catch (err) { return errorResponse(res, err.status, err.code || 'no_org', err.message); }

  const db = await getSupabaseAdmin();
  if (!db) return res.status(200).json({ applications: [], total: 0 });

  const limit  = Math.min(parseInt(req.query?.limit || '50', 10), 200);
  const offset = Math.max(parseInt(req.query?.offset || '0', 10), 0);

  const { data, count, error } = await db
    .from('recommendation_applications')
    .select('id, created_at, action_type, action_summary, push_status, push_error, master_id, product_id, before_state, after_state, applied_by_email', { count: 'exact' })
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return errorResponse(res, 500, 'query_failed', error.message);

  return res.status(200).json({
    applications: data || [],
    total: count || 0,
    offset, limit,
  });
}
