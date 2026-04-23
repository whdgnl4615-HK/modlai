// POST /api/refine-prompt
// Uses Claude to expand a short idea into a rich AI-model-friendly prompt

import Anthropic from '@anthropic-ai/sdk';
import {
  handleCors, errorResponse, requireAuth, readJson, envMiddleware,
} from './_lib/utils.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return errorResponse(res, 405, 'method_not_allowed', 'POST only');
  if (!envMiddleware(res, ['ANTHROPIC_API_KEY'])) return;

  try { await requireAuth(req); }
  catch (err) { return errorResponse(res, err.status || 401, 'unauthorized', err.message); }

  try {
    const { prompt, feedbackContext = '' } = await readJson(req);
    if (!prompt) return errorResponse(res, 400, 'missing_prompt', 'prompt required');

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const systemPrompt = `You are a fashion image prompt engineer. Expand the user's short idea into a rich, specific prompt that produces great results on top AI image models (Gemini, GPT Image, Stable Diffusion).
- Include lighting, camera angle, lens, film look, pose, background, and mood
- Use professional fashion editorial terminology
- Write in English (AI models perform better with English prompts)
- One paragraph, maximum 80 words
- Do NOT contradict explicit garment details that appear in uploaded reference images${feedbackContext ? '\n\n[Past user feedback to learn from]\n' + feedbackContext : ''}`;

    const msg = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 500,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Refine this prompt: "${prompt}"` }],
    });

    const refined = msg.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    return res.status(200).json({ refinedPrompt: refined, original: prompt });

  } catch (err) {
    console.error('[refine]', err);
    return errorResponse(res, 500, 'refine_failed', 'Prompt refinement failed', err.message);
  }
}
