// GET    /api/models/:id           → model details + sheets
// PATCH  /api/models/:id           → update fields
// DELETE /api/models/:id           → archive (soft delete)

import {
  handleCors, errorResponse, requireAuth, readJson, getSupabaseAdmin, requireOrg} from '../_lib/utils.js';

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

  // Effective method — lets frontends POST with ?_method=DELETE/PATCH
  // (Vercel dynamic routes can be flaky with non-GET/POST verbs)
  const effectiveMethod = (req.query?._method || req.method).toUpperCase();

  const db = await getSupabaseAdmin();
  if (!db) return errorResponse(res, 500, 'no_database', 'Database not configured');

  // Verify ownership
  // Lookup: allow viewing either an org-owned model OR a system model (org_id NULL)
  const { data: model, error: lookupErr } = await db
    .from('fashion_models_full')
    .select('*')
    .eq('id', modelId)
    .or(`org_id.eq.${orgId},org_id.is.null`)
    .maybeSingle();
  if (lookupErr) return errorResponse(res, 500, 'query_failed', lookupErr.message);
  if (!model)     return errorResponse(res, 404, 'not_found', 'Model not found');

  // Helper: check if user can modify this specific model
  const isPlatformAdmin = user.role === 'admin';
  const isSystemModel   = model.org_id === null;
  const canModify       = isSystemModel ? isPlatformAdmin : true;  // org members can modify org models; only platform admins can modify system models

  // ─────────── GET ───────────
  if (effectiveMethod === 'GET') {
    const { data: sheets } = await db
      .from('fashion_model_sheets')
      .select('*')
      .eq('fashion_model_id', modelId)
      .order('sort_order');
    return res.status(200).json({ model, sheets: sheets || [] });
  }

  // ─────────── PATCH ───────────
  if (effectiveMethod === 'PATCH' || effectiveMethod === 'POST') {
    if (!canModify) {
      return errorResponse(res, 403, 'forbidden',
        'System models can only be edited by platform admins');
    }
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

    // Only do PATCH if there are actual fields to update
    if (Object.keys(patch).length > 0) {
      // Build the update query — scope to org if org model, to null if system
      let query = db.from('fashion_models').update(patch).eq('id', modelId);
      query = isSystemModel ? query.is('org_id', null) : query.eq('org_id', orgId);
      const { data, error } = await query.select('*').single();
      if (error) return errorResponse(res, 500, 'update_failed', error.message);
      return res.status(200).json({ model: data });
    }
    // If no fields and method is POST, fall through — probably a misrouted request
    if (effectiveMethod === 'POST') {
      return errorResponse(res, 400, 'no_fields', 'No fields to update. Use ?_method=DELETE to delete.');
    }
  }

  // ─────────── DELETE (archive) ───────────
  if (effectiveMethod === 'DELETE') {
    if (!canModify) {
      return errorResponse(res, 403, 'forbidden',
        'System models can only be deleted by platform admins');
    }
    let query = db.from('fashion_models').update({ is_archived: true }).eq('id', modelId);
    query = isSystemModel ? query.is('org_id', null) : query.eq('org_id', orgId);
    const { error } = await query;
    if (error) return errorResponse(res, 500, 'delete_failed', error.message);
    return res.status(200).json({ ok: true });
  }

  return errorResponse(res, 405, 'method_not_allowed');
}
