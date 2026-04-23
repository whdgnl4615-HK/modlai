// POST /api/generate/stability
// Stability AI Stable Image Ultra (+ structure control when ref provided)

import {
  handleCors, errorResponse, requireAuth, readJson,
  deductCredits, refundCredits, parseDataUrl, uploadGeneratedImage, MODEL_COSTS,
  envMiddleware, getModelSheetAsRefImages, requireOrg,
  recordGeneration, recordGenerationResult,
} from '../_lib/utils.js';

const ENDPOINT_ULTRA   = 'https://api.stability.ai/v2beta/stable-image/generate/ultra';
const ENDPOINT_CONTROL = 'https://api.stability.ai/v2beta/stable-image/control/structure';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return errorResponse(res, 405, 'method_not_allowed', 'POST only');
  if (!envMiddleware(res, ['STABILITY_API_KEY'])) return;

  let user;
  try { user = await requireAuth(req); }
  catch (err) { return errorResponse(res, err.status || 401, 'unauthorized', err.message); }

  let orgId;
  try { orgId = requireOrg(user); }
  catch (err) { return errorResponse(res, err.status || 403, err.code || 'no_org', err.message); }

  const cost = MODEL_COSTS.stability;
  const deducted = await deductCredits(user, cost, 'generation', null, 'stability');
  if (!deducted) return errorResponse(res, 402, 'insufficient_credits', 'Not enough credits');

  try {
    const { prompt, refImages = {}, aspectRatio = '3:4', fashionModelId } = await readJson(req);
    if (!prompt) {
      await refundCredits(user, cost);
      return errorResponse(res, 400, 'missing_prompt', 'prompt is required');
    }

    // Stability Ultra only takes one image; use model's primary sheet as structure reference
    // if no garment-main is provided, OR prepend model identity to the prompt.
    let fullPrompt = prompt;
    let structureRef = refImages.main;
    if (fashionModelId) {
      const loaded = await getModelSheetAsRefImages(user.userId, fashionModelId);
      if (loaded) {
        const identity = loaded.model.enriched_appearance || loaded.model.appearance || '';
        if (identity) {
          fullPrompt = `${identity}\n\n${prompt}`;
        }
        // If the user didn't upload a main garment, use the model's front sheet as structure
        if (!structureRef && loaded.refImages.model_front) {
          structureRef = loaded.refImages.model_front;
        }
      }
    }

    const hasMain = !!structureRef;
    const form = new FormData();
    form.append('prompt', fullPrompt);
    form.append('aspect_ratio', aspectRatio);
    form.append('output_format', 'png');

    let endpoint = ENDPOINT_ULTRA;

    if (hasMain) {
      endpoint = ENDPOINT_CONTROL;
      const parsed = parseDataUrl(structureRef);
      if (parsed) {
        const binary = Buffer.from(parsed.data, 'base64');
        const blob = new Blob([binary], { type: parsed.mimeType });
        form.append('image', blob, 'ref.png');
        form.append('control_strength', '0.7');
      }
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.STABILITY_API_KEY}`,
        'Accept': 'image/*',
      },
      body: form,
    });

    if (!response.ok) {
      const errText = await response.text();
      await refundCredits(user, cost);
      return errorResponse(res, response.status, 'stability_error', 'Stability API error', errText);
    }

    const arrayBuffer = await response.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');

    let imageUrl;
    try {
      imageUrl = await uploadGeneratedImage(
        user.userId, base64, 'image/png',
        { bucket: 'generated-images', subfolder: 'generate' }
      );
    } catch (uploadErr) {
      console.warn('[stability] storage upload failed, falling back to data URL:', uploadErr.message);
      imageUrl = `data:image/png;base64,${base64}`;
    }

    // Record in DB
    let generationId = null;
    try {
      const gen = await recordGeneration(user, {
        prompt: fullPrompt,
        userPrompt: prompt,
        aspectRatio,
        fashionModelId,
        totalCost: cost,
      });
      generationId = gen.id;
      await recordGenerationResult(generationId, user, {
        modelKey: 'stability',
        imageUrl,
        cost,
        meta: {
          modelId: hasMain ? 'stable-image-control' : 'stable-image-ultra',
          mode: hasMain ? 'image-to-image' : 'text-to-image',
        },
      });
    } catch (recErr) {
      console.warn('[stability] DB record failed:', recErr.message);
    }

    return res.status(200).json({
      model: 'stability',
      imageUrl,
      generationId,
      cost,
      meta: {
        modelId: hasMain ? 'stable-image-control' : 'stable-image-ultra',
        mode: hasMain ? 'image-to-image' : 'text-to-image',
      },
    });

  } catch (err) {
    console.error('[stability]', err);
    await refundCredits(user, cost);
    return errorResponse(res, 500, 'generation_failed', 'Stability generation failed', err.message);
  }
}
