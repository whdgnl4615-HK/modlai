// POST /api/edit
// Edit an image via Nano Banana (preserves original detail)
//
// Two modes:
//   - default (AI edit): edits an image via Gemini and charges EDIT_COST credits
//   - mode='crop':       skips Gemini entirely. Just persists the (already
//                        client-cropped) data URL to Storage and DB so it
//                        appears in History. No credits charged.

import { GoogleGenerativeAI } from '@google/generative-ai';
import {
  handleCors, errorResponse, requireAuth, readJson,
  deductCredits, refundCredits, parseDataUrl, uploadGeneratedImage, EDIT_COST,
  envMiddleware, requireOrg, recordGeneration, recordGenerationResult,
} from './_lib/utils.js';

const MODEL_ID = 'gemini-2.5-flash-image';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return errorResponse(res, 405, 'method_not_allowed', 'POST only');

  let user;
  try { user = await requireAuth(req); }
  catch (err) { return errorResponse(res, err.status || 401, 'unauthorized', err.message); }

  let orgId;
  try { orgId = requireOrg(user); }
  catch (err) { return errorResponse(res, err.status || 403, err.code || 'no_org', err.message); }

  // Parse body once so we can branch on mode before checking GOOGLE_API_KEY env
  // (crop mode doesn't need Gemini).
  const body = await readJson(req);
  const mode = body.mode || 'ai';

  if (mode === 'crop') {
    return await handleCropMode(req, res, user, body);
  }

  // ─── DEFAULT: AI edit via Gemini ───
  if (!envMiddleware(res, ['GOOGLE_API_KEY'])) return;

  const cost = EDIT_COST;
  const deducted = await deductCredits(user, cost, 'edit');
  if (!deducted) return errorResponse(res, 402, 'insufficient_credits', 'Not enough credits');

  try {
    const { imageUrl, editPrompt, sourceGenerationId } = body;
    if (!imageUrl)   { await refundCredits(user, cost); return errorResponse(res, 400, 'missing_image', 'imageUrl required'); }
    if (!editPrompt) { await refundCredits(user, cost); return errorResponse(res, 400, 'missing_prompt', 'editPrompt required'); }

    // Accept either data URLs (legacy) or https URLs (new — from Supabase storage).
    // Convert https URLs to the {data, mimeType} shape Gemini expects.
    let parsed;
    if (imageUrl.startsWith('data:')) {
      parsed = parseDataUrl(imageUrl);
    } else if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
      try {
        const imgResp = await fetch(imageUrl);
        if (!imgResp.ok) throw new Error('fetch ' + imgResp.status);
        const ab = await imgResp.arrayBuffer();
        const b64 = Buffer.from(ab).toString('base64');
        const mimeType = imgResp.headers.get('content-type') || 'image/png';
        parsed = { data: b64, mimeType };
      } catch (fetchErr) {
        await refundCredits(user, cost);
        return errorResponse(res, 400, 'bad_image', 'Could not fetch image from URL', fetchErr.message);
      }
    }
    if (!parsed) { await refundCredits(user, cost); return errorResponse(res, 400, 'bad_image', 'imageUrl must be data URL or https URL'); }

    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
    const model = genAI.getGenerativeModel({ model: MODEL_ID });

    const result = await model.generateContent({
      contents: [{
        role: 'user',
        parts: [
          { text: `Edit this image: ${editPrompt}\n\nImportant: Keep the garment, its colors, patterns, and construction exactly as shown. Only change what the instruction asks.` },
          { inlineData: parsed },
        ],
      }],
      generationConfig: { responseModalities: ['IMAGE'] },
    });

    const candidates = result.response.candidates || [];
    let imageData = null, mimeType = 'image/png';
    for (const c of candidates) {
      for (const p of (c.content?.parts || [])) {
        if (p.inlineData?.data) { imageData = p.inlineData.data; mimeType = p.inlineData.mimeType || 'image/png'; break; }
      }
      if (imageData) break;
    }

    if (!imageData) {
      await refundCredits(user, cost);
      return errorResponse(res, 502, 'no_image', 'Edit returned no image');
    }

    let publicUrl;
    try {
      publicUrl = await uploadGeneratedImage(
        user.userId, imageData, mimeType,
        { bucket: 'generated-images', subfolder: 'edit' }
      );
    } catch (uploadErr) {
      console.warn('[edit] storage upload failed, falling back to data URL:', uploadErr.message);
      publicUrl = `data:${mimeType};base64,${imageData}`;
    }

    // ─── Persist to DB so the edit shows in History & survives refresh ───
    // Edits are saved as their own generation row with model_key='edit' so the
    // History view can list them alongside fresh generations.
    let generationId = null;
    try {
      const genRow = await recordGeneration(user, {
        prompt: `[Edit] ${editPrompt}`,
        userPrompt: editPrompt,
        category: 'edit',
        background: null,
        refImages: { source: imageUrl },     // keep a pointer back to the original
        accImages: {},
        totalCost: cost,
        // Note: recordGeneration doesn't take `meta`, but we retain linkage
        // via ref_images.source. Source tracking can be enhanced later.
      });
      generationId = genRow?.id || null;

      if (generationId) {
        await recordGenerationResult(generationId, user, {
          modelKey: 'edit',
          imageUrl: publicUrl,
          cost,
          meta: {
            edit_prompt: editPrompt,
            source_generation_id: sourceGenerationId || null,
            source_image_url: imageUrl,
          },
        });
      }
    } catch (dbErr) {
      // Don't fail the request if DB logging has trouble — user still gets their image
      console.warn('[edit] DB persistence failed (non-fatal):', dbErr.message);
    }

    return res.status(200).json({ imageUrl: publicUrl, cost, generationId });

  } catch (err) {
    console.error('[edit]', err);
    await refundCredits(user, cost);
    return errorResponse(res, 500, 'edit_failed', 'Edit failed', err.message);
  }
}

// ─── Crop mode: persist a client-cropped image without calling AI ───
//
// The frontend already produced the cropped pixels using Canvas API. This
// handler just uploads it to Storage and records it in the generations table
// so it shows up in History (and can be downloaded later, linked to a master,
// etc). No credits are charged because no AI was invoked.
async function handleCropMode(req, res, user, body) {
  const { imageUrl, sourceGenerationId, cropInfo } = body;
  if (!imageUrl) return errorResponse(res, 400, 'missing_image', 'imageUrl required');
  if (!imageUrl.startsWith('data:')) {
    return errorResponse(res, 400, 'bad_image', 'crop mode expects a data URL');
  }

  // Parse and upload the cropped data URL to Storage
  let parsed;
  try {
    parsed = parseDataUrl(imageUrl);
  } catch (e) {
    return errorResponse(res, 400, 'bad_image', 'could not parse data URL', e.message);
  }

  let publicUrl;
  try {
    publicUrl = await uploadGeneratedImage(
      user.userId, parsed.data, parsed.mimeType,
      { bucket: 'generated-images', subfolder: 'crop' }
    );
  } catch (uploadErr) {
    console.warn('[edit:crop] storage upload failed, falling back to data URL:', uploadErr.message);
    publicUrl = imageUrl;
  }

  // Record in DB so it appears in History
  let generationId = null;
  try {
    const ratio = cropInfo?.ratio || 'free';
    const w = cropInfo?.width || 0;
    const h = cropInfo?.height || 0;
    const cropLabel = `[Manual crop ${ratio}] ${w}×${h}`;

    const genRow = await recordGeneration(user, {
      prompt: cropLabel,
      userPrompt: cropLabel,
      category: 'edit',
      background: null,
      refImages: { source: sourceGenerationId ? `generation:${sourceGenerationId}` : 'upload' },
      accImages: {},
      totalCost: 0,
    });
    generationId = genRow?.id || null;

    if (generationId) {
      await recordGenerationResult(generationId, user, {
        modelKey: 'edit',
        imageUrl: publicUrl,
        cost: 0,
        meta: {
          edit_kind: 'manual_crop',
          ratio, width: w, height: h,
          source_generation_id: sourceGenerationId || null,
        },
      });
    }
  } catch (dbErr) {
    console.warn('[edit:crop] DB persistence failed (non-fatal):', dbErr.message);
  }

  return res.status(200).json({ imageUrl: publicUrl, cost: 0, generationId });
}
