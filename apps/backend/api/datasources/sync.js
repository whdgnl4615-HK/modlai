// POST /api/datasources/sync
// Triggers a sync for a channel + entity.
// body: { channel, entity: 'products' | 'orders' | 'customers' | 'all', incremental?: true }
//
// Long-running (up to 5 min for full sync) — use vercel maxDuration: 300

import {
  handleCors, errorResponse, requireAuth, readJson, getSupabaseAdmin, requireOrg} from '../_lib/utils.js';
import { runSync, rebuildProductAnalytics } from '../_lib/datasources/sync-engine.js';
import { SUPPORTED_DATASOURCES } from '../_lib/datasources/index.js';

const VALID_ENTITIES = ['products', 'orders', 'customers', 'all'];

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return errorResponse(res, 405, 'method_not_allowed');

  let user;
  try { user = await requireAuth(req); }
  catch (err) { return errorResponse(res, err.status || 401, 'unauthorized', err.message); }

  let orgId;
  try { orgId = requireOrg(user); }
  catch (err) { return errorResponse(res, err.status || 403, err.code || 'no_org', err.message); }

  const { channel, entity = 'all', incremental = true } = await readJson(req);
  if (!SUPPORTED_DATASOURCES.includes(channel)) {
    return errorResponse(res, 400, 'invalid_channel');
  }
  if (!VALID_ENTITIES.includes(entity)) {
    return errorResponse(res, 400, 'invalid_entity', `Must be one of: ${VALID_ENTITIES.join(', ')}`);
  }

  try {
    const entities = entity === 'all' ? ['products', 'customers', 'orders'] : [entity];
    const results = {};
    for (const e of entities) {
      try {
        results[e] = await runSync({ userId: user.userId, channel, entity: e, incremental });
      } catch (err) {
        results[e] = { error: err.message, stats: err.stats };
      }
    }

    // After syncing orders, rebuild analytics
    if (entities.includes('orders')) {
      try {
        results.analytics = await rebuildProductAnalytics({ userId: user.userId });
      } catch (err) {
        results.analytics = { error: err.message };
      }
    }

    return res.status(200).json({ ok: true, results });
  } catch (err) {
    console.error('[sync]', err);
    return errorResponse(res, 500, 'sync_failed', err.message);
  }
}
