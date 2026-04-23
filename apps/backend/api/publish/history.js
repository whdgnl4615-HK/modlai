// GET /api/publish/history?channel=&status=&limit=50
// User's publishing history

import {
  handleCors, errorResponse, requireAuth, getSupabaseAdmin, requireOrg} from '../_lib/utils.js';

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
  if (!db) return res.status(200).json({ publishings: [] });

  const channel = req.query?.channel;
  const status  = req.query?.status;
  const limit   = Math.min(parseInt(req.query?.limit || '50', 10), 200);

  let q = db.from('publishings')
    .select('*')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (channel) q = q.eq('channel', channel);
  if (status)  q = q.eq('status', status);

  const { data, error } = await q;
  if (error) return errorResponse(res, 500, 'query_failed', error.message);
  return res.status(200).json({ publishings: data || [] });
}
