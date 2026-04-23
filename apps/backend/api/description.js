// POST /api/description
// Generates product description via Claude vision

import Anthropic from '@anthropic-ai/sdk';
import {
  handleCors, errorResponse, requireAuth, readJson,
  deductCredits, refundCredits, parseDataUrl, DESCRIPTION_COST,
  envMiddleware, requireOrg} from './_lib/utils.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return errorResponse(res, 405, 'method_not_allowed', 'POST only');
  if (!envMiddleware(res, ['ANTHROPIC_API_KEY'])) return;

  let user;
  try { user = await requireAuth(req); }
  catch (err) { return errorResponse(res, err.status || 401, 'unauthorized', err.message); }

  let orgId;
  try { orgId = requireOrg(user); }
  catch (err) { return errorResponse(res, err.status || 403, err.code || 'no_org', err.message); }

  const cost = DESCRIPTION_COST;
  const deducted = await deductCredits(user, cost, 'description');
  if (!deducted) return errorResponse(res, 402, 'insufficient_credits', 'Not enough credits');

  try {
    const {
      imageUrl, category, background,
      accessories = [], userPrompt = '',
      prevFeedback = '', language = 'ko',
    } = await readJson(req);

    if (!imageUrl) {
      await refundCredits(user, cost);
      return errorResponse(res, 400, 'missing_image', 'imageUrl required');
    }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const langInstruction = language === 'en'
      ? 'Write everything in English.'
      : '모든 내용을 한국어로 작성하세요.';

    const systemPrompt = `You are a fashion e-commerce copywriter. You look at a generated product image and write complete product copy for a brand website.

Respond with ONLY a raw JSON object (no markdown fences, no commentary) in this exact structure:
{
  "title": "Product name (max 8 words, evocative)",
  "tagline": "One-line hook (max 15 words)",
  "description": "Body copy 2-3 paragraphs covering fabric feel, silhouette, styling cues",
  "highlights": ["Key point 1", "Key point 2", "Key point 3", "Key point 4"],
  "styling_tips": "1-2 sentences on how to style",
  "tags": ["keyword1", "keyword2", "keyword3", "keyword4", "keyword5", "keyword6"],
  "seo_title": "Meta title (max 60 chars)",
  "seo_description": "Meta description (max 160 chars)"
}

${langInstruction}
Tone: trendy, sensory, professional — not hyped or over-salesy. Ready to drop straight into a real fashion e-commerce site.${prevFeedback ? '\n\n[Past feedback to apply]\n' + prevFeedback : ''}`;

    // Prepare image for Claude — always convert to base64 for reliability.
    // URL-based image input is slow and less stable than inline base64.
    const parsed = parseDataUrl(imageUrl);
    const userContent = [];

    let imagePayload = null;
    if (parsed) {
      imagePayload = { type: 'base64', media_type: parsed.mimeType, data: parsed.data };
    } else if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
      // Fetch the image ourselves and send as base64 (faster + more reliable than Claude fetching a URL)
      try {
        const imgResp = await fetch(imageUrl);
        if (!imgResp.ok) throw new Error('image fetch ' + imgResp.status);
        const ab = await imgResp.arrayBuffer();
        const b64 = Buffer.from(ab).toString('base64');
        const mimeType = imgResp.headers.get('content-type') || 'image/png';
        imagePayload = { type: 'base64', media_type: mimeType, data: b64 };
      } catch (fetchErr) {
        console.warn('[description] image fetch failed:', fetchErr.message);
        // Continue without image — Claude will describe based on category/scene text only
      }
    }

    if (imagePayload) {
      userContent.push({ type: 'image', source: imagePayload });
    }

    const contextText = [
      `Category: ${category || 'garment'}`,
      background ? `Scene: ${background}` : '',
      accessories.length ? `Styled with: ${accessories.join(', ')}` : '',
      userPrompt ? `User direction: ${userPrompt}` : '',
      '',
      'Write the product copy as JSON.',
    ].filter(Boolean).join('\n');

    userContent.push({ type: 'text', text: contextText });

    const msg = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1200,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    });

    const raw = msg.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const cleaned = raw.replace(/```json|```/g, '').trim();

    let result;
    try {
      result = JSON.parse(cleaned);
    } catch (parseErr) {
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) result = JSON.parse(match[0]);
      else throw new Error('Could not parse JSON response');
    }

    return res.status(200).json({ description: result, cost });

  } catch (err) {
    console.error('[description]', err);
    await refundCredits(user, cost);
    return errorResponse(res, 500, 'description_failed', 'Description generation failed', err.message);
  }
}
