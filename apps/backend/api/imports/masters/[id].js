// GET  /api/imports/masters/:id       → master + all linked data (generations, publishings, diagnoses, errors)
// PATCH /api/imports/masters/:id       → update master fields
// DELETE /api/imports/masters/:id      → soft delete (archive)

import {
  handleCors, errorResponse, requireAuth, requireOrg, readJson, getSupabaseAdmin,
} from '../../_lib/utils.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  // Support _method=DELETE override (Vercel dynamic routes are finicky with DELETE)
  const methodOverride = req.query?._method;
  const effectiveMethod = methodOverride ? methodOverride.toUpperCase() : req.method;

  let user;
  try { user = await requireAuth(req); }
  catch (err) { return errorResponse(res, err.status || 401, 'unauthorized', err.message); }

  let orgId;
  try { orgId = requireOrg(user); }
  catch (err) { return errorResponse(res, err.status, err.code || 'no_org', err.message); }

  const masterId = req.query?.id || (req.url?.match(/\/masters\/([^/?]+)/) || [])[1];
  if (!masterId) return errorResponse(res, 400, 'missing_id');

  const db = await getSupabaseAdmin();
  if (!db) return errorResponse(res, 500, 'no_database');

  // Verify master belongs to this org
  const { data: master, error: mErr } = await db
    .from('product_masters_with_status')
    .select('*')
    .eq('id', masterId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (mErr)    return errorResponse(res, 500, 'query_failed', mErr.message);
  if (!master) return errorResponse(res, 404, 'not_found', 'Master not found');

  // ─── GET ───
  if (effectiveMethod === 'GET') {
    const [variantsR, genLinksR, diagnosesR, errorsR] = await Promise.all([
      db.from('product_master_variants')
        .select('*')
        .eq('master_id', masterId)
        .order('size_order'),
      db.from('product_master_generations')
        .select('id, role, display_order, created_at, notes, generation_id, generations!inner(id, user_prompt, model_key, created_at)')
        .eq('master_id', masterId)
        .order('display_order'),
      db.from('ai_diagnoses')
        .select('id, overall_score, issues, strengths, recommendations, created_at')
        .eq('master_id', masterId)
        .order('created_at', { ascending: false })
        .limit(5),
      db.from('product_master_errors')
        .select('*')
        .eq('master_id', masterId)
        .order('created_at', { ascending: false })
        .limit(20),
    ]);

    // For generation links, also pull the image URLs
    const genIds = (genLinksR.data || []).map(g => g.generation_id);
    let genResultsMap = {};
    if (genIds.length) {
      const { data: results } = await db
        .from('generation_results')
        .select('generation_id, image_url, is_best, liked, rating')
        .in('generation_id', genIds);
      for (const r of (results || [])) {
        if (!genResultsMap[r.generation_id]) genResultsMap[r.generation_id] = [];
        genResultsMap[r.generation_id].push(r);
      }
    }

    return res.status(200).json({
      master,
      variants:  variantsR.data || [],
      generations: (genLinksR.data || []).map(g => ({
        ...g,
        results: genResultsMap[g.generation_id] || [],
      })),
      diagnoses: diagnosesR.data || [],
      errors:    errorsR.data || [],
    });
  }

  // ─── PATCH ───
  // Skip if _method override is set (e.g., ?_method=DELETE — let DELETE block handle)
  if ((effectiveMethod === 'PATCH' || effectiveMethod === 'POST') && !req.query?._method) {
    const body = await readJson(req);
    const allowed = [
      'name', 'description', 'category', 'subcategory', 'division', 'subdivision',
      'season', 'tags', 'wholesale_price_cents', 'retail_price_cents', 'cost_cents',
      'currency', 'available_date', 'start_sell_date', 'vendor', 'country_of_origin',
      'fabric_content', 'fabric_type', 'weight_grams', 'prepack', 'size_category',
      'pack_quantity', 'min_order_qty', 'status', 'primary_image_url',
    ];
    const patch = {};
    for (const k of allowed) {
      if (body[k] !== undefined) patch[k] = body[k];
    }
    if (Object.keys(patch).length === 0) {
      return errorResponse(res, 400, 'no_fields', 'No valid fields to update');
    }

    const { data, error } = await db
      .from('product_masters')
      .update(patch)
      .eq('id', masterId)
      .eq('org_id', orgId)
      .select('*')
      .single();
    if (error) return errorResponse(res, 500, 'update_failed', error.message);
    return res.status(200).json({ master: data });
  }

  // ─── DELETE (soft) ───
  if (effectiveMethod === 'DELETE') {
    const permanent = req.query?.permanent === 'true';
    const patch = permanent
      ? { is_archived: true, deleted_at: new Date().toISOString(), deleted_by: user.userId }
      : { is_archived: true };
    const { error } = await db
      .from('product_masters')
      .update(patch)
      .eq('id', masterId)
      .eq('org_id', orgId);
    if (error) return errorResponse(res, 500, 'delete_failed', error.message);
    return res.status(200).json({ ok: true, permanent });
  }

  return errorResponse(res, 405, 'method_not_allowed');
}
