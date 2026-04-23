// POST /api/publish/execute
// body: { generationId, channel, confirm: true }
//
// Actually pushes the product to the channel.
// Writes a publishings row with status tracking.

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

  const { generationId, masterId: masterIdInput, channel, confirm } = await readJson(req);
  if (!generationId) return errorResponse(res, 400, 'missing_id');
  if (!SUPPORTED_CHANNELS.includes(channel)) return errorResponse(res, 400, 'invalid_channel');
  if (confirm !== true) {
    return errorResponse(res, 400, 'confirm_required', 'Set confirm:true to actually publish');
  }

  const db = await getSupabaseAdmin();

  // Demo mode
  if (!db) {
    return res.status(200).json({
      ok: true,
      demo: true,
      publishing: {
        channel,
        status: 'published',
        external_product_id: 'demo-' + Date.now(),
        external_url: `https://example.com/products/demo-${Date.now()}`,
      },
    });
  }

  // Resolve masterId: either provided, or lookup via generation link
  let masterId = masterIdInput || null;
  if (!masterId) {
    const { data: link } = await db
      .from('product_master_generations')
      .select('master_id')
      .eq('generation_id', generationId)
      .eq('org_id', orgId)
      .limit(1)
      .maybeSingle();
    if (link) masterId = link.master_id;
  }

  // Get connection
  const { data: connection } = await db
    .from('channel_connections')
    .select('*')
    .eq('org_id', orgId)
    .eq('channel', channel)
    .eq('status', 'active')
    .maybeSingle();
  if (!connection) {
    return errorResponse(res, 400, 'not_connected',
      `${channel} is not connected. Add credentials in Channel Settings first.`);
  }

  // Build product
  let product;
  try {
    product = await buildCanonicalProduct({ userId: user.userId, generationId });
  } catch (err) {
    return errorResponse(res, 400, 'product_build_failed', err.message);
  }

  const adapter = getChannelByKey(channel);

  // Dry-run mapping first to catch validation errors
  const previewResult = await adapter.preview(product, connection);
  if (previewResult.errors.length) {
    return errorResponse(res, 422, 'validation_failed',
      'Cannot publish: ' + previewResult.errors.join('; '));
  }

  // Upsert a pending publishing row
  const { data: pub } = await db.from('publishings').upsert({
    user_id: user.userId, org_id: orgId,
    generation_id: generationId,
    master_id: masterId,
    channel,
    status: 'publishing',
    mapped_payload: previewResult.payload,
  }, { onConflict: 'generation_id,channel' }).select('*').single();

  // Execute
  try {
    const result = await adapter.publish(product, connection);

    // Update publishing row
    await db.from('publishings').update({
      status: 'published',
      external_product_id: result.externalProductId,
      external_url: result.externalUrl,
      response_payload: result.rawResponse,
      published_at: new Date().toISOString(),
      error_message: null,
      error_code: null,
    }).eq('id', pub.id);

    return res.status(200).json({
      ok: true,
      publishing: {
        id: pub.id,
        channel,
        status: 'published',
        external_product_id: result.externalProductId,
        external_url: result.externalUrl,
      },
    });
  } catch (err) {
    console.error(`[publish:${channel}]`, err);
    await db.from('publishings').update({
      status: 'failed',
      error_message: err.message,
      error_code: err.code || null,
    }).eq('id', pub.id);

    return errorResponse(res, 502, 'publish_failed', err.message);
  }
}
