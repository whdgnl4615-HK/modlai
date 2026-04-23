// GET /api/imports/masters?q=&category=&season=&channel_status=&show=active|archived|all&limit=50&offset=0
// List product masters with aggregated publish/generation/error status.

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
  if (!db) return res.status(200).json({ masters: [], total: 0 });

  const q        = (req.query?.q || '').trim();
  const category = req.query?.category;
  const season   = req.query?.season;
  const channelStatus = req.query?.channel_status;
  const show     = req.query?.show || 'active';  // 'active' | 'archived' | 'all'
  const limit    = Math.min(parseInt(req.query?.limit || '50', 10), 200);
  const offset   = Math.max(parseInt(req.query?.offset || '0', 10), 0);

  // Note: product_masters_with_status excludes is_archived=true by default,
  // so for 'archived' view we query product_masters directly.
  let query;
  if (show === 'active') {
    query = db.from('product_masters_with_status').select('*', { count: 'exact' });
  } else {
    query = db.from('product_masters').select('*', { count: 'exact' });
    if (show === 'archived') {
      query = query.eq('is_archived', true).is('deleted_at', null);
    } else if (show === 'all') {
      // no filter
    }
  }
  query = query.eq('org_id', orgId);

  if (category) query = query.eq('category', category);
  if (season)   query = query.eq('season', season);
  if (q) {
    query = query.or(`style_number.ilike.%${q}%,name.ilike.%${q}%,color.ilike.%${q}%`);
  }
  if (channelStatus === 'has_errors' && show === 'active') {
    query = query.gt('unresolved_error_count', 0);
  } else if (channelStatus === 'no_generation' && show === 'active') {
    query = query.eq('generation_count', 0);
  }

  query = query.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

  const { data, count, error } = await query;
  if (error) return errorResponse(res, 500, 'query_failed', error.message);

  // Post-filter for jsonb-based statuses (only available in active view)
  let masters = data || [];
  if (show === 'active') {
    if (channelStatus === 'has_shopify') {
      masters = masters.filter(m => (m.publish_status || []).some(p => p.channel === 'shopify' && p.status === 'published'));
    } else if (channelStatus === 'has_faire') {
      masters = masters.filter(m => (m.publish_status || []).some(p => p.channel === 'faire' && p.status === 'published'));
    } else if (channelStatus === 'needs_publish') {
      masters = masters.filter(m => !(m.publish_status || []).some(p => p.status === 'published'));
    }
  }

  return res.status(200).json({
    masters,
    total: count || 0,
    offset, limit, show,
  });
}

