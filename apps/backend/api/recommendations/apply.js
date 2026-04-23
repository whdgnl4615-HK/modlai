// POST /api/recommendations/apply
// Apply an AI-generated recommendation to the underlying product.
//
// Body:
//   {
//     diagnosisId: uuid,
//     recommendationIndex: number,  // index into diagnosis.recommendations[]
//     action: 'preview' | 'apply',  // preview=dry-run (generate variants), apply=commit
//     customValue?: any,            // user's override (e.g. chosen title among 3 variants)
//   }
//
// For 'preview' (preview generation, no DB writes):
//   - rewrite_title/description → calls Claude for 3 variants
//   - update_tags → returns { current, suggested, diff }
//   - adjust_price → returns { current, suggested, impact_estimate }
//   - regenerate_image → returns the suggested prompt for the Generate view
//
// For 'apply':
//   1. Reads the original product/master state
//   2. Computes the new state (using customValue or suggestion)
//   3. Pushes to channel (if product was already published)
//   4. Updates local DB
//   5. Records a recommendation_applications row

import {
  handleCors, errorResponse, requireAuth, requireOrg,
  readJson, getSupabaseAdmin, requireEnv,
} from '../_lib/utils.js';
import { getChannelByKey } from '../_lib/channels/index.js';

// Valid action types
const ACTIONS = [
  'regenerate_image',
  'rewrite_title',
  'rewrite_description',
  'update_tags',
  'adjust_price',
];

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return errorResponse(res, 405, 'method_not_allowed');

  let user;
  try { user = await requireAuth(req); }
  catch (err) { return errorResponse(res, err.status || 401, 'unauthorized', err.message); }

  let orgId;
  try { orgId = requireOrg(user); }
  catch (err) { return errorResponse(res, err.status, err.code || 'no_org', err.message); }

  const body = await readJson(req);
  const { diagnosisId, recommendationIndex, action = 'preview', customValue } = body;

  if (!diagnosisId || typeof recommendationIndex !== 'number') {
    return errorResponse(res, 400, 'missing_fields',
      'diagnosisId and recommendationIndex are required');
  }

  const db = await getSupabaseAdmin();
  if (!db) {
    // Demo mode: echo back
    return res.status(200).json({
      ok: true,
      action,
      message: 'Demo mode — no database. Would apply recommendation.',
    });
  }

  // Load the diagnosis
  const { data: diagnosis, error: dErr } = await db
    .from('ai_diagnoses')
    .select('*')
    .eq('id', diagnosisId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (dErr || !diagnosis) return errorResponse(res, 404, 'diagnosis_not_found');

  const rec = (diagnosis.recommendations || [])[recommendationIndex];
  if (!rec) return errorResponse(res, 400, 'rec_not_found',
    `Recommendation at index ${recommendationIndex} does not exist`);

  const actionType = rec.action_type || rec.type;
  if (!ACTIONS.includes(actionType)) {
    return errorResponse(res, 400, 'unsupported_action', `Unsupported action_type: ${actionType}`);
  }

  // Resolve target (master or external product)
  let master = null;
  let product = null;
  if (diagnosis.master_id) {
    const { data } = await db.from('product_masters')
      .select('*').eq('id', diagnosis.master_id).eq('org_id', orgId).maybeSingle();
    master = data;
  }
  if (diagnosis.product_id) {
    const { data } = await db.from('external_products')
      .select('*').eq('id', diagnosis.product_id).eq('org_id', orgId).maybeSingle();
    product = data;
  }
  if (!master && !product) {
    return errorResponse(res, 404, 'target_not_found',
      'Diagnosis target product/master not found');
  }

  // ─── PREVIEW: generate alternatives, don't write anything ───
  if (action === 'preview') {
    const preview = await generatePreview({ actionType, rec, master, product });
    return res.status(200).json({ ok: true, action: 'preview', actionType, preview, rec });
  }

  // ─── APPLY ───
  if (action !== 'apply') return errorResponse(res, 400, 'invalid_action');

  const { before, after, pushResult } = await applyAction({
    db, orgId, actionType, rec, master, product, customValue,
  });

  // Record application
  const { data: appRow } = await db.from('recommendation_applications').insert({
    org_id: orgId,
    user_id: user.userId,
    applied_by_email: user.email,
    diagnosis_id: diagnosisId,
    recommendation_index: recommendationIndex,
    action_type: actionType,
    action_summary: rec.title || rec.reasoning || null,
    master_id: master ? master.id : null,
    product_id: product ? product.id : null,
    before_state: before,
    after_state: after,
    pushed_to_channel: pushResult.channel,
    push_status: pushResult.status,
    push_error: pushResult.error,
    external_id: pushResult.externalId,
  }).select('*').single();

  return res.status(200).json({
    ok: true,
    action: 'apply',
    actionType,
    applicationId: appRow?.id,
    pushResult,
    before,
    after,
  });
}

// ─────────────────────────────────────────────
// PREVIEW GENERATION
// ─────────────────────────────────────────────
async function generatePreview({ actionType, rec, master, product }) {
  const target = master || product;
  const title = master?.name || product?.title || '';
  const description = master?.description || product?.body_html || product?.description || '';

  if (actionType === 'regenerate_image') {
    // Suggested prompt is in rec.suggested_prompt or derived
    return {
      type: 'regenerate_image',
      suggestedPrompt: rec.suggested_prompt || buildImagePromptFromProduct(target),
      note: rec.reasoning || '',
    };
  }

  if (actionType === 'rewrite_title') {
    // Call Claude for 3 variants
    const variants = await claudeGenerateTitles({ currentTitle: title, reasoning: rec.reasoning, target });
    return { type: 'rewrite_title', current: title, variants };
  }

  if (actionType === 'rewrite_description') {
    const variants = await claudeGenerateDescriptions({ currentDesc: description, title, reasoning: rec.reasoning, target });
    return { type: 'rewrite_description', current: description, variants };
  }

  if (actionType === 'update_tags') {
    const currentTags = product?.tags || master?.tags || [];
    const suggestedTags = rec.suggested_tags || rec.tags || [];
    return {
      type: 'update_tags',
      current: Array.isArray(currentTags) ? currentTags : String(currentTags).split(',').map(t=>t.trim()).filter(Boolean),
      suggested: suggestedTags,
    };
  }

  if (actionType === 'adjust_price') {
    const currentCents = product?.price_cents || master?.retail_price_cents || 0;
    const suggestedCents = rec.suggested_price_cents
      || Math.round(currentCents * (rec.suggested_multiplier || 1));
    return {
      type: 'adjust_price',
      current_cents: currentCents,
      suggested_cents: suggestedCents,
      delta_pct: currentCents ? ((suggestedCents - currentCents) / currentCents * 100).toFixed(1) : 0,
      estimate: rec.estimated_impact || '',
    };
  }

  return { type: actionType, note: 'No preview available for this action type.' };
}

// ─────────────────────────────────────────────
// APPLY ACTION — do the actual write + channel push
// ─────────────────────────────────────────────
async function applyAction({ db, orgId, actionType, rec, master, product, customValue }) {
  const target = master || product;
  const before = { ...target };
  let after = { ...target };
  const pushResult = { status: 'skipped', channel: null, error: null, externalId: null };

  if (actionType === 'regenerate_image') {
    // Image regen happens in the Generate view. This endpoint just logs intent.
    pushResult.status = 'skipped';
    pushResult.error = 'Image regeneration happens in the Generate view; this just records intent.';
    return { before, after, pushResult };
  }

  if (actionType === 'rewrite_title') {
    const newTitle = customValue || rec.suggested_title;
    if (!newTitle) throw new Error('No new title provided');

    if (master) {
      const { data, error } = await db.from('product_masters')
        .update({ name: newTitle }).eq('id', master.id).eq('org_id', orgId)
        .select('*').single();
      if (error) throw new Error(error.message);
      after = data;
    } else if (product) {
      const { data, error } = await db.from('external_products')
        .update({ title: newTitle }).eq('id', product.id).eq('org_id', orgId)
        .select('*').single();
      if (error) throw new Error(error.message);
      after = data;
      // Push to channel
      await pushUpdateToChannel({ db, orgId, product: data, patch: { title: newTitle }, pushResult });
    }
  }

  if (actionType === 'rewrite_description') {
    const newDesc = customValue || rec.suggested_description;
    if (!newDesc) throw new Error('No new description provided');

    if (master) {
      const { data, error } = await db.from('product_masters')
        .update({ description: newDesc }).eq('id', master.id).eq('org_id', orgId)
        .select('*').single();
      if (error) throw new Error(error.message);
      after = data;
    } else if (product) {
      const { data, error } = await db.from('external_products')
        .update({ body_html: newDesc, description: newDesc }).eq('id', product.id).eq('org_id', orgId)
        .select('*').single();
      if (error) throw new Error(error.message);
      after = data;
      await pushUpdateToChannel({ db, orgId, product: data, patch: { body_html: newDesc }, pushResult });
    }
  }

  if (actionType === 'update_tags') {
    const newTags = customValue || rec.suggested_tags || [];
    if (product) {
      const { data, error } = await db.from('external_products')
        .update({ tags: newTags }).eq('id', product.id).eq('org_id', orgId)
        .select('*').single();
      if (error) throw new Error(error.message);
      after = data;
      await pushUpdateToChannel({ db, orgId, product: data, patch: { tags: newTags }, pushResult });
    }
  }

  if (actionType === 'adjust_price') {
    const newCents = customValue || rec.suggested_price_cents;
    if (!newCents) throw new Error('No new price provided');

    if (master) {
      const { data, error } = await db.from('product_masters')
        .update({ retail_price_cents: newCents }).eq('id', master.id).eq('org_id', orgId)
        .select('*').single();
      if (error) throw new Error(error.message);
      after = data;
    } else if (product) {
      const { data, error } = await db.from('external_products')
        .update({ price_cents: newCents }).eq('id', product.id).eq('org_id', orgId)
        .select('*').single();
      if (error) throw new Error(error.message);
      after = data;
      await pushUpdateToChannel({ db, orgId, product: data, patch: { price_cents: newCents }, pushResult });
    }
  }

  return { before, after, pushResult };
}

// Push an update back to the origin channel (Shopify/Faire).
// Never throws — errors are captured into pushResult.
async function pushUpdateToChannel({ db, orgId, product, patch, pushResult }) {
  try {
    if (!product.channel || !product.external_id) {
      pushResult.status = 'skipped';
      pushResult.error = 'Product has no channel/external_id — local update only';
      return;
    }

    pushResult.channel = product.channel;

    // Load the channel connection
    const { data: conn } = await db.from('channel_connections')
      .select('*').eq('org_id', orgId).eq('channel', product.channel)
      .eq('status', 'active').maybeSingle();

    if (!conn) {
      pushResult.status = 'failed';
      pushResult.error = `No active ${product.channel} connection`;
      return;
    }

    const adapter = getChannelByKey(product.channel);
    if (!adapter || !adapter.updateProduct) {
      pushResult.status = 'skipped';
      pushResult.error = `${product.channel} adapter does not support update yet`;
      return;
    }

    const result = await adapter.updateProduct({
      credentials: conn.credentials,
      externalId: product.external_id,
      patch,
    });

    pushResult.status = 'pushed';
    pushResult.externalId = result.externalId || product.external_id;
  } catch (err) {
    pushResult.status = 'failed';
    pushResult.error = err.message || String(err);
  }
}

// ─────────────────────────────────────────────
// CLAUDE HELPERS — generate text variants
// ─────────────────────────────────────────────
async function claudeGenerateTitles({ currentTitle, reasoning, target }) {
  try {
    const key = requireEnv('ANTHROPIC_API_KEY');
    const ctx = [
      target?.category ? `Category: ${target.category}` : null,
      target?.color ? `Color: ${target.color}` : null,
      target?.season ? `Season: ${target.season}` : null,
    ].filter(Boolean).join('\n');

    const prompt = `You are an e-commerce product listing expert for fashion brands.

Current title: "${currentTitle}"
${ctx ? 'Product context:\n' + ctx + '\n' : ''}
Why this title should change:
${reasoning}

Generate exactly 3 alternative product titles. Each should:
- Be SEO-optimized with searchable keywords
- Stay under 70 characters
- Clearly identify the product type
- Feel on-brand for a premium fashion label

Return ONLY a JSON array of 3 strings, nothing else.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();
    const text = data?.content?.[0]?.text || '';
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [currentTitle];
    return JSON.parse(match[0]);
  } catch (err) {
    console.error('[claude titles]', err);
    return [currentTitle];
  }
}

async function claudeGenerateDescriptions({ currentDesc, title, reasoning, target }) {
  try {
    const key = requireEnv('ANTHROPIC_API_KEY');
    const ctx = [
      `Title: ${title}`,
      target?.category ? `Category: ${target.category}` : null,
      target?.fabric_content ? `Fabric: ${target.fabric_content}` : null,
      target?.color ? `Color: ${target.color}` : null,
    ].filter(Boolean).join('\n');

    const prompt = `You are an e-commerce copywriter for a premium fashion brand.

${ctx}

Current description:
"${currentDesc || '(empty)'}"

Why this description should change:
${reasoning}

Generate exactly 3 alternative product descriptions. Each should:
- Be 80-150 words
- Open with a strong hook, not product specs
- Weave fit/material/styling naturally
- End with a subtle call-to-action or styling suggestion
- Feel premium but accessible

Return ONLY a JSON array of 3 strings, nothing else.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();
    const text = data?.content?.[0]?.text || '';
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [currentDesc];
    return JSON.parse(match[0]);
  } catch (err) {
    console.error('[claude descs]', err);
    return [currentDesc];
  }
}

function buildImagePromptFromProduct(p) {
  const parts = [];
  if (p.name || p.title) parts.push(p.name || p.title);
  if (p.category) parts.push(p.category);
  if (p.color) parts.push(p.color);
  parts.push('editorial fashion photography, clean background, natural lighting');
  return parts.join(' · ');
}
