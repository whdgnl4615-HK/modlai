// POST /api/publish/preview
// body: { generationId, channel }
//
// Returns the mapped payload + warnings + errors for review UI.
// Does NOT actually send anything to the channel.

import {
  handleCors, errorResponse, requireAuth, readJson, getSupabaseAdmin, requireOrg} from '../_lib/utils.js';
import { SUPPORTED_CHANNELS, getChannelByKey } from '../_lib/channels/index.js';
import { buildCanonicalProduct } from '../_lib/channels/build-product.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return errorResponse(res, 405, 'method_not_allowed');

  let user;
  try { user = await requireAuth(req); }
  catch (err) { return errorResponse(res, err.status || 401, 'unauthorized', err.message); }

  let orgId;
  try { orgId = requireOrg(user); }
  catch (err) { return errorResponse(res, err.status || 403, err.code || 'no_org', err.message); }

  const { generationId, channel } = await readJson(req);
  if (!generationId) return errorResponse(res, 400, 'missing_id');
  if (!SUPPORTED_CHANNELS.includes(channel)) {
    return errorResponse(res, 400, 'invalid_channel');
  }

  try {
    // Build canonical product from DB
    const product = await buildCanonicalProduct({ userId: user.userId, generationId });

    // Get connection (used for preview context like store_url)
    const db = await getSupabaseAdmin();
    let connection = null;
    if (db) {
      const { data } = await db
        .from('channel_connections')
        .select('*')
        .eq('org_id', orgId)
        .eq('channel', channel)
        .maybeSingle();
      connection = data;
    }

    const adapter = getChannelByKey(channel);
    const preview = await adapter.preview(product, connection || {});

    return res.status(200).json({
      product,             // canonical (left side of diff view)
      preview,             // { payload, warnings, errors, effective }
      connected: !!connection,
      connectionStatus: connection?.status || 'not_connected',
      channel,
    });
  } catch (err) {
    console.error('[publish/preview]', err);
    return errorResponse(res, 500, 'preview_failed', err.message);
  }
}
