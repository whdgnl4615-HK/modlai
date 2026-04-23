// GET    /api/models/:id           → model details + sheets
// PATCH  /api/models/:id           → update fields
// DELETE /api/models/:id           → archive (soft delete)

import {
  handleCors, errorResponse, requireAuth, readJson, getSupabaseAdmin,
} from '../_lib/utils.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  let user;
  try { user = await requireAuth(req); }
  catch (err) { return errorResponse(res, err.status || 401, 'unauthorized', err.message); }

  let orgId;
  try { orgId = requireOrg(user); }
  catch (err) { return errorResponse(res, err.status || 403, err.code || 'no_org', err.message); }

  const modelId = req.query?.id || (req.url?.match(/\/models\/([^/?]+)/) || [])[1];
  if (!modelId) return errorResponse(res, 400, 'missing_id', 'model id required');

  const db = await getSupabaseAdmin();
  if (!db) return errorResponse(res, 500, 'no_database', 'Database not configured');

  // Verify ownership
  const { data: model, error: lookupErr } = await db
    .from('fashion_models_full')
    .select('*')
    .eq('id', modelId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (lookupErr) return errorResponse(res, 500, 'query_failed', lookupErr.message);
  if (!model)     return errorResponse(res, 404, 'not_found', 'Model not found');

  // ─────────── GET ───────────
  if (req.method === 'GET') {
    const { data: sheets } = await db
      .from('fashion_model_sheets')
      .select('*')
      .eq('fashion_model_id', modelId)
      .order('sort_order');
    return res.status(200).json({ model, sheets: sheets || [] });
  }

  // ─────────── PATCH ───────────
  if (req.method === 'PATCH') {
    const body = await readJson(req);
    const patch = {};
    if (body.name !== undefined)        patch.name = body.name.trim();
    if (body.appearance !== undefined)  patch.appearance = body.appearance.trim();
    if (body.ageRange !== undefined)    patch.age_range = body.ageRange;
    if (body.gender !== undefined)      patch.gender = body.gender;
    if (body.ethnicity !== undefined)   patch.ethnicity = body.ethnicity;
    if (body.heightCm !== undefined)    patch.height_cm = body.heightCm;
    if (body.styleTags !== undefined)   patch.style_tags = body.styleTags;
    if (body.languages !== undefined)   patch.languages = body.languages;

    const { data, error } = await db
      .from('fashion_models')
      .update(patch)
      .eq('id', modelId)
      .eq('org_id', orgId)
      .select('*')
      .single();
    if (error) return errorResponse(res, 500, 'update_failed', error.message);
    return res.status(200).json({ model: data });
  }

  // ─────────── DELETE (archive) ───────────
  if (req.method === 'DELETE') {
    const { error } = await db
      .from('fashion_models')
      .update({ is_archived: true })
      .eq('id', modelId)
      .eq('org_id', orgId);
    if (error) return errorResponse(res, 500, 'delete_failed', error.message);
    return res.status(200).json({ ok: true });
  }

  return errorResponse(res, 405, 'method_not_allowed');
}
