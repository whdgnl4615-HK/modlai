// POST /api/imports/masters/bulk
// body: {
//   action: 'archive' | 'unarchive' | 'delete_permanent',
//   masterIds: [uuid, uuid, ...]
// }
//
// archive: soft delete (is_archived=true) — reversible
// unarchive: restore from archive
// delete_permanent: mark deleted_at (cannot be recovered from UI)

import {
  handleCors, errorResponse, requireAuth, requireOrg, readJson, getSupabaseAdmin,
} from '../_lib/utils.js';

const VALID_ACTIONS = ['archive', 'unarchive', 'delete_permanent'];

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return errorResponse(res, 405, 'method_not_allowed');

  let user;
  try { user = await requireAuth(req); }
  catch (err) { return errorResponse(res, err.status || 401, 'unauthorized', err.message); }

  let orgId;
  try { orgId = requireOrg(user); }
  catch (err) { return errorResponse(res, err.status, err.code || 'no_org', err.message); }

  const { action, masterIds } = await readJson(req);
  if (!VALID_ACTIONS.includes(action)) return errorResponse(res, 400, 'invalid_action');
  if (!Array.isArray(masterIds) || masterIds.length === 0) {
    return errorResponse(res, 400, 'missing_ids');
  }
  if (masterIds.length > 500) {
    return errorResponse(res, 400, 'too_many', 'Max 500 items per bulk operation');
  }

  const db = await getSupabaseAdmin();
  if (!db) return errorResponse(res, 500, 'no_database');

  let patch;
  if (action === 'archive') {
    patch = { is_archived: true };
  } else if (action === 'unarchive') {
    patch = { is_archived: false };
  } else {
    // delete_permanent
    patch = { is_archived: true, deleted_at: new Date().toISOString(), deleted_by: user.userId };
  }

  const { data, error } = await db
    .from('product_masters')
    .update(patch)
    .in('id', masterIds)
    .eq('org_id', orgId)            // critical: scope to caller's org
    .select('id');

  if (error) return errorResponse(res, 500, 'bulk_failed', error.message);

  return res.status(200).json({
    ok: true,
    action,
    affected: (data || []).length,
    requested: masterIds.length,
  });
}
