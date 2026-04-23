// POST /api/generate/openai
// OpenAI gpt-image-1

import OpenAI, { toFile } from 'openai';
import {
  handleCors, errorResponse, requireAuth, readJson,
  deductCredits, refundCredits, parseDataUrl, uploadGeneratedImage, MODEL_COSTS,
  envMiddleware, getModelSheetAsRefImages, requireOrg} from '../_lib/utils.js';

const MODEL_ID = 'gpt-image-1';

const SIZE_MAP = {
  '1:1':  '1024x1024',
  '3:4':  '1024x1536',
  '4:5':  '1024x1536',
  '16:9': '1536x1024',
  '9:16': '1024x1536',
};

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return errorResponse(res, 405, 'method_not_allowed', 'POST only');
  if (!envMiddleware(res, ['OPENAI_API_KEY'])) return;

  let user;
  try { user = await requireAuth(req); }
  catch (err) { return errorResponse(res, err.status || 401, 'unauthorized', err.message); }

  let orgId;
  try { orgId = requireOrg(user); }
  catch (err) { return errorResponse(res, err.status || 403, err.code || 'no_org', err.message); }

  const cost = MODEL_COSTS.openai;
  const deducted = await deductCredits(user, cost, 'generation', null, 'openai');
  if (!deducted) return errorResponse(res, 402, 'insufficient_credits', 'Not enough credits');

  try {
    const { prompt, refImages = {}, aspectRatio = '3:4', fashionModelId } = await readJson(req);
    if (!prompt) {
      await refundCredits(user, cost);
      return errorResponse(res, 400, 'missing_prompt', 'prompt is required');
    }

    // Load fashion model sheet (sheets become input images for edit mode)
    let modelRefImages = {};
    let fullPrompt = prompt;
    if (fashionModelId) {
      const loaded = await getModelSheetAsRefImages(user.userId, fashionModelId);
      if (loaded) {
        modelRefImages = loaded.refImages;
        const identity = loaded.model.enriched_appearance || loaded.model.appearance || '';
        if (identity) {
          fullPrompt = `Keep the exact same model identity as shown in the reference image(s): ${identity}\n\n${prompt}`;
        }
      }
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const size = SIZE_MAP[aspectRatio] || '1024x1024';
    const allRefs = { ...modelRefImages, ...refImages };
    const hasRefs = Object.values(allRefs).some(Boolean);

    let result;
    if (hasRefs) {
      // Edit mode - gpt-image-1 supports multiple input images
      const imageFiles = [];
      for (const [slot, dataUrl] of Object.entries(allRefs)) {
        if (!dataUrl) continue;
        const parsed = parseDataUrl(dataUrl);
        if (parsed) {
          const buffer = Buffer.from(parsed.data, 'base64');
          imageFiles.push(await toFile(buffer, `${slot}.png`, { type: parsed.mimeType }));
        }
      }
      result = await client.images.edit({
        model: MODEL_ID,
        image: imageFiles.length === 1 ? imageFiles[0] : imageFiles,
        prompt: fullPrompt, size, n: 1,
      });
    } else {
      result = await client.images.generate({ model: MODEL_ID, prompt: fullPrompt, size, n: 1 });
    }

    const b64 = result.data?.[0]?.b64_json;
    if (!b64) {
      await refundCredits(user, cost);
      return errorResponse(res, 502, 'no_image', 'OpenAI returned no image');
    }

    let imageUrl;
    try {
      imageUrl = await uploadGeneratedImage(
        user.userId, b64, 'image/png',
        { bucket: 'generated-images', subfolder: 'generate' }
      );
    } catch (uploadErr) {
      console.warn('[openai] storage upload failed, falling back to data URL:', uploadErr.message);
      imageUrl = `data:image/png;base64,${b64}`;
    }

    return res.status(200).json({
      model: 'openai',
      imageUrl,
      cost,
      meta: { modelId: MODEL_ID, size },
    });

  } catch (err) {
    console.error('[openai]', err);
    await refundCredits(user, cost);
    return errorResponse(res, 500, 'generation_failed', 'OpenAI generation failed', err.message);
  }
}
