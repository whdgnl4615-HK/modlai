// GET    /api/channels/:channel          → test connection (cheap ping)
// DELETE /api/channels/:channel          → remove connection

import {
  handleCors, errorResponse, requireAuth, getSupabaseAdmin,
} from '../_lib/utils.js';
import { SUPPORTED_CHANNELS, getChannelByKey } from '../_lib/channels/index.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  let user;
  try { user = await requireAuth(req); }
  catch (err) { return errorResponse(res, err.status || 401, 'unauthorized', err.message); }

  let orgId;
  try { orgId = requireOrg(user); }
  catch (err) { return errorResponse(res, err.status || 403, err.code || 'no_org', err.message); }

  const channel = req.query?.channel
    || (req.url?.match(/\/channels\/([^/?]+)/) || [])[1];
  if (!SUPPORTED_CHANNELS.includes(channel)) {
    return errorResponse(res, 400, 'invalid_channel', `Unknown channel: ${channel}`);
  }

  const db = await getSupabaseAdmin();
  if (!db) return errorResponse(res, 500, 'no_database');

  const { data: conn } = await db
    .from('channel_connections')
    .select('*')
    .eq('org_id', orgId)
    .eq('channel', channel)
    .maybeSingle();

  if (!conn) return errorResponse(res, 404, 'not_connected', 'No connection for this channel');

  if (req.method === 'GET') {
    const adapter = getChannelByKey(channel);
    const test = await adapter.testConnection(conn);
    // Update DB with latest status
    await db.from('channel_connections').update({
      status: test.ok ? 'active' : 'error',
      last_error: test.ok ? null : test.error,
    }).eq('id', conn.id);
    return res.status(200).json(test);
  }

  if (req.method === 'DELETE') {
    await db.from('channel_connections').delete().eq('id', conn.id);
    return res.status(200).json({ ok: true });
  }

  return errorResponse(res, 405, 'method_not_allowed');
}
