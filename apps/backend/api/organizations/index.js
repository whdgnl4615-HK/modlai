// GET  /api/organizations      → current user's org (or null if none)
// POST /api/organizations      → create a new org (becomes owner)
//                                 body: { name, slug?, logo_url? }

import {
  handleCors, errorResponse, requireAuth, readJson, getSupabaseAdmin,
} from '../_lib/utils.js';
import { sendEmail, renderWelcomeEmail } from '../_lib/email.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  let user;
  try { user = await requireAuth(req); }
  catch (err) { return errorResponse(res, err.status || 401, 'unauthorized', err.message); }

  const db = await getSupabaseAdmin();
  if (!db) {
    // Demo mode
    if (req.method === 'GET') {
      return res.status(200).json({
        organization: { id: 'demo-org', name: 'Demo Organization', role: 'owner', credits_balance: 9999 },
      });
    }
    return errorResponse(res, 500, 'no_database');
  }

  // GET — return user's active org
  if (req.method === 'GET') {
    if (!user.orgId) return res.status(200).json({ organization: null });

    const { data: org } = await db
      .from('organizations_with_stats')
      .select('*')
      .eq('id', user.orgId)
      .maybeSingle();

    return res.status(200).json({
      organization: org ? { ...org, role: user.orgRole } : null,
    });
  }

  // POST — create a new organization
  if (req.method === 'POST') {
    // Check if user already has an active membership
    if (user.orgId && !user.isPlatformAdmin) {
      return errorResponse(res, 400, 'already_in_org',
        'You are already a member of an organization. Leave it first or contact admin.');
    }

    const body = await readJson(req);
    const name = (body.name || '').trim();
    if (!name) return errorResponse(res, 400, 'missing_name', 'Organization name required');

    const slug = (body.slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40))
      .replace(/^-+|-+$/g, '');

    // Create the org (SECURITY DEFINER approach via admin client, then RLS kicks in after)
    const { data: org, error: orgErr } = await db.from('organizations').insert({
      name,
      slug,
      logo_url: body.logo_url || null,
      billing_email: user.email,
      created_by: user.userId,
      credits_balance: 100,  // welcome bonus for new orgs
    }).select('*').single();

    if (orgErr) {
      return errorResponse(res, 500, 'create_failed', orgErr.message);
    }

    // Add creator as owner
    const { error: memberErr } = await db.from('organization_members').insert({
      organization_id: org.id,
      user_id: user.userId,
      role: 'owner',
      status: 'active',
    });

    if (memberErr) {
      // Rollback org creation
      await db.from('organizations').delete().eq('id', org.id);
      return errorResponse(res, 500, 'member_create_failed', memberErr.message);
    }

    // Set active_org_id on user
    await db.from('users').update({ active_org_id: org.id }).eq('id', user.userId);

    // Welcome credit transaction
    await db.from('credit_transactions').insert({
      user_id: user.userId,
      org_id: org.id,
      amount: 100,
      type: 'credit',
      reason: 'welcome_bonus',
      description: 'Welcome to MODLai',
    });

    // Welcome email (fire-and-forget — don't block response)
    const { html, text } = renderWelcomeEmail({
      userEmail: user.email,
      orgName: org.name,
    });
    sendEmail({
      to: user.email,
      subject: `Welcome to ${org.name} on MODLai`,
      html, text,
      tags: ['welcome'],
    }).catch(err => console.warn('[welcome email]', err));

    return res.status(201).json({ organization: { ...org, role: 'owner', member_count: 1 } });
  }

  return errorResponse(res, 405, 'method_not_allowed');
}
