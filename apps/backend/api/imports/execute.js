// POST /api/imports/execute
// Body: {
//   jobId,                          — from upload step
//   fileBase64, filename,           — re-upload file content (not stored server-side)
//   mapping,                        — final mapping (user may have edited)
//   granularity,                    — 'master' or 'master_with_variants'
// }
//
// Parses again, applies mapping, writes to product_masters + product_master_variants.

import {
  handleCors, errorResponse, requireAuth, requireOrg, readJson, getSupabaseAdmin,
} from '../_lib/utils.js';
import { parseFile } from '../_lib/import/file-parser.js';
import { applyMapping, runImport } from '../_lib/import/import-engine.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return errorResponse(res, 405, 'method_not_allowed');

  let user;
  try { user = await requireAuth(req); }
  catch (err) { return errorResponse(res, err.status || 401, 'unauthorized', err.message); }

  let orgId;
  try { orgId = requireOrg(user); }
  catch (err) { return errorResponse(res, err.status, err.code || 'no_org', err.message); }

  const body = await readJson(req);
  const { jobId, filename, fileBase64, mapping, granularity } = body;
  if (!filename || !fileBase64) return errorResponse(res, 400, 'missing_file');
  if (!mapping || typeof mapping !== 'object') return errorResponse(res, 400, 'missing_mapping');

  // Parse + normalize
  let parsed;
  try {
    parsed = parseFile(Buffer.from(fileBase64, 'base64'), filename);
  } catch (err) {
    return errorResponse(res, 400, 'parse_failed', err.message);
  }
  const normalizedRows = applyMapping(parsed.rows, mapping);

  // Verify style_number is mapped
  const hasStyle = Object.values(mapping).includes('style_number');
  if (!hasStyle) {
    return errorResponse(res, 400, 'missing_required_mapping',
      'You must map a source column to "style_number"');
  }

  // Update job to 'importing'
  const db = await getSupabaseAdmin();
  if (db && jobId) {
    await db.from('import_jobs').update({
      status: 'importing',
      mapping,
      mapping_source: 'user',
      granularity: granularity || 'master',
    }).eq('id', jobId).eq('org_id', orgId);
  }

  const started = Date.now();
  let result;
  try {
    result = await runImport({
      userId: user.userId,
      orgId,
      importJobId: jobId,
      normalizedRows,
      granularity: granularity || 'master',
    });
  } catch (err) {
    if (db && jobId) {
      await db.from('import_jobs').update({
        status: 'failed',
        error_message: err.message,
        completed_at: new Date().toISOString(),
      }).eq('id', jobId);
    }
    return errorResponse(res, 500, 'import_failed', err.message);
  }

  const duration = Date.now() - started;

  // Update job row
  if (db && jobId) {
    await db.from('import_jobs').update({
      status: 'completed',
      masters_created: result.masters_created,
      masters_updated: result.masters_updated,
      variants_created: result.variants_created,
      rows_skipped: result.rows_skipped,
      errors: result.errors.slice(0, 100),
      duration_ms: duration,
      completed_at: new Date().toISOString(),
    }).eq('id', jobId);
  }

  return res.status(200).json({
    ok: true,
    jobId,
    ...result,
    duration_ms: duration,
  });
}
