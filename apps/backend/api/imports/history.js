// GET /api/imports/history       → past import jobs
// GET /api/imports/masters       → list product masters
// GET /api/imports/masters/:id   → single master + variants

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
  if (!db) return res.status(200).json({ jobs: [] });

  const { data, error } = await db
    .from('import_jobs')
    .select('id, filename, file_type, row_count, mapping_source, granularity, status, masters_created, masters_updated, variants_created, rows_skipped, duration_ms, created_at, completed_at, error_message')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(30);

  if (error) return errorResponse(res, 500, 'query_failed', error.message);
  return res.status(200).json({ jobs: data || [] });
}
