// GET    /api/organizations/:id/invitations            → list pending
// POST   /api/organizations/:id/invitations             → invite by email
//        body: { email, role: 'admin'|'member' }
// DELETE /api/organizations/:id/invitations?id=...      → revoke

import crypto from 'crypto';
import {
  handleCors, errorResponse, requireAuth, requireOrgAdmin, readJson, getSupabaseAdmin,
} from '../../_lib/utils.js';
import { sendEmail, renderInviteEmail } from '../../_lib/email.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  const orgId = req.query?.id
    || (req.url?.match(/\/organizations\/([^/]+)\/invitations/) || [])[1];
  if (!orgId) return errorResponse(res, 400, 'missing_org_id');

  let user;
  try { user = await requireAuth(req); }
  catch (err) { return errorResponse(res, err.status || 401, 'unauthorized', err.message); }

  if (!user.isPlatformAdmin && user.orgId !== orgId) {
    return errorResponse(res, 403, 'forbidden');
  }

  const db = await getSupabaseAdmin();
  if (!db) return errorResponse(res, 500, 'no_database');

  const methodOverride = req.query?._method;
  const effectiveMethod = methodOverride ? methodOverride.toUpperCase() : req.method;

  if (effectiveMethod === 'GET') {
    const { data, error } = await db
      .from('organization_invitations')
      .select('id, email, role, status, expires_at, created_at, invited_by, users:invited_by(email)')
      .eq('organization_id', orgId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });
    if (error) return errorResponse(res, 500, 'query_failed', error.message);
    return res.status(200).json({
      invitations: (data || []).map(i => ({
        id: i.id,
        email: i.email,
        role: i.role,
        status: i.status,
        expires_at: i.expires_at,
        created_at: i.created_at,
        invited_by_email: i.users?.email,
      })),
    });
  }

  // Mutations require admin
  try { requireOrgAdmin(user); }
  catch (err) { return errorResponse(res, err.status, err.code || 'forbidden', err.message); }

  if (effectiveMethod === 'POST') {
    const { email, role = 'member' } = await readJson(req);
    if (!email || !email.includes('@')) return errorResponse(res, 400, 'invalid_email');
    if (!['owner', 'admin', 'member'].includes(role)) return errorResponse(res, 400, 'invalid_role');

    // Check if already a member
    const { data: existingUser } = await db
      .from('users')
      .select('id')
      .ilike('email', email)
      .maybeSingle();
    if (existingUser) {
      const { data: existingMember } = await db
        .from('organization_members')
        .select('id')
        .eq('organization_id', orgId)
        .eq('user_id', existingUser.id)
        .eq('status', 'active')
        .maybeSingle();
      if (existingMember) return errorResponse(res, 400, 'already_member');
    }

    // Check for pending invite
    const { data: existingInvite } = await db
      .from('organization_invitations')
      .select('id')
      .eq('organization_id', orgId)
      .ilike('email', email)
      .eq('status', 'pending')
      .maybeSingle();
    if (existingInvite) return errorResponse(res, 400, 'already_invited');

    const token = crypto.randomBytes(24).toString('hex');

    const { data: invite, error } = await db
      .from('organization_invitations')
      .insert({
        organization_id: orgId,
        email: email.toLowerCase().trim(),
        role,
        token,
        invited_by: user.userId,
      })
      .select('*')
      .single();
    if (error) return errorResponse(res, 500, 'invite_failed', error.message);

    // Build invite URL (frontend handles acceptance)
    const baseUrl = process.env.FRONTEND_URL || '';
    const inviteUrl = `${baseUrl}/invite/${token}`;

    // Fetch org name for email
    const { data: org } = await db
      .from('organizations')
      .select('name')
      .eq('id', orgId)
      .maybeSingle();
    const orgName = org?.name || 'MODLai';

    // Send invitation email (falls back to skipped if Resend not configured)
    const { html, text } = renderInviteEmail({
      orgName,
      inviterEmail: user.email,
      role: invite.role,
      inviteUrl,
    });
    const emailResult = await sendEmail({
      to: invite.email,
      subject: `You're invited to ${orgName} on MODLai`,
      html, text,
      tags: ['invitation'],
    });

    return res.status(201).json({
      invitation: {
        id: invite.id,
        email: invite.email,
        role: invite.role,
        expires_at: invite.expires_at,
      },
      invite_url: inviteUrl,
      email_sent: emailResult.ok === true,
      email_skipped: emailResult.skipped === true,
      note: emailResult.ok
        ? 'Invitation email sent.'
        : emailResult.skipped
          ? 'Email service not configured. Share the invite_url manually.'
          : `Email send failed: ${emailResult.error || 'unknown'}. Share the invite_url manually.`,
    });
  }

  if (effectiveMethod === 'DELETE') {
    const inviteId = req.query?.inviteId;
    if (!inviteId) return errorResponse(res, 400, 'missing_invite_id');

    const { error } = await db
      .from('organization_invitations')
      .update({ status: 'revoked' })
      .eq('id', inviteId)
      .eq('organization_id', orgId);
    if (error) return errorResponse(res, 500, 'revoke_failed', error.message);

    return res.status(200).json({ ok: true });
  }

  return errorResponse(res, 405, 'method_not_allowed');
}
