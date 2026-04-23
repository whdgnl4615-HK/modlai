// buildCanonicalProduct - assembles the CanonicalProduct shape from DB rows.
// Used by /api/publish/preview and /api/publish/execute.

import { getSupabaseAdmin } from '../utils.js';

export async function buildCanonicalProduct({ userId, generationId }) {
  const admin = await getSupabaseAdmin();
  if (!admin) {
    // Demo mode fallback
    return {
      title: 'Demo Minimalist Tee',
      description: 'A clean essential tee — the backbone of any capsule wardrobe.',
      tagline: 'Everyday elevated.',
      highlights: ['100% organic cotton', 'Relaxed fit', 'Pre-shrunk'],
      stylingTips: 'Tuck into high-waist denim or layer under an oversized blazer.',
      tags: ['minimalist', 'essential', 'cotton'],
      seoTitle: 'Minimalist Organic Cotton Tee',
      seoDescription: 'Clean-cut essential tee in organic cotton. Relaxed fit, versatile styling.',
      imageUrls: ['https://picsum.photos/seed/demo/800/1000'],
      primaryImageUrl: 'https://picsum.photos/seed/demo/800/1000',
      sku: 'DEMO-TEE-001',
      retailPriceCents: 4500,
      wholesalePriceCents: 2250,
      currency: 'usd',
      inventoryQty: 50,
      variants: [],
      categoryByChannel: { shopify: { product_type: 'Tops' }, faire: { taxonomy: 'apparel-women' } },
      weightGrams: 180,
    };
  }

  // Fetch generation + description + commerce meta in parallel
  const [genR, descR, metaR, resultsR] = await Promise.all([
    admin.from('generations').select('*').eq('id', generationId).eq('user_id', userId).single(),
    admin.from('descriptions').select('*').eq('generation_id', generationId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    admin.from('generation_commerce_meta').select('*').eq('generation_id', generationId).maybeSingle(),
    admin.from('generation_results').select('*').eq('generation_id', generationId).order('created_at'),
  ]);

  if (genR.error || !genR.data) throw new Error('Generation not found');

  const gen = genR.data;
  const desc = descR.data?.content || {};
  const meta = metaR.data || {};
  const results = resultsR.data || [];

  // Pick image URLs: prefer explicitly set in commerce_meta, else fall back to
  // the best-rated result, else any result with an image.
  let imageUrls = meta.image_urls || [];
  if (!imageUrls.length) {
    const best = results.find(r => r.is_best) || results.find(r => r.liked) || results[0];
    if (best?.image_url) imageUrls = [best.image_url];
    // Also include edits if any
    // (edits table not joined here — keep it simple)
  }
  const primaryImageUrl = imageUrls[0] || null;

  return {
    title:           desc.title || gen.user_prompt || 'Untitled Product',
    description:     desc.description || '',
    tagline:         desc.tagline || '',
    highlights:      Array.isArray(desc.highlights) ? desc.highlights : [],
    stylingTips:     desc.styling_tips || '',
    tags:            Array.isArray(desc.tags) ? desc.tags : [],
    seoTitle:        desc.seo_title || '',
    seoDescription:  desc.seo_description || '',
    imageUrls,
    primaryImageUrl,
    sku:                  meta.sku || '',
    retailPriceCents:     meta.retail_price_cents || 0,
    wholesalePriceCents:  meta.wholesale_price_cents || 0,
    currency:             meta.currency || 'usd',
    inventoryQty:         meta.inventory_qty || 0,
    variants:             Array.isArray(meta.variants) ? meta.variants : [],
    categoryByChannel:    meta.channel_categories || {},
    weightGrams:          meta.weight_grams || null,
    hsCode:               meta.hs_code || null,
    countryOfOrigin:      meta.country_of_origin || null,
  };
}
