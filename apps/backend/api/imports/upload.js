// POST /api/imports/upload
// Body: { filename, fileBase64 }  — base64-encoded file content
//
// Parses the file, detects columns, runs heuristic + AI mapping,
// creates an import_jobs row in 'mapping' status.
// Returns preview data for the UI.

import {
  handleCors, errorResponse, requireAuth, requireOrg, readJson, getSupabaseAdmin,
} from '../_lib/utils.js';
import { parseFile, detectGranularity } from '../_lib/import/file-parser.js';
import { applyMapping } from '../_lib/import/import-engine.js';
import { heuristicMap, aiMap, TARGET_FIELDS } from '../_lib/import/target-schema.js';

const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20MB

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
  const { filename, fileBase64, useAi = true } = body;
  if (!filename) return errorResponse(res, 400, 'missing_filename');
  if (!fileBase64) return errorResponse(res, 400, 'missing_file_data');

  // Decode
  let buffer;
  try {
    buffer = Buffer.from(fileBase64, 'base64');
  } catch {
    return errorResponse(res, 400, 'invalid_base64');
  }
  if (buffer.length > MAX_FILE_BYTES) {
    return errorResponse(res, 413, 'file_too_large', 'Max file size is 20MB');
  }

  // Parse
  let parsed;
  try {
    parsed = parseFile(buffer, filename);
  } catch (err) {
    return errorResponse(res, 400, 'parse_failed', err.message);
  }

  if (parsed.rowCount === 0) {
    return errorResponse(res, 400, 'no_data', 'File has no data rows');
  }

  // Heuristic map first
  const heuristic = heuristicMap(parsed.columns);

  // Optional AI refinement
  let mapping = heuristic.mapping;
  let confidence = heuristic.confidence;
  let reasoning = {};
  let mappingSource = 'heuristic';

  if (useAi && process.env.ANTHROPIC_API_KEY) {
    try {
      const ai = await aiMap(parsed.columns, { existingMapping: heuristic.mapping });
      // Merge: prefer AI mapping, fall back to heuristic
      mapping = { ...heuristic.mapping, ...ai.mapping };
      confidence = { ...heuristic.confidence, ...ai.confidence };
      reasoning = ai.reasoning || {};
      mappingSource = 'ai';
    } catch (err) {
      console.warn('[imports/upload] AI mapping failed:', err.message);
    }
  }

  // Detect granularity with current mapping
  const normalizedPreview = applyMapping(parsed.preview, mapping);
  const normalizedAll = applyMapping(parsed.rows, mapping);
  const granularity = detectGranularity(normalizedAll, mapping);

  // Persist import_jobs row
  const db = await getSupabaseAdmin();
  let jobId = null;
  if (db) {
    const { data: job, error } = await db.from('import_jobs').insert({
      user_id: user.userId,
      org_id: orgId,
      filename,
      file_size_bytes: buffer.length,
      file_type: parsed.fileType,
      sheet_name: parsed.sheetName,
      header_row_index: parsed.headerRowIndex,
      source_columns: parsed.columns,
      row_count: parsed.rowCount,
      mapping,
      mapping_source: mappingSource,
      granularity,
      status: 'mapping',
    }).select('id').single();

    if (error) {
      console.warn('[imports/upload] could not persist job:', error.message);
    } else {
      jobId = job.id;
    }
  }

  return res.status(200).json({
    jobId,
    filename,
    fileType: parsed.fileType,
    sheetName: parsed.sheetName,
    headerRowIndex: parsed.headerRowIndex,
    rowCount: parsed.rowCount,
    columns: parsed.columns,
    mapping,
    confidence,
    reasoning,
    mappingSource,
    granularity,
    preview: parsed.preview,
    previewNormalized: normalizedPreview,
    targetFields: TARGET_FIELDS,
  });
}
