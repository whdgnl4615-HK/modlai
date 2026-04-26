// POST /api/generate/nanobanana2 — Premium tier (Gemini 3.1 Flash Image)
// Google Gemini 3.1 Flash Image ("Nano Banana 2") — released Feb 2026
// Best for: face consistency, sharper detail, photorealistic skin, multi-image composition (up to 14 refs)
//           Premium upgrade over the original nanobanana endpoint (Gemini 2.5 Flash Image).

import { GoogleGenerativeAI } from '@google/generative-ai';
import {
  handleCors, errorResponse, requireAuth, readJson,
  deductCredits, refundCredits, parseDataUrl, uploadGeneratedImage, MODEL_COSTS,
  envMiddleware, getModelSheetAsRefImages,
  recordGeneration, recordGenerationResult,
} from '../_lib/utils.js';

const MODEL_ID = 'gemini-3.1-flash-image-preview';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return errorResponse(res, 405, 'method_not_allowed', 'POST only');
  if (!envMiddleware(res, ['GOOGLE_API_KEY'])) return;

  let user;
  try { user = await requireAuth(req); }
  catch (err) { return errorResponse(res, err.status || 401, 'unauthorized', err.message); }

  const cost = MODEL_COSTS.nanobanana2;
  const deducted = await deductCredits(user, cost, 'generation', null, 'nanobanana2');
  if (!deducted) return errorResponse(res, 402, 'insufficient_credits', 'Not enough credits');

  try {
    const { prompt, refImages = {}, accImages = {}, aspectRatio = '3:4', fashionModelId } = await readJson(req);
    if (!prompt) {
      await refundCredits(user, cost, 'refund', 'missing prompt');
      return errorResponse(res, 400, 'missing_prompt', 'prompt is required');
    }
    if (!refImages.main) {
      await refundCredits(user, cost, 'refund', 'missing main image');
      return errorResponse(res, 400, 'missing_main', 'Main reference image is required');
    }

    // ─── Inject fashion model character sheet if model selected ───
    let modelMeta = null;
    let modelRefImages = {};
    if (fashionModelId) {
      const loaded = await getModelSheetAsRefImages(user.userId, fashionModelId);
      if (loaded) {
        modelMeta = loaded.model;
        modelRefImages = loaded.refImages;
      }
    }

    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
    const model = genAI.getGenerativeModel({ model: MODEL_ID });

    // Build enriched prompt with model identity
    let fullPrompt = prompt;
    if (modelMeta) {
      const identity = modelMeta.enriched_appearance || modelMeta.appearance || '';
      if (identity) {
        fullPrompt = `Model identity (keep exact same person across this image): ${identity}\n\n${prompt}`;
      }
    }
    fullPrompt += `\n\nOutput aspect ratio: ${aspectRatio}.`;

    const parts = [{ text: fullPrompt }];

    // Model sheet reference images FIRST (identity takes priority)
    for (const [slot, dataUrl] of Object.entries(modelRefImages)) {
      if (!dataUrl) continue;
      const parsed = parseDataUrl(dataUrl);
      if (parsed) {
        parts.push({ text: `[Identity reference — same person, ${slot.replace('model_','')} angle]` });
        parts.push({ inlineData: parsed });
      }
    }

    // Garment reference images
    for (const [slot, dataUrl] of Object.entries(refImages)) {
      if (!dataUrl) continue;
      const parsed = parseDataUrl(dataUrl);
      if (parsed) {
        parts.push({ text: `[Reference - ${slot} view of the garment]` });
        parts.push({ inlineData: parsed });
      }
    }

    // Accessories
    for (const [slot, dataUrl] of Object.entries(accImages)) {
      if (!dataUrl) continue;
      const parsed = parseDataUrl(dataUrl);
      if (parsed) {
        parts.push({ text: `[Accessory - ${slot} to style onto the model]` });
        parts.push({ inlineData: parsed });
      }
    }

    const result = await model.generateContent({
      contents: [{ role: 'user', parts }],
      generationConfig: { responseModalities: ['IMAGE'] }
    });

    const imageData = extractImageData(result.response);
    if (!imageData) {
      await refundCredits(user, cost, 'refund', 'no image returned');
      return errorResponse(res, 502, 'no_image', 'Model returned no image');
    }

    // Upload to Supabase Storage so the URL is persistent and publicly reachable
    // (needed for Faire publishing, image rendering in emails, etc.)
    let imageUrl;
    try {
      imageUrl = await uploadGeneratedImage(
        user.userId,
        imageData.data,
        imageData.mimeType,
        { bucket: 'generated-images', subfolder: 'generate' }
      );
    } catch (uploadErr) {
      console.warn('[nanobanana2] storage upload failed, falling back to data URL:', uploadErr.message);
      imageUrl = `data:${imageData.mimeType};base64,${imageData.data}`;
    }

    // Record in DB so it shows up in History after refresh
    let generationId = null;
    try {
      const gen = await recordGeneration(user, {
        prompt: fullPrompt,
        userPrompt: prompt,
        aspectRatio,
        refImages: Object.keys(refImages).length ? Object.fromEntries(
          Object.entries(refImages).map(([k, v]) => [k, typeof v === 'string' && v.startsWith('data:') ? '(uploaded)' : v])
        ) : {},
        accImages: Object.keys(accImages).length ? Object.fromEntries(
          Object.entries(accImages).map(([k, v]) => [k, typeof v === 'string' && v.startsWith('data:') ? '(uploaded)' : v])
        ) : {},
        fashionModelId,
        totalCost: cost,
      });
      generationId = gen.id;
      await recordGenerationResult(generationId, user, {
        modelKey: 'nanobanana2',
        imageUrl,
        cost,
        meta: { modelId: MODEL_ID },
      });
    } catch (recErr) {
      console.warn('[nanobanana2] DB record failed:', recErr.message);
      // Don't fail the request — user still gets the image
    }

    return res.status(200).json({
      model: 'nanobanana2',
      imageUrl,
      generationId,
      cost,
      meta: { modelId: MODEL_ID },
    });

  } catch (err) {
    console.error('[nanobanana2]', err);
    await refundCredits(user, cost, 'refund', 'exception');
    return errorResponse(res, 500, 'generation_failed', 'Image generation failed', err.message);
  }
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
