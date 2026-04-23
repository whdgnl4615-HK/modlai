// POST   /api/imports/masters/:id/link-generation
//   body: { generationId, role?: 'primary'|'alternative'|'before'|'after'|'variant', notes? }
// DELETE /api/imports/masters/:id/link-generation?generationId=...

import {
  handleCors, errorResponse, requireAuth, requireOrg, readJson, getSupabaseAdmin,
} from '../../../_lib/utils.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  let user;
  try { user = await requireAuth(req); }
  catch (err) { return errorResponse(res, err.status || 401, 'unauthorized', err.message); }

  let orgId;
  try { orgId = requireOrg(user); }
  catch (err) { return errorResponse(res, err.status || 403, err.code || 'no_org', err.message); }

  const masterId = req.query?.id
    || (req.url?.match(/\/masters\/([^/]+)\/link-generation/) || [])[1];
  if (!masterId) return errorResponse(res, 400, 'missing_id');

  // Effective method — supports POST with ?_method=DELETE
  const effectiveMethod = (req.query?._method || req.method).toUpperCase();

  const db = await getSupabaseAdmin();
  if (!db) return errorResponse(res, 500, 'no_database');

  // Verify master ownership
  const { data: master } = await db
    .from('product_masters')
    .select('id')
    .eq('id', masterId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (!master) return errorResponse(res, 404, 'master_not_found');

  if (effectiveMethod === 'POST' && !req.query?._method) {
    const { generationId, role = 'primary', notes } = await readJson(req);
    if (!generationId) return errorResponse(res, 400, 'missing_generation_id');

    // Verify generation ownership
    const { data: gen } = await db
      .from('generations')
      .select('id')
      .eq('id', generationId)
      .eq('org_id', orgId)
      .maybeSingle();
    if (!gen) return errorResponse(res, 404, 'generation_not_found');

    // If role='primary', demote any existing primary to 'alternative'
    if (role === 'primary') {
      await db.from('product_master_generations')
        .update({ role: 'alternative' })
        .eq('master_id', masterId)
        .eq('role', 'primary');
    }

    // Upsert the link
    const { data, error } = await db
      .from('product_master_generations')
      .upsert({
        user_id: user.userId, org_id: orgId,
        master_id: masterId,
        generation_id: generationId,
        role,
        notes: notes || null,
      }, { onConflict: 'master_id,generation_id' })
      .select('*')
      .single();
    if (error) return errorResponse(res, 500, 'link_failed', error.message);

    return res.status(200).json({ link: data });
  }

  if (effectiveMethod === 'DELETE') {
    const generationId = req.query?.generationId;
    if (!generationId) return errorResponse(res, 400, 'missing_generation_id');

    const { error } = await db
      .from('product_master_generations')
      .delete()
      .eq('master_id', masterId)
      .eq('generation_id', generationId);
    if (error) return errorResponse(res, 500, 'unlink_failed', error.message);

    // If that was the primary, clear master.primary_generation_id
    await db.from('product_masters')
      .update({ primary_generation_id: null, primary_image_url: null })
      .eq('id', masterId)
      .eq('primary_generation_id', generationId);

    return res.status(200).json({ ok: true });
  }

  return errorResponse(res, 405, 'method_not_allowed');
}
