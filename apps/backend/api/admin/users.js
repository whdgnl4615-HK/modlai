// GET  /api/admin/users?q=search&limit=50&offset=0
// POST /api/admin/users  body: { userId, action: 'grant_credits'|'block'|'unblock'|'make_admin', amount? }

import {
  handleCors, errorResponse, requireAdmin, readJson,
  getSupabaseAdmin, grantCredits,
} from '../_lib/utils.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  let admin;
  try { admin = await requireAdmin(req); }
  catch (err) { return errorResponse(res, err.status || 401, 'unauthorized', err.message); }

  const db = await getSupabaseAdmin();
  if (!db) return errorResponse(res, 500, 'no_database', 'Database not configured');

  if (req.method === 'GET') {
    const q      = (req.query?.q || '').trim();
    const limit  = Math.min(parseInt(req.query?.limit || '50', 10), 200);
    const offset = parseInt(req.query?.offset || '0', 10);

    let query = db.from('user_stats').select('*', { count: 'exact' });
    if (q) {
      // Search by email or display_name
      query = query.or(`email.ilike.%${q}%,display_name.ilike.%${q}%`);
    }
    query = query.range(offset, offset + limit - 1).order('created_at', { ascending: false });

    const { data, count, error } = await query;
    if (error) return errorResponse(res, 500, 'query_failed', error.message);

    return res.status(200).json({ users: data || [], total: count || 0, limit, offset });
  }

  if (req.method === 'POST') {
    const { userId, action, amount, note } = await readJson(req);
    if (!userId || !action) return errorResponse(res, 400, 'missing_fields', 'userId and action required');

    switch (action) {
      case 'grant_credits': {
        const amt = parseInt(amount, 10);
        if (!amt || amt === 0) return errorResponse(res, 400, 'invalid_amount', 'amount must be non-zero');
        await grantCredits(userId, amt, amt > 0 ? 'admin_grant' : 'admin_revoke', {
          note: note || `By admin ${admin.email}`,
        });
        break;
      }
      case 'block':
        await db.from('users').update({ is_blocked: true }).eq('id', userId);
        break;
      case 'unblock':
        await db.from('users').update({ is_blocked: false }).eq('id', userId);
        break;
      case 'make_admin':
        await db.from('users').update({ role: 'admin' }).eq('id', userId);
        break;
      case 'revoke_admin':
        await db.from('users').update({ role: 'user' }).eq('id', userId);
        break;
      default:
        return errorResponse(res, 400, 'unknown_action', `Unknown action: ${action}`);
    }

    await db.from('admin_actions').insert({
      admin_id: admin.userId,
      action,
      target_id: userId,
      details: { amount, note },
    });

    return res.status(200).json({ ok: true });
  }

  return errorResponse(res, 405, 'method_not_allowed');
}
