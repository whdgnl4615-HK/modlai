// Target schema for product_masters / product_master_variants.
// Plus AI-assisted column mapping via Claude.

import Anthropic from '@anthropic-ai/sdk';

/**
 * MODLai's canonical product master fields.
 * The mapping step converts user's source columns → these target fields.
 *
 * Each field entry: { key, label, type, required, description, aliases }
 *   - aliases is a list of common source column names for heuristic pre-match
 */
export const TARGET_FIELDS = [
  // ─── Core identity ───
  { key: 'style_number', label: 'Style Number', type: 'text', required: true,
    description: 'Unique code for this style, e.g. MC181T, SS24-001',
    aliases: ['style', 'style#', 'style_no', 'styleno', 'styleNumber', 'sku_style', 'item', 'itemno', 'subStyle'] },
  { key: 'color', label: 'Color', type: 'text', required: false,
    description: 'Color name, e.g. WHITE, BLACK, NAVY',
    aliases: ['color', 'colour', 'colorName', 'subColor', 'vendorColor1'] },
  { key: 'name', label: 'Product Name', type: 'text', required: false,
    description: 'Human-readable product name, e.g. CHARLIE VEST',
    aliases: ['name', 'productName', 'descript', 'description_short', 'title', 'itemName'] },
  { key: 'description', label: 'Description', type: 'text', required: false,
    description: 'Long product description',
    aliases: ['description', 'longDescription', 'memo', 'details'] },

  // ─── Categorization ───
  { key: 'category', label: 'Category', type: 'text', required: false,
    description: 'Top-level category, e.g. TOP, PANTS, DRESS',
    aliases: ['category', 'cat', 'productType', 'type'] },
  { key: 'subcategory', label: 'Subcategory', type: 'text', required: false,
    aliases: ['subCategory', 'subCat', 'subcategory'] },
  { key: 'division', label: 'Division', type: 'text', required: false,
    aliases: ['division', 'div'] },
  { key: 'subdivision', label: 'Subdivision', type: 'text', required: false,
    aliases: ['subdivision', 'subDiv'] },
  { key: 'season', label: 'Season', type: 'text', required: false,
    description: 'e.g. Summer 2025, F/W 24',
    aliases: ['season', 'seasonName'] },

  // ─── Variants (size-level) ───
  { key: 'size', label: 'Size', type: 'text', required: false,
    description: 'Variant size: S, M, L, XL, 28, 30, OneSize',
    aliases: ['size', 'sizeName', 'sizeCode', 'sizecat', 'sizeCat', 'sizeCategory'] },
  { key: 'sku', label: 'SKU', type: 'text', required: false,
    description: 'Full SKU including size/color (leave blank to auto-generate)',
    aliases: ['sku', 'variantSku', 'barcode', 'upc'] },
  { key: 'prepack', label: 'Prepack', type: 'text', required: false,
    description: 'Size ratio in a pack, e.g. "S:M:L 1:2:1" or bundle code',
    aliases: ['prepack', 'pack', 'packRatio', 'packChk', 'bundle'] },
  { key: 'inventory_qty', label: 'Inventory Qty', type: 'number', required: false,
    aliases: ['inventory', 'qty', 'quantity', 'stock', 'ohs', 'onHand'] },
  { key: 'pack_quantity', label: 'Pack Quantity', type: 'number', required: false,
    aliases: ['packQty', 'defQtyPerBox', 'qtyPerBox'] },
  { key: 'min_order_qty', label: 'Min Order Qty', type: 'number', required: false,
    aliases: ['minOrderQty', 'moq'] },

  // ─── Pricing ───
  { key: 'wholesale_price', label: 'Wholesale Price', type: 'price', required: false,
    description: 'Price you charge retailers (for Faire, etc.)',
    aliases: ['price1', 'wholesale', 'wholesalePrice', 'priceWS', 'priceDdp', 'priceFob'] },
  { key: 'retail_price', label: 'Retail Price', type: 'price', required: false,
    description: 'MSRP / what consumers pay',
    aliases: ['price', 'retail', 'retailPrice', 'msrp', 'price2', 'sgtRetailPrice', 'price3'] },
  { key: 'cost', label: 'Cost', type: 'price', required: false,
    aliases: ['cost', 'cost1', 'avgCost', 'stdCost', 'lstCost'] },
  { key: 'currency', label: 'Currency', type: 'text', required: false,
    aliases: ['currency', 'curr', 'currency1'] },

  // ─── Supply chain ───
  { key: 'available_date', label: 'Available Date', type: 'date', required: false,
    aliases: ['availabledate', 'availableDate', 'readyDate', 'eta'] },
  { key: 'start_sell_date', label: 'Start Sell Date', type: 'date', required: false,
    aliases: ['startSellDate', 'launchDate'] },
  { key: 'vendor', label: 'Vendor', type: 'text', required: false,
    aliases: ['vendor', 'vendor1', 'supplier'] },
  { key: 'country_of_origin', label: 'Country of Origin', type: 'text', required: false,
    aliases: ['coo', 'countryOfOrigin', 'madeIn'] },
  { key: 'hs_tariff_no', label: 'HS Tariff No', type: 'text', required: false,
    aliases: ['hsTariffNo', 'hsCode', 'hts'] },
  { key: 'fabric_content', label: 'Fabric Content', type: 'text', required: false,
    aliases: ['fabContent', 'fabricContent', 'material'] },
  { key: 'fabric_type', label: 'Fabric Type', type: 'text', required: false,
    aliases: ['fabricType', 'fabType'] },
  { key: 'weight_grams', label: 'Weight (g)', type: 'number', required: false,
    aliases: ['weight', 'weightG', 'weightGrams'] },
  { key: 'size_category', label: 'Size Category (adult/kids)', type: 'text', required: false,
    description: 'Broad category like ADULT, KIDS — different from individual size',
    aliases: ['sizeCategoryGroup'] },
];

export const TARGET_FIELD_KEYS = TARGET_FIELDS.map(f => f.key);

/**
 * Heuristic pre-mapping: normalize source column name and match against aliases.
 * Returns { mapping: {sourceCol: targetField}, confidence: {sourceCol: 0-1} }
 */
export function heuristicMap(sourceColumns) {
  const mapping = {};
  const confidence = {};

  const aliasLookup = {}; // normalized_alias → target_key
  for (const f of TARGET_FIELDS) {
    for (const a of (f.aliases || [])) {
      aliasLookup[normalizeColName(a)] = f.key;
    }
    aliasLookup[normalizeColName(f.key)] = f.key;
    aliasLookup[normalizeColName(f.label)] = f.key;
  }

  for (const col of sourceColumns) {
    const normalized = normalizeColName(col.name);
    if (!normalized) continue;

    // Exact match
    if (aliasLookup[normalized]) {
      mapping[col.name] = aliasLookup[normalized];
      confidence[col.name] = 1.0;
      continue;
    }

    // Contains match (less confident)
    for (const [alias, targetKey] of Object.entries(aliasLookup)) {
      if (alias.length >= 4 && (normalized.includes(alias) || alias.includes(normalized))) {
        mapping[col.name] = targetKey;
        confidence[col.name] = 0.7;
        break;
      }
    }
  }

  return { mapping, confidence };
}

function normalizeColName(s) {
  if (!s) return '';
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Call Claude to do a smarter mapping, using context from sample values.
 * Returns same { mapping, confidence, reasoning } shape.
 */
export async function aiMap(sourceColumns, { existingMapping = {} } = {}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    // No Claude key — just return heuristic result
    return { mapping: existingMapping, confidence: {}, reasoning: 'heuristic only' };
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Compact the source columns for the prompt (Claude can handle long but keep tidy)
  const sourceSummary = sourceColumns.slice(0, 80).map(c => ({
    name: c.name,
    samples: (c.sample_values || []).slice(0, 3),
    populated: c.populated_count,
  }));

  const targetSummary = TARGET_FIELDS.map(f => ({
    key: f.key, label: f.label, type: f.type,
    description: f.description || '',
    required: f.required || false,
  }));

  const systemPrompt = `You are a data mapper for a fashion e-commerce platform called MODLai.
You match columns from a user-uploaded product file to MODLai's internal schema.

Rules:
- Only map a source column if you're reasonably confident it matches a target field
- For fashion industry files: "price1" usually = wholesale, "price" or "msrp" = retail, "sgtRetailPrice" = retail
- Look at sample values when the column name is ambiguous (e.g., numbers with 2 decimals likely = price)
- A source column can only map to ONE target field
- Multiple source columns CAN'T map to the same target (pick the best)
- Some source columns won't match any target — leave those unmapped
- Pay attention to existing heuristic mapping (if provided) and agree with it unless you see a clear reason to disagree

Output STRICT JSON only, no prose outside:
{
  "mapping": { "source_col_name": "target_field_key", ... },
  "confidence": { "source_col_name": 0.0-1.0, ... },
  "reasoning": { "source_col_name": "one short sentence on why", ... }
}`;

  const userPrompt = `Target fields available:
${JSON.stringify(targetSummary, null, 2)}

Source columns from user's file:
${JSON.stringify(sourceSummary, null, 2)}

${Object.keys(existingMapping).length ? `Heuristic pre-mapping (review and improve):
${JSON.stringify(existingMapping, null, 2)}` : ''}

Map the source columns to target fields. Output JSON only.`;

  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 3000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
    const parsed = JSON.parse(cleaned);

    // Sanity check: every target must be a valid key
    const validKeys = new Set(TARGET_FIELD_KEYS);
    const filtered = {};
    for (const [src, tgt] of Object.entries(parsed.mapping || {})) {
      if (validKeys.has(tgt)) filtered[src] = tgt;
    }

    return {
      mapping: filtered,
      confidence: parsed.confidence || {},
      reasoning: parsed.reasoning || {},
    };
  } catch (err) {
    console.warn('[aiMap] Claude call failed:', err.message);
    return { mapping: existingMapping, confidence: {}, reasoning: 'claude_failed: ' + err.message };
  }
}
