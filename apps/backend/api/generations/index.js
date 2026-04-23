// GET /api/generations?limit=50&offset=0
// Returns user/org's generation history with their results (images).

import {
  handleCors, errorResponse, requireAuth, requireOrg,
  getSupabaseAdmin,
} from '../_lib/utils.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'GET') return errorResponse(res, 405, 'method_not_allowed');

  let user;
  try { user = await requireAuth(req); }
  catch (err) { return errorResponse(res, err.status || 401, 'unauthorized', err.message); }

  let orgId;
  try { orgId = requireOrg(user); }
  catch (err) { return errorResponse(res, err.status || 403, err.code || 'no_org', err.message); }

  const db = await getSupabaseAdmin();
  if (!db) return res.status(200).json({ generations: [], total: 0 });

  const limit  = Math.min(parseInt(req.query?.limit || '50', 10), 200);
  const offset = Math.max(parseInt(req.query?.offset || '0', 10), 0);

  // Fetch generations scoped to org
  const { data: gens, count, error } = await db
    .from('generations')
    .select(
      'id, prompt, user_prompt, aspect_ratio, ref_images, acc_images, fashion_model_id, total_cost, created_at',
      { count: 'exact' }
    )
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return errorResponse(res, 500, 'query_failed', error.message);

  if (!gens || gens.length === 0) {
    return res.status(200).json({ generations: [], total: count || 0, limit, offset });
  }

  // Fetch all results for these generations in one query
  const genIds = gens.map(g => g.id);
  const { data: results } = await db
    .from('generation_results')
    .select('id, generation_id, model_key, image_url, cost, rating, liked, meta, created_at')
    .in('generation_id', genIds);

  // Group results by generation_id
  const resultsByGen = {};
  for (const r of (results || [])) {
    if (!resultsByGen[r.generation_id]) resultsByGen[r.generation_id] = [];
    resultsByGen[r.generation_id].push(r);
  }

  // Attach
  const enriched = gens.map(g => ({
    ...g,
    results: resultsByGen[g.id] || [],
  }));

  return res.status(200).json({
    generations: enriched,
    total: count || 0,
    limit, offset,
  });
}
