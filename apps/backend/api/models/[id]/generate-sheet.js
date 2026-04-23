// POST /api/models/:id/generate-sheet
//
// Generates a character sheet (4-6 reference images at different angles) for a
// fashion model. This is the key to consistency: once these exist, every future
// generation using this model includes them as refImages to keep the face/body
// identical across outputs.
//
// Flow:
//   1. Claude enriches the short appearance text → rich visual description
//   2. Nano Banana generates each angle (front, 3/4, side, full_body)
//      - For the first angle, if a user ref photo exists, use it as seed
//      - For subsequent angles, use the first generated image as seed (so
//        the face stays identical)
//   3. All images are uploaded to Supabase Storage
//   4. Rows inserted into fashion_model_sheets
//   5. Model status updated: 'draft' → 'generating_sheet' → 'ready'
//
// Body:
//   { angles?: string[] }  — override default angles

import { GoogleGenerativeAI } from '@google/generative-ai';
import Anthropic from '@anthropic-ai/sdk';
import {
  handleCors, errorResponse, requireAuth, readJson,
  getSupabaseAdmin, uploadGeneratedImage, parseDataUrl,
  deductCredits, refundCredits, getSystemSetting, envMiddleware, MODEL_COSTS} from '../../_lib/utils.js';

const NANO_MODEL = 'gemini-2.5-flash-image';

const ANGLE_PROMPTS = {
  front:          'Full-body studio portrait, facing camera directly, centered composition, relaxed neutral pose, arms at sides, hands visible.',
  three_quarter:  'Three-quarter angle full-body studio portrait, body turned 45° from camera, head facing camera, relaxed pose.',
  side:           'Full-body profile side view studio portrait, body turned 90° from camera, looking forward.',
  back:           'Full-body back view studio portrait, subject facing away from camera, showing full silhouette and hair from behind.',
  full_body:      'Full-body fashion editorial pose, natural dynamic stance, looking toward camera, head-to-toe visible.',
  portrait:       'Medium shot portrait from chest up, facing camera, soft neutral expression.',
};

const BASE_STYLE = 'Shot on a cinema camera with 85mm lens. Soft diffused studio lighting. Neutral light gray seamless background. Clean minimal fashion editorial style. Photorealistic, sharp focus, high detail. No text, no watermark, no graphics.';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return errorResponse(res, 405, 'method_not_allowed', 'POST only');
  if (!envMiddleware(res, ['ANTHROPIC_API_KEY', 'GOOGLE_API_KEY'])) return;

  let user;
  try { user = await requireAuth(req); }
  catch (err) { return errorResponse(res, err.status || 401, 'unauthorized', err.message); }

  const modelId = req.query?.id || (req.url?.match(/\/models\/([^/?]+)/) || [])[1];
  if (!modelId) return errorResponse(res, 400, 'missing_id', 'model id required');

  const db = await getSupabaseAdmin();
  if (!db) return errorResponse(res, 500, 'no_database', 'Database not configured');

  const { data: model, error: lookupErr } = await db
    .from('fashion_models')
    .select('*')
    .eq('id', modelId)
    .eq('user_id', user.userId)
    .maybeSingle();
  if (lookupErr) return errorResponse(res, 500, 'query_failed', lookupErr.message);
  if (!model)     return errorResponse(res, 404, 'not_found', 'Model not found');
  if (model.status === 'ready' || model.status === 'generating_sheet') {
    // Allow re-generate; we'll clear old sheets
  }

  // Determine angles
  const body = await readJson(req).catch(() => ({}));
  const defaultAngles = await getSystemSetting('model_sheet_angles', ['front', 'three_quarter', 'side', 'full_body']);
  const angles = Array.isArray(body.angles) && body.angles.length
    ? body.angles
    : (Array.isArray(defaultAngles) ? defaultAngles : ['front', 'three_quarter', 'side', 'full_body']);

  // Cost = nanobanana cost per image (fetch from settings or default)
  const perImageCost = 30;  // matches MODEL_COSTS.nanobanana
  const totalCost = perImageCost * angles.length;

  const deducted = await deductCredits(user, totalCost, 'generation', modelId, 'character sheet');
  if (!deducted) return errorResponse(res, 402, 'insufficient_credits', `Need ${totalCost} credits`);

  try {
    // ─────────── Step 1: Enrich appearance with Claude ───────────
    await db.from('fashion_models').update({ status: 'generating_sheet' }).eq('id', modelId);

    let enriched = model.enriched_appearance;
    if (!enriched) {
      enriched = await enrichAppearance(model);
      await db.from('fashion_models').update({ enriched_appearance: enriched }).eq('id', modelId);
    }

    // ─────────── Step 2: Generate each angle ───────────
    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
    const nanoModel = genAI.getGenerativeModel({ model: NANO_MODEL });

    const results = [];
    let seedImage = null;        // reference image used for subsequent angles (ensures consistency)
    let seedImageMime = 'image/png';

    // If user uploaded a ref image, fetch it as our initial seed
    if (model.ref_image_url) {
      try {
        const fetched = await fetchImageAsBase64(model.ref_image_url, db, user.userId);
        if (fetched) { seedImage = fetched.data; seedImageMime = fetched.mimeType; }
      } catch (e) {
        console.warn('[sheet] failed to fetch ref image:', e.message);
      }
    }

    // Clear any previous sheets
    await db.from('fashion_model_sheets').delete().eq('fashion_model_id', modelId);

    for (let i = 0; i < angles.length; i++) {
      const angle = angles[i];
      const anglePrompt = ANGLE_PROMPTS[angle] || `Full-body studio portrait, ${angle} angle.`;

      const fullPrompt = `${enriched}\n\n${anglePrompt}\n\n${BASE_STYLE}\n\nImportant: Keep the exact same person/face across all shots. Same features, same hair, same skin tone, same body proportions.`;

      const parts = [{ text: fullPrompt }];
      if (seedImage) {
        parts.push({ text: '[Reference — this is the exact same person. Keep the identity consistent.]' });
        parts.push({ inlineData: { mimeType: seedImageMime, data: seedImage } });
      }

      const result = await nanoModel.generateContent({
        contents: [{ role: 'user', parts }],
        generationConfig: { responseModalities: ['IMAGE'] },
      });

      const imageData = extractImageData(result.response);
      if (!imageData) {
        console.warn(`[sheet] no image for angle=${angle}`);
        continue;
      }

      // Upload to Storage
      const publicUrl = await uploadGeneratedImage(
        user.userId, imageData.data, imageData.mimeType,
        { subfolder: `models/${modelId}` }
      );

      // Insert sheet row
      const { data: sheetRow } = await db.from('fashion_model_sheets').insert({
        fashion_model_id: modelId,
        user_id: user.userId,
        angle,
        image_url: publicUrl,
        model_key: 'nanobanana',
        cost: perImageCost,
        is_primary: i === 0,
        sort_order: i,
      }).select('*').single();

      results.push(sheetRow);

      // Use the first image as seed for subsequent angles (identity lock)
      if (i === 0) {
        seedImage = imageData.data;
        seedImageMime = imageData.mimeType;
      }
    }

    if (!results.length) {
      await db.from('fashion_models').update({ status: 'failed' }).eq('id', modelId);
      await refundCredits(user, totalCost, 'refund', 'no sheet images generated');
      return errorResponse(res, 502, 'no_images', 'Character sheet generation failed');
    }

    // Refund the cost of any angles that failed
    const failedCount = angles.length - results.length;
    if (failedCount > 0) {
      await refundCredits(user, perImageCost * failedCount, 'refund', `${failedCount} angles failed`);
    }

    // Update model: set primary image, status=ready
    await db.from('fashion_models').update({
      status: 'ready',
      primary_sheet_image_url: results[0]?.image_url || null,
    }).eq('id', modelId);

    return res.status(200).json({
      ok: true,
      sheets: results,
      cost: perImageCost * results.length,
    });

  } catch (err) {
    console.error('[sheet] exception:', err);
    await db.from('fashion_models').update({ status: 'failed' }).eq('id', modelId);
    await refundCredits(user, totalCost, 'refund', 'exception');
    return errorResponse(res, 500, 'sheet_failed', 'Character sheet generation failed', err.message);
  }
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
async function enrichAppearance(model) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const systemPrompt = `You are a fashion casting director. Given sparse model info, write a rich, specific visual description suitable for AI image generation.
- Cover: age range, ethnicity, face shape, eye color/shape, hair color/length/style, skin tone, height, build, distinguishing features, typical expression
- Keep it to one dense paragraph (max 100 words)
- Be specific with physical details (AI models need specifics)
- Do NOT include clothing or background — the model should be describable independent of outfit
- Do NOT add made-up details if unsure; stay faithful to what was given
- Write in English`;

  const attrs = [
    model.name ? `Name: ${model.name}` : '',
    model.age_range ? `Age: ${model.age_range}` : '',
    model.gender ? `Gender: ${model.gender}` : '',
    model.ethnicity ? `Ethnicity: ${model.ethnicity}` : '',
    model.height_cm ? `Height: ${model.height_cm}cm` : '',
    (model.style_tags && model.style_tags.length) ? `Style vibe: ${model.style_tags.join(', ')}` : '',
    '',
    `User description: ${model.appearance}`,
  ].filter(Boolean).join('\n');

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 400,
    system: systemPrompt,
    messages: [{ role: 'user', content: `Write the rich description:\n\n${attrs}` }],
  });

  return msg.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim();
}

function extractImageData(response) {
  const candidates = response.candidates || [];
  for (const c of candidates) {
    for (const p of (c.content?.parts || [])) {
      if (p.inlineData?.data) {
        return { data: p.inlineData.data, mimeType: p.inlineData.mimeType || 'image/png' };
      }
    }
  }
  return null;
}

async function fetchImageAsBase64(urlOrPath, admin, userId) {
  // If it's already a data URL
  const parsed = parseDataUrl(urlOrPath);
  if (parsed) return parsed;

  // If it's a Supabase-signed URL or public URL, fetch directly
  try {
    const res = await fetch(urlOrPath);
    if (!res.ok) return null;
    const mimeType = res.headers.get('content-type') || 'image/jpeg';
    const buf = Buffer.from(await res.arrayBuffer());
    return { mimeType, data: buf.toString('base64') };
  } catch {
    return null;
  }
}
