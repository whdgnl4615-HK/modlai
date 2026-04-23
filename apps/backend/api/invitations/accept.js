// POST /api/invitations/accept
// body: { token }
// Current logged-in user joins the org associated with the token.

import {
  handleCors, errorResponse, requireAuth, readJson, getSupabaseAdmin,
} from '../_lib/utils.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return errorResponse(res, 405, 'method_not_allowed');

  let user;
  try { user = await requireAuth(req); }
  catch (err) { return errorResponse(res, err.status || 401, 'unauthorized', err.message); }

  const { token } = await readJson(req);
  if (!token) return errorResponse(res, 400, 'missing_token');

  const db = await getSupabaseAdmin();
  if (!db) return errorResponse(res, 500, 'no_database');

  // Find the invite
  const { data: invite } = await db
    .from('organization_invitations')
    .select('*')
    .eq('token', token)
    .maybeSingle();

  if (!invite) return errorResponse(res, 404, 'invite_not_found');
  if (invite.status !== 'pending') {
    return errorResponse(res, 400, 'invite_invalid', `Invite is ${invite.status}`);
  }
  if (new Date(invite.expires_at) < new Date()) {
    await db.from('organization_invitations').update({ status: 'expired' }).eq('id', invite.id);
    return errorResponse(res, 400, 'invite_expired');
  }

  // Verify email matches
  if (invite.email.toLowerCase() !== user.email.toLowerCase()) {
    return errorResponse(res, 403, 'email_mismatch',
      `This invitation is for ${invite.email}, but you are logged in as ${user.email}`);
  }

  // Check user not already in another org
  if (user.orgId && user.orgId !== invite.organization_id) {
    return errorResponse(res, 400, 'already_in_org',
      'You must leave your current organization before joining a new one.');
  }

  // Create membership
  const { error: memberErr } = await db.from('organization_members').upsert({
    organization_id: invite.organization_id,
    user_id: user.userId,
    role: invite.role,
    status: 'active',
  }, { onConflict: 'organization_id,user_id' });

  if (memberErr) return errorResponse(res, 500, 'join_failed', memberErr.message);

  // Mark invite as accepted
  await db.from('organization_invitations').update({
    status: 'accepted',
    accepted_at: new Date().toISOString(),
    accepted_by: user.userId,
  }).eq('id', invite.id);

  // Set active_org_id
  await db.from('users')
    .update({ active_org_id: invite.organization_id })
    .eq('id', user.userId);

  // Get org details
  const { data: org } = await db
    .from('organizations')
    .select('id, name, slug, logo_url')
    .eq('id', invite.organization_id)
    .single();

  return res.status(200).json({
    organization: org,
    role: invite.role,
  });
}
