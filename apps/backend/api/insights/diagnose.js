// POST /api/insights/diagnose
// body: { productId }
//
// Claude analyzes a single external_product:
//   - title, description, tags
//   - primary image (via vision)
//   - sales metrics (views, orders, conversion)
//   - price position
//
// Returns structured diagnosis + recommendations.

import Anthropic from '@anthropic-ai/sdk';
import {
  handleCors, errorResponse, requireAuth, readJson, getSupabaseAdmin,
  deductCredits, refundCredits, envMiddleware,
} from '../_lib/utils.js';

const COST = 20;  // credits per diagnosis

const SYSTEM_PROMPT = `You are a senior fashion e-commerce merchandiser and copywriter.
You analyze a single product and produce a structured diagnosis to help the brand owner improve performance.

Analyze these dimensions:
1. IMAGE QUALITY — Is the main image clean, well-lit, visually appealing? Does it communicate the product clearly? How does it perform at thumbnail size?
2. TITLE & COPY — Is the title keyword-rich and clear? Is the description specific and benefit-driven?
3. CATEGORIZATION & TAGS — Appropriate tags? Correct product type?
4. PRICING — Given what you can infer about positioning
5. SALES METRICS — If provided, interpret conversion rate, views-to-purchase gap, etc.

Output STRICT JSON only, no prose outside the JSON:
{
  "overall_score": 0-100,
  "issues": [
    { "area": "image|title|description|tags|price|metrics", "severity": "high|medium|low", "summary": "one sentence", "evidence": "what you observed" }
  ],
  "strengths": [ "short points" ],
  "recommendations": [
    {
      "action_type": "regenerate_image|rewrite_title|rewrite_description|update_tags|adjust_price|run_ab_test",
      "title": "short imperative",
      "reasoning": "why this will help",
      "estimated_impact": "e.g. '+10-20% CTR' or 'minor'",
      "suggested_prompt": "if action is image regeneration or copy rewrite, a starter prompt"
    }
  ]
}

Be specific. Reference actual details from the data. Avoid generic advice.`;

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return errorResponse(res, 405, 'method_not_allowed');
  if (!envMiddleware(res, ['ANTHROPIC_API_KEY'])) return;

  let user;
  try { user = await requireAuth(req); }
  catch (err) { return errorResponse(res, err.status || 401, 'unauthorized', err.message); }

  let orgId;
  try { orgId = requireOrg(user); }
  catch (err) { return errorResponse(res, err.status || 403, err.code || 'no_org', err.message); }

  const { productId, masterId } = await readJson(req);
  if (!productId && !masterId) return errorResponse(res, 400, 'missing_target', 'Provide productId or masterId');

  const db = await getSupabaseAdmin();
  if (!db) return errorResponse(res, 500, 'no_database');

  // Fetch target: either external_product or product_master
  let product, perf;
  if (productId) {
    const { data } = await db
      .from('external_products')
      .select('*')
      .eq('id', productId)
      .eq('org_id', orgId)
      .maybeSingle();
    product = data;
    if (!product) return errorResponse(res, 404, 'product_not_found');

    const { data: p } = await db
      .from('product_performance')
      .select('*')
      .eq('id', productId)
      .maybeSingle();
    perf = p;
  } else {
    // masterId provided → treat master as a pseudo-product for diagnosis
    const { data: master } = await db
      .from('product_masters')
      .select('*')
      .eq('id', masterId)
      .eq('org_id', orgId)
      .maybeSingle();
    if (!master) return errorResponse(res, 404, 'master_not_found');

    // Adapt master shape to look like external_product for the rest of the code
    product = {
      id: master.id,
      title: [master.style_number, master.name].filter(Boolean).join(' - '),
      description: master.description,
      vendor: master.vendor,
      product_type: master.category,
      tags: master.tags,
      price_cents: master.retail_price_cents,
      compare_at_price_cents: null,
      inventory_qty: 0,
      primary_image_url: master.primary_image_url,
      image_urls: [master.primary_image_url].filter(Boolean),
      variants: [],
      status: master.status,
    };
    perf = null; // no sales data for internal masters yet
  }

  // Deduct credits
  const deducted = await deductCredits(user, COST, 'ai_diagnosis', productId || masterId, 'product diagnosis');
  if (!deducted) return errorResponse(res, 402, 'insufficient_credits', `Need ${COST} credits`);

  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Build multimodal message
    const contentParts = [];

    // Image first (if we can fetch it)
    if (product.primary_image_url) {
      try {
        const imgRes = await fetch(product.primary_image_url);
        if (imgRes.ok) {
          const buf = Buffer.from(await imgRes.arrayBuffer());
          const mime = imgRes.headers.get('content-type') || 'image/jpeg';
          contentParts.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: mime,
              data: buf.toString('base64'),
            },
          });
          contentParts.push({
            type: 'text',
            text: '↑ This is the primary product image customers see on the platform thumbnail.',
          });
        }
      } catch (err) {
        console.warn('[diagnose] image fetch failed:', err.message);
      }
    }

    // Metrics summary
    const metricsSummary = perf ? {
      units_sold_30d: perf.units_30d || 0,
      revenue_cents_30d: perf.revenue_30d || 0,
      views_30d: perf.views_30d || 0,
      orders_30d: perf.orders_30d || 0,
      conv_rate_30d: perf.conv_rate_30d,
    } : { note: 'No sales data available' };

    // Product data as structured JSON
    contentParts.push({
      type: 'text',
      text: `Product data to analyze:

TITLE: ${product.title || '(none)'}
DESCRIPTION: ${(product.description || '(none)').slice(0, 2000)}
VENDOR: ${product.vendor || '(none)'}
PRODUCT_TYPE: ${product.product_type || '(none)'}
TAGS: ${(product.tags || []).join(', ') || '(none)'}
PRICE: ${product.price_cents ? '$' + (product.price_cents / 100).toFixed(2) : '(none)'}
COMPARE_AT_PRICE: ${product.compare_at_price_cents ? '$' + (product.compare_at_price_cents / 100).toFixed(2) : '(none)'}
INVENTORY: ${product.inventory_qty ?? 0} units
STATUS: ${product.status}
IMAGES: ${(product.image_urls || []).length} total
VARIANTS: ${(product.variants || []).length} variants

SALES METRICS (last 30 days):
${JSON.stringify(metricsSummary, null, 2)}

Output your diagnosis as STRICT JSON only.`,
    });

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 2500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: contentParts }],
    });

    // Extract JSON from response
    const text = msg.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    let diagnosis;
    try {
      // Strip ```json fences if present
      const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
      diagnosis = JSON.parse(cleaned);
    } catch (err) {
      await refundCredits(user, COST, 'refund', 'claude returned invalid JSON');
      return errorResponse(res, 502, 'parse_failed', 'AI returned non-JSON response');
    }

    // Save to ai_diagnoses
    const { data: saved } = await db.from('ai_diagnoses').insert({
      user_id: user.userId, org_id: orgId,
      product_id: productId || null,
      master_id: masterId || null,
      overall_score: diagnosis.overall_score || null,
      issues: diagnosis.issues || [],
      strengths: diagnosis.strengths || [],
      recommendations: diagnosis.recommendations || [],
      metrics_snapshot: metricsSummary,
      cost_credits: COST,
    }).select('*').single();

    return res.status(200).json({
      diagnosis: saved,
      product: {
        id: product.id,
        title: product.title,
        primary_image_url: product.primary_image_url,
      },
    });

  } catch (err) {
    console.error('[diagnose]', err);
    await refundCredits(user, COST, 'refund', 'exception');
    return errorResponse(res, 500, 'diagnosis_failed', err.message);
  }
}
