// GET  /api/models                 → list user's fashion models
// POST /api/models                 → create a new model (no sheet generation yet; use /generate-sheet next)
//
// Body for POST:
//   {
//     name: string,
//     appearance: string,            // short user-written description
//     ageRange?: '20s' | '30s' | ...,
//     gender?: 'female' | 'male' | 'non-binary' | 'unspecified',
//     ethnicity?: string,
//     heightCm?: number,
//     styleTags?: string[],
//     languages?: string[],
//     refImage?: string              // data URL — gets uploaded to Storage
//   }

import {
  handleCors, errorResponse, requireAuth, readJson,
  getSupabaseAdmin, uploadDataUrl,
} from '../_lib/utils.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  let user;
  try { user = await requireAuth(req); }
  catch (err) { return errorResponse(res, err.status || 401, 'unauthorized', err.message); }

  let orgId;
  try { orgId = requireOrg(user); }
  catch (err) { return errorResponse(res, err.status || 403, err.code || 'no_org', err.message); }

  const db = await getSupabaseAdmin();

  // ─────────── LIST ───────────
  if (req.method === 'GET') {
    if (!db) return res.status(200).json({ models: [] }); // demo mode
    const { data, error } = await db
      .from('fashion_models_full')
      .select('*')
      .eq('org_id', orgId)
      .eq('is_archived', false)
      .order('created_at', { ascending: false });
    if (error) return errorResponse(res, 500, 'query_failed', error.message);
    return res.status(200).json({ models: data || [] });
  }

  // ─────────── CREATE ───────────
  if (req.method === 'POST') {
    const body = await readJson(req);
    const {
      name, appearance,
      ageRange, gender, ethnicity, heightCm,
      styleTags = [], languages = [],
      refImage,
    } = body;

    if (!name || !name.trim()) return errorResponse(res, 400, 'missing_name', 'name required');
    if (!appearance || !appearance.trim()) return errorResponse(res, 400, 'missing_appearance', 'appearance required');

    // Upload ref image if provided
    let refImageUrl = null;
    if (refImage && refImage.startsWith('data:')) {
      try {
        refImageUrl = await uploadDataUrl(user.userId, refImage, {
          bucket: 'user-uploads',
          subfolder: 'model-refs',
        });
      } catch (err) {
        console.warn('[models] ref image upload failed:', err.message);
        // Proceed without ref image
      }
    } else if (refImage && refImage.startsWith('http')) {
      refImageUrl = refImage; // already uploaded
    }

    if (!db) {
      // Demo mode — return a fake record
      return res.status(200).json({
        model: {
          id: 'demo-model-' + Date.now(),
          user_id: user.userId, org_id: orgId,
          name, appearance,
          ref_image_url: refImageUrl,
          status: 'draft',
          sheet_count: 0,
          use_count: 0,
          created_at: new Date().toISOString(),
        },
        demo: true,
      });
    }

    const insert = {
      user_id: user.userId, org_id: orgId,
      name: name.trim(),
      appearance: appearance.trim(),
      age_range: ageRange || null,
      gender: gender || null,
      ethnicity: ethnicity || null,
      height_cm: heightCm || null,
      style_tags: Array.isArray(styleTags) ? styleTags : [],
      languages: Array.isArray(languages) ? languages : [],
      ref_image_url: refImageUrl,
      status: 'draft',
    };

    const { data, error } = await db
      .from('fashion_models')
      .insert(insert)
      .select('*')
      .single();
    if (error) return errorResponse(res, 500, 'insert_failed', error.message);

    return res.status(200).json({ model: data });
  }

  return errorResponse(res, 405, 'method_not_allowed', 'GET or POST only');
}
