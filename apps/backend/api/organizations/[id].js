// GET   /api/organizations/:id    → org details
// PATCH /api/organizations/:id    → update name, logo, settings (owner/admin only)

import {
  handleCors, errorResponse, requireAuth, requireOrgAdmin, readJson, getSupabaseAdmin,
} from '../_lib/utils.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  const orgId = req.query?.id || (req.url?.match(/\/organizations\/([^/?]+)/) || [])[1];
  if (!orgId) return errorResponse(res, 400, 'missing_id');

  let user;
  try { user = await requireAuth(req); }
  catch (err) { return errorResponse(res, err.status || 401, 'unauthorized', err.message); }

  // Check access
  if (!user.isPlatformAdmin && user.orgId !== orgId) {
    return errorResponse(res, 403, 'forbidden', 'You are not a member of this organization');
  }

  const db = await getSupabaseAdmin();
  if (!db) return errorResponse(res, 500, 'no_database');

  if (req.method === 'GET') {
    const { data: org, error } = await db
      .from('organizations_with_stats')
      .select('*')
      .eq('id', orgId)
      .maybeSingle();
    if (error) return errorResponse(res, 500, 'query_failed', error.message);
    if (!org)  return errorResponse(res, 404, 'not_found');

    return res.status(200).json({ organization: { ...org, role: user.orgRole } });
  }

  if (req.method === 'PATCH' || req.method === 'POST') {
    try { requireOrgAdmin(user); }
    catch (err) { return errorResponse(res, err.status, err.code || 'forbidden', err.message); }

    const body = await readJson(req);
    const allowed = ['name', 'slug', 'logo_url', 'billing_email', 'settings'];
    const patch = {};
    for (const k of allowed) if (body[k] !== undefined) patch[k] = body[k];
    if (Object.keys(patch).length === 0) {
      return errorResponse(res, 400, 'no_fields');
    }

    const { data, error } = await db
      .from('organizations')
      .update(patch)
      .eq('id', orgId)
      .select('*')
      .single();
    if (error) return errorResponse(res, 500, 'update_failed', error.message);
    return res.status(200).json({ organization: data });
  }

  return errorResponse(res, 405, 'method_not_allowed');
}
