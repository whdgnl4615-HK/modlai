// GET  /api/generations/:id/commerce   → load commerce meta
// PUT  /api/generations/:id/commerce   → save commerce meta (upsert)

import {
  handleCors, errorResponse, requireAuth, readJson, getSupabaseAdmin,
} from '../../_lib/utils.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  let user;
  try { user = await requireAuth(req); }
  catch (err) { return errorResponse(res, err.status || 401, 'unauthorized', err.message); }

  const generationId = req.query?.id
    || (req.url?.match(/\/generations\/([^/]+)\/commerce/) || [])[1];
  if (!generationId) return errorResponse(res, 400, 'missing_id');

  const db = await getSupabaseAdmin();
  if (!db) return errorResponse(res, 500, 'no_database');

  // Verify generation ownership
  const { data: gen } = await db
    .from('generations')
    .select('id')
    .eq('id', generationId)
    .eq('user_id', user.userId)
    .maybeSingle();
  if (!gen) return errorResponse(res, 404, 'not_found', 'Generation not found');

  if (req.method === 'GET') {
    const { data } = await db
      .from('generation_commerce_meta')
      .select('*')
      .eq('generation_id', generationId)
      .maybeSingle();
    return res.status(200).json({ meta: data || null });
  }

  if (req.method === 'PUT' || req.method === 'POST') {
    const body = await readJson(req);

    const row = {
      generation_id: generationId,
      user_id: user.userId,
      sku: body.sku || null,
      retail_price_cents: body.retailPriceCents ?? null,
      wholesale_price_cents: body.wholesalePriceCents ?? null,
      currency: body.currency || 'usd',
      inventory_qty: body.inventoryQty ?? 0,
      variants: Array.isArray(body.variants) ? body.variants : [],
      channel_categories: body.channelCategories || {},
      image_urls: Array.isArray(body.imageUrls) ? body.imageUrls : [],
      weight_grams: body.weightGrams ?? null,
      hs_code: body.hsCode || null,
      country_of_origin: body.countryOfOrigin || null,
    };

    const { data, error } = await db
      .from('generation_commerce_meta')
      .upsert(row, { onConflict: 'generation_id' })
      .select('*')
      .single();
    if (error) return errorResponse(res, 500, 'save_failed', error.message);

    return res.status(200).json({ meta: data });
  }

  return errorResponse(res, 405, 'method_not_allowed');
}
