// POST /api/edit
// Edit an image via Nano Banana (preserves original detail)

import { GoogleGenerativeAI } from '@google/generative-ai';
import {
  handleCors, errorResponse, requireAuth, readJson,
  deductCredits, refundCredits, parseDataUrl, uploadGeneratedImage, EDIT_COST,
  envMiddleware, requireOrg} from './_lib/utils.js';

const MODEL_ID = 'gemini-2.5-flash-image';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return errorResponse(res, 405, 'method_not_allowed', 'POST only');
  if (!envMiddleware(res, ['GOOGLE_API_KEY'])) return;

  let user;
  try { user = await requireAuth(req); }
  catch (err) { return errorResponse(res, err.status || 401, 'unauthorized', err.message); }

  let orgId;
  try { orgId = requireOrg(user); }
  catch (err) { return errorResponse(res, err.status || 403, err.code || 'no_org', err.message); }

  const cost = EDIT_COST;
  const deducted = await deductCredits(user, cost, 'edit');
  if (!deducted) return errorResponse(res, 402, 'insufficient_credits', 'Not enough credits');

  try {
    const { imageUrl, editPrompt } = await readJson(req);
    if (!imageUrl)   { await refundCredits(user, cost); return errorResponse(res, 400, 'missing_image', 'imageUrl required'); }
    if (!editPrompt) { await refundCredits(user, cost); return errorResponse(res, 400, 'missing_prompt', 'editPrompt required'); }

    const parsed = parseDataUrl(imageUrl);
    if (!parsed) { await refundCredits(user, cost); return errorResponse(res, 400, 'bad_image', 'imageUrl must be data URL'); }

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

    return res.status(200).json({ imageUrl: publicUrl, cost });

  } catch (err) {
    console.error('[edit]', err);
    await refundCredits(user, cost);
    return errorResponse(res, 500, 'edit_failed', 'Edit failed', err.message);
  }
}
