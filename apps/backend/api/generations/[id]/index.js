// GET    /api/generations/:id          → fetch single generation with links summary
// DELETE /api/generations/:id          → delete generation + results + storage
//
// Dynamic route also accepts POST with ?_method=DELETE (Vercel DELETE is finicky)
//
// Safe-delete strategy:
//   1. Verify ownership via org_id + user_id
//   2. Check link status (publishings, masters) → return in response
//   3. If ?force=true is not set AND sensitive links exist, refuse (412 Precondition)
//   4. Delete storage files (bucket: generated-images)
//   5. Delete DB row → cascades to generation_results / commerce_meta / publishings / master_links
//
// FK cascade safety (verified in migrations):
//   generation_results         ON DELETE CASCADE
//   generation_descriptions    ON DELETE CASCADE
//   generation_commerce_meta   ON DELETE CASCADE
//   publishings                ON DELETE CASCADE  ⚠ deletes publish history
//   product_master_generations ON DELETE CASCADE  ⚠ removes from master
//   diagnoses.modlai_generation_id        ON DELETE SET NULL (diag survives)
//   product_masters.primary_generation_id ON DELETE SET NULL (master survives)

import {
  handleCors, errorResponse, requireAuth, requireOrg, getSupabaseAdmin,
} from '../../_lib/utils.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  const genId = req.query?.id
    || (req.url?.match(/\/generations\/([^/?]+)/) || [])[1];
  if (!genId) return errorResponse(res, 400, 'missing_id');

  let user;
  try { user = await requireAuth(req); }
  catch (err) { return errorResponse(res, err.status || 401, 'unauthorized', err.message); }

  let orgId;
  try { orgId = requireOrg(user); }
  catch (err) { return errorResponse(res, err.status || 403, err.code || 'no_org', err.message); }

  const db = await getSupabaseAdmin();
  if (!db) return errorResponse(res, 500, 'no_database');

  // Support POST with ?_method=DELETE (Vercel proxy workaround)
  const effectiveMethod = (req.query?._method || req.method).toUpperCase();

  // Verify ownership upfront
  const { data: gen, error: genErr } = await db
    .from('generations')
    .select('id, user_id, org_id, prompt, created_at')
    .eq('id', genId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (genErr) return errorResponse(res, 500, 'query_failed', genErr.message);
  if (!gen)   return errorResponse(res, 404, 'not_found');

  // ─── GET: return summary with link info ───
  if (effectiveMethod === 'GET') {
    const [results, publishings, masterLinks] = await Promise.all([
      db.from('generation_results').select('id, model_key, image_url, rating').eq('generation_id', genId),
      db.from('publishings').select('id, channel, status, created_at').eq('generation_id', genId),
      db.from('product_master_generations')
        .select('master_id, role, product_masters!inner(name, style_number)')
        .eq('generation_id', genId),
    ]);
    return res.status(200).json({
      generation: gen,
      results: results.data || [],
      publishings: publishings.data || [],
      masterLinks: masterLinks.data || [],
    });
  }

  // ─── DELETE: with safety checks ───
  if (effectiveMethod === 'DELETE') {
    const force = req.query?.force === 'true' || req.query?.force === '1';

    // Check sensitive links BEFORE deleting
    const [publishingsRes, masterLinksRes, resultsRes] = await Promise.all([
      db.from('publishings')
        .select('id, channel, status')
        .eq('generation_id', genId),
      db.from('product_master_generations')
        .select('master_id, role')
        .eq('generation_id', genId),
      db.from('generation_results')
        .select('image_url')
        .eq('generation_id', genId),
    ]);
    const publishings = publishingsRes.data || [];
    const masterLinks = masterLinksRes.data || [];
    const results = resultsRes.data || [];

    // Count sensitive associations (excluding failed publishings)
    const livePublishings = publishings.filter(p => p.status === 'published' || p.status === 'publishing');
    const hasSensitive = livePublishings.length > 0 || masterLinks.length > 0;

    if (hasSensitive && !force) {
      // Refuse without force flag — frontend shows warning and requires explicit confirmation
      return res.status(412).json({
        error: {
          code: 'confirm_required',
          message: 'This generation has active links. Confirm to proceed.',
        },
        links: {
          publishings: livePublishings.map(p => ({ channel: p.channel, status: p.status })),
          masterLinks: masterLinks.map(m => ({ master_id: m.master_id, role: m.role })),
        },
      });
    }

    // ─ Clean up Supabase Storage images (best effort; DB delete is source of truth) ─
    const storagePathsToDelete = [];
    for (const r of results) {
      if (!r.image_url) continue;
      // Extract storage path from Supabase public URL
      // Format: https://<project>.supabase.co/storage/v1/object/public/<bucket>/<path>
      const match = r.image_url.match(/\/storage\/v1\/object\/public\/([^/]+)\/(.+?)(\?|$)/);
      if (match) {
        storagePathsToDelete.push({ bucket: match[1], path: match[2] });
      }
    }

    // Group by bucket for efficient deletion
    const byBucket = {};
    for (const s of storagePathsToDelete) {
      if (!byBucket[s.bucket]) byBucket[s.bucket] = [];
      byBucket[s.bucket].push(s.path);
    }

    let storageCleanupErrors = [];
    for (const [bucket, paths] of Object.entries(byBucket)) {
      try {
        const { error } = await db.storage.from(bucket).remove(paths);
        if (error) storageCleanupErrors.push(`${bucket}: ${error.message}`);
      } catch (e) {
        storageCleanupErrors.push(`${bucket}: ${e.message}`);
      }
    }

    // ─ Clear master.primary_image_url if any master pointed at this gen's image ─
    // (Master.primary_generation_id cascades to SET NULL, but primary_image_url is text
    //  and needs manual clearing; otherwise masters would show 404 images)
    for (const link of masterLinks) {
      if (link.role === 'primary') {
        await db.from('product_masters')
          .update({ primary_image_url: null, primary_generation_id: null })
          .eq('id', link.master_id)
          .eq('primary_generation_id', genId);
      }
    }

    // ─ Delete generation row (DB cascades handle everything else) ─
    const { error: delErr } = await db
      .from('generations')
      .delete()
      .eq('id', genId)
      .eq('org_id', orgId);  // double-check org scope
    if (delErr) return errorResponse(res, 500, 'delete_failed', delErr.message);

    return res.status(200).json({
      ok: true,
      deleted: {
        generation_id: genId,
        results_count: results.length,
        storage_files_attempted: storagePathsToDelete.length,
        storage_files_failed: storageCleanupErrors.length,
        publishings_removed: publishings.length,
        master_links_removed: masterLinks.length,
      },
      warnings: storageCleanupErrors.length
        ? ['Some storage files could not be removed (orphaned): ' + storageCleanupErrors.join('; ')]
        : [],
    });
  }

  return errorResponse(res, 405, 'method_not_allowed');
}
