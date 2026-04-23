// GET /api/datasources/cron
// Called by Vercel cron every 6 hours.
// Loops through all active channel_connections and syncs incrementally.
//
// Security: Vercel cron adds a special header; for extra safety, we also
// accept a CRON_SECRET env var via Authorization: Bearer.

import { getSupabaseAdmin, handleCors, errorResponse } from '../_lib/utils.js';
import { runSync, rebuildProductAnalytics } from '../_lib/datasources/sync-engine.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  // Allow either Vercel's cron trigger or an explicit secret
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const auth = req.headers.authorization || '';
  const providedSecret = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const envSecret = process.env.CRON_SECRET;

  if (!isVercelCron && (!envSecret || providedSecret !== envSecret)) {
    return errorResponse(res, 401, 'unauthorized', 'Cron auth failed');
  }

  const admin = await getSupabaseAdmin();
  if (!admin) return errorResponse(res, 500, 'no_database');

  // Get all active channel connections
  const { data: conns } = await admin
    .from('channel_connections')
    .select('user_id, channel')
    .eq('status', 'active');

  if (!conns || !conns.length) {
    return res.status(200).json({ ok: true, note: 'No active connections' });
  }

  const results = [];
  for (const conn of conns) {
    const userResult = { user_id: conn.user_id, channel: conn.channel, entities: {} };

    for (const entity of ['products', 'customers', 'orders']) {
      try {
        const r = await runSync({
          userId: conn.user_id,
          channel: conn.channel,
          entity,
          incremental: true,
        });
        userResult.entities[entity] = r;
      } catch (err) {
        userResult.entities[entity] = { error: err.message };
      }
    }

    try {
      await rebuildProductAnalytics({ userId: conn.user_id });
    } catch (err) {
      userResult.analytics_error = err.message;
    }

    results.push(userResult);
  }

  return res.status(200).json({
    ok: true,
    timestamp: new Date().toISOString(),
    processed: results.length,
    results,
  });
}
