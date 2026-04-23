// GET  /api/channels             → list user's connected channels
// POST /api/channels             → add/update a connection (direct token)
//                                  body: { channel, storeUrl, accessToken, meta? }

import {
  handleCors, errorResponse, requireAuth, readJson, getSupabaseAdmin,
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

  const db = await getSupabaseAdmin();

  if (req.method === 'GET') {
    if (!db) {
      // Demo mode
      return res.status(200).json({
        connections: [],
        supported: SUPPORTED_CHANNELS.map(k => ({ key: k, name: k })),
      });
    }
    const { data, error } = await db
      .from('channel_connections')
      .select('id, channel, status, store_url, store_name, meta, connected_at, updated_at, last_error')
      .eq('org_id', orgId);
    if (error) return errorResponse(res, 500, 'query_failed', error.message);

    // Never return the access_token
    return res.status(200).json({
      connections: data || [],
      supported: SUPPORTED_CHANNELS.map(k => ({ key: k, name: getChannelByKey(k).name })),
    });
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    const { channel, storeUrl, storeName, accessToken, meta = {} } = body;

    if (!SUPPORTED_CHANNELS.includes(channel)) {
      return errorResponse(res, 400, 'invalid_channel', `Unknown channel: ${channel}`);
    }
    if (!accessToken) {
      return errorResponse(res, 400, 'missing_token', 'accessToken is required');
    }
    if (channel === 'shopify' && !storeUrl) {
      return errorResponse(res, 400, 'missing_store_url', 'Shopify requires storeUrl (e.g. mystore.myshopify.com)');
    }

    if (!db) return errorResponse(res, 500, 'no_database', 'Database not configured');

    // Test the connection first
    const connectionRecord = {
      user_id: user.userId, org_id: orgId,
      channel,
      store_url: storeUrl,
      store_name: storeName,
      access_token: accessToken,
      meta,
      status: 'active',
    };
    const adapter = getChannelByKey(channel);
    const test = await adapter.testConnection(connectionRecord);
    if (!test.ok) {
      return errorResponse(res, 400, 'connection_failed', 'Credentials invalid: ' + test.error);
    }

    // Upsert
    connectionRecord.store_name = storeName || test.shopInfo?.name || storeUrl;
    connectionRecord.meta = { ...meta, verified_shop: test.shopInfo };

    const { data, error } = await db
      .from('channel_connections')
      .upsert(connectionRecord, { onConflict: 'user_id,channel' })
      .select('id, channel, status, store_url, store_name, meta, connected_at, updated_at')
      .single();
    if (error) return errorResponse(res, 500, 'save_failed', error.message);

    return res.status(200).json({ connection: data, shopInfo: test.shopInfo });
  }

  return errorResponse(res, 405, 'method_not_allowed');
}
