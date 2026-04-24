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

CRITICAL OUTPUT FORMAT:
- Start DIRECTLY with the prompt content. No preamble, no title, no headers.
- DO NOT use markdown (#, ##, **, *, -, bullet lists).
- DO NOT write "Here's the prompt" or "Fashion Model Prompt" or any meta-commentary.
- Output must be plain prose — a single flowing paragraph.

Content requirements:
- Include lighting, camera angle, lens, film look, pose, background, and mood
- Use professional fashion editorial terminology (real film stocks, cameras, photographers)
- Preserve every specific detail the user provided (colors, numbers, ethnicity, age, etc.) — do NOT replace or omit them
- Write in English (AI models perform better with English prompts)
- One paragraph, maximum 80 words
- Do NOT contradict explicit garment details that appear in uploaded reference images${feedbackContext ? '\n\n[Past user feedback to learn from]\n' + feedbackContext : ''}`;

    const msg = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 500,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Refine this prompt, preserving all specific details (ethnicity, age, height, colors, etc.):\n\n"${prompt}"` }],
    });

    let refined = msg.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    // Defensive cleanup — strip markdown and preamble if Haiku slipped despite instructions
    refined = refined
      .replace(/^#{1,6}\s+[^\n]*\n+/g, '')                  // leading markdown headers
      .replace(/^\*{1,3}[^\n]+\*{1,3}\s*\n+/g, '')          // leading bold/italic
      .replace(/^(Here('s| is)\s+(a\s+)?(refined\s+|rich\s+)?(prompt|description)[:.])\s*/i, '')
      .replace(/^(Prompt|Description|Fashion Model Prompt)[:.]?\s*\n?/i, '')
      .trim();

    return res.status(200).json({ refinedPrompt: refined, original: prompt });

  } catch (err) {
    console.error('[refine]', err);
    return errorResponse(res, 500, 'refine_failed', 'Prompt refinement failed', err.message);
  }
}
