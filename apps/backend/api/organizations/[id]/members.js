// GET    /api/organizations/:id/members        → list members
// POST   /api/organizations/:id/members         → change role (admin only)
//        body: { userId, role: 'owner'|'admin'|'member' }
// DELETE /api/organizations/:id/members?userId=  → remove member (admin only)

import {
  handleCors, errorResponse, requireAuth, requireOrgAdmin, readJson, getSupabaseAdmin,
} from '../../_lib/utils.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  const orgId = req.query?.id
    || (req.url?.match(/\/organizations\/([^/]+)\/members/) || [])[1];
  if (!orgId) return errorResponse(res, 400, 'missing_id');

  let user;
  try { user = await requireAuth(req); }
  catch (err) { return errorResponse(res, err.status || 401, 'unauthorized', err.message); }

  if (!user.isPlatformAdmin && user.orgId !== orgId) {
    return errorResponse(res, 403, 'forbidden');
  }

  const db = await getSupabaseAdmin();
  if (!db) return errorResponse(res, 500, 'no_database');

  // Support _method=DELETE override
  const methodOverride = req.query?._method;
  const effectiveMethod = methodOverride ? methodOverride.toUpperCase() : req.method;

  if (effectiveMethod === 'GET') {
    const { data: members, error } = await db
      .from('organization_members')
      .select('id, role, status, joined_at, user_id, users!inner(id, email, role)')
      .eq('organization_id', orgId)
      .eq('status', 'active')
      .order('joined_at');
    if (error) return errorResponse(res, 500, 'query_failed', error.message);

    return res.status(200).json({
      members: (members || []).map(m => ({
        id: m.id,
        user_id: m.user_id,
        email: m.users?.email,
        role: m.role,
        joined_at: m.joined_at,
      })),
    });
  }

  // All mutations require org admin
  try { requireOrgAdmin(user); }
  catch (err) { return errorResponse(res, err.status, err.code || 'forbidden', err.message); }

  if (effectiveMethod === 'POST') {
    const { userId, role } = await readJson(req);
    if (!userId || !role) return errorResponse(res, 400, 'missing_fields');
    if (!['owner', 'admin', 'member'].includes(role)) {
      return errorResponse(res, 400, 'invalid_role');
    }

    // Cannot demote the last owner
    if (role !== 'owner') {
      const { data: owners } = await db
        .from('organization_members')
        .select('user_id')
        .eq('organization_id', orgId)
        .eq('role', 'owner')
        .eq('status', 'active');
      if (owners && owners.length === 1 && owners[0].user_id === userId) {
        return errorResponse(res, 400, 'last_owner', 'Cannot demote the last owner');
      }
    }

    const { data, error } = await db
      .from('organization_members')
      .update({ role })
      .eq('organization_id', orgId)
      .eq('user_id', userId)
      .select('*')
      .single();
    if (error) return errorResponse(res, 500, 'update_failed', error.message);
    return res.status(200).json({ member: data });
  }

  if (effectiveMethod === 'DELETE') {
    const targetUserId = req.query?.userId;
    if (!targetUserId) return errorResponse(res, 400, 'missing_user_id');

    // Prevent removing the last owner
    const { data: owners } = await db
      .from('organization_members')
      .select('user_id')
      .eq('organization_id', orgId)
      .eq('role', 'owner')
      .eq('status', 'active');
    if (owners && owners.length === 1 && owners[0].user_id === targetUserId) {
      return errorResponse(res, 400, 'last_owner', 'Cannot remove the last owner');
    }

    const { error } = await db
      .from('organization_members')
      .update({ status: 'left' })
      .eq('organization_id', orgId)
      .eq('user_id', targetUserId);
    if (error) return errorResponse(res, 500, 'remove_failed', error.message);

    // Clear active_org_id if it was this one
    await db.from('users')
      .update({ active_org_id: null })
      .eq('id', targetUserId)
      .eq('active_org_id', orgId);

    return res.status(200).json({ ok: true });
  }

  return errorResponse(res, 405, 'method_not_allowed');
}
