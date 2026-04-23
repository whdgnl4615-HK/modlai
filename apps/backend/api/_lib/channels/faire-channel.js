// Faire (getfaire.com / faire.com) channel adapter.
//
// ⚠️  Faire's API requires brand approval before you can get an access token.
//     Request access: email integrations.support@faire.com
//     Once approved, you get:
//       - access token (opaque string)
//       - brand ID
//       - API docs (private)
//
// This adapter is built from publicly documented behavior:
//   - REST API
//   - Access token in 'X-FAIRE-ACCESS-TOKEN' header
//   - Products have 1+ variants (each with SKU + wholesale price)
//   - Max unit price: $1000
//   - Taxonomy type is required and IMMUTABLE after creation
//   - Images must be publicly accessible HTTPS
//   - Products can be pushed as 'UNPUBLISHED' or 'PUBLISHED'
//
// Fields marked TODO:DOC-CONFIRM should be verified against the official docs
// you receive after approval. Most likely these are minor: exact field names,
// error response shape, pagination format.

import { PublishChannel } from './publish-channel.js';

// TODO:DOC-CONFIRM — exact API base (docs mention both /v2 and /api/v2)
const API_BASE = process.env.FAIRE_API_BASE || 'https://www.faire.com/external-api/v2';
const MAX_UNIT_PRICE_CENTS = 100000; // $1000 hard limit on Faire

// Faire Taxonomy — top-level categories.
// Users must pick one; it's IMMUTABLE after product creation.
// TODO:DOC-CONFIRM — exact taxonomy key format. Below are commonly referenced ones.
export const FAIRE_TAXONOMY = {
  APPAREL_WOMEN:  'apparel-women',
  APPAREL_MEN:    'apparel-men',
  APPAREL_KIDS:   'apparel-kids',
  ACCESSORIES:    'accessories',
  JEWELRY:        'jewelry',
  BAGS_WALLETS:   'bags-wallets',
  SHOES:          'shoes',
  HOME:           'home',
  BEAUTY:         'beauty',
};

export class FaireChannel extends PublishChannel {
  get key()  { return 'faire'; }
  get name() { return 'Faire'; }

  async #request(connection, method, path, body) {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        // TODO:DOC-CONFIRM — exact header name
        'X-FAIRE-ACCESS-TOKEN': connection.access_token,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) {
      const err = new Error(`Faire ${res.status}: ${data.message || data.error || text}`);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  async testConnection(connection) {
    try {
      // TODO:DOC-CONFIRM — exact endpoint to verify token. Educated guess: /brand or /brands/me
      const data = await this.#request(connection, 'GET', '/brand');
      return {
        ok: true,
        shopInfo: {
          name: data.name || data.brand_name,
          brandId: data.id || data.brand_id,
          email: data.email,
        },
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  #mapToPayload(product) {
    const warnings = [];
    const errors = [];

    if (!product.title)         errors.push('Title is required');
    if (!product.imageUrls?.length) errors.push('At least one image URL is required');
    if (!product.wholesalePriceCents) errors.push('Wholesale price is required for Faire');
    if (!product.retailPriceCents)    errors.push('Retail price (MSRP) is required');

    // Price ceiling check
    if (product.retailPriceCents > MAX_UNIT_PRICE_CENTS) {
      errors.push(`Faire does not support items over $${MAX_UNIT_PRICE_CENTS/100}. Current: $${product.retailPriceCents/100}`);
    }

    // Taxonomy is required and immutable
    const taxonomy = product.categoryByChannel?.faire?.taxonomy
      || product.categoryByChannel?.faire;
    if (!taxonomy || typeof taxonomy !== 'string') {
      errors.push('Faire taxonomy_type is required (e.g. "apparel-women") and cannot be changed later');
    }

    // Faire requires ≥1 variant with SKU + wholesale price
    let faireVariants;
    if (product.variants && product.variants.length) {
      faireVariants = product.variants.map(v => ({
        sku: v.sku || product.sku,
        // TODO:DOC-CONFIRM — field name: "wholesale_price" vs "wholesale_price_cents"
        wholesale_price: {
          amount_minor: v.wholesalePriceCents || product.wholesalePriceCents,
          currency: (product.currency || 'usd').toUpperCase(),
        },
        retail_price: {
          amount_minor: v.priceCents || product.retailPriceCents,
          currency: (product.currency || 'usd').toUpperCase(),
        },
        available_quantity: v.qty ?? 0,
        options: v.options || {}, // e.g. { size: 'S', color: 'Black' }
      }));
      if (!faireVariants.every(v => v.sku)) {
        errors.push('Every variant must have a SKU');
      }
    } else {
      if (!product.sku) errors.push('SKU is required (or provide variants, each with their own SKU)');
      faireVariants = [{
        sku: product.sku,
        wholesale_price: {
          amount_minor: product.wholesalePriceCents,
          currency: (product.currency || 'usd').toUpperCase(),
        },
        retail_price: {
          amount_minor: product.retailPriceCents,
          currency: (product.currency || 'usd').toUpperCase(),
        },
        available_quantity: product.inventoryQty ?? 0,
        options: {},
      }];
    }

    // Images: public URLs only
    const images = [];
    for (const src of (product.imageUrls || [])) {
      if (src.startsWith('data:')) {
        errors.push('Image is a data URL — Faire requires public HTTPS URLs.');
      } else if (src.startsWith('http')) {
        images.push({ url: src });
      }
    }
    if (images.length < 1) warnings.push('Faire recommends 3+ images per listing (front, back, detail)');

    // Description: plain text usually. Combine highlights into it.
    const descParts = [product.description || ''];
    if (product.highlights?.length) {
      descParts.push('\n\nHighlights:\n' + product.highlights.map(h => `• ${h}`).join('\n'));
    }
    if (product.stylingTips) {
      const tips = Array.isArray(product.stylingTips) ? product.stylingTips.join(' ') : product.stylingTips;
      descParts.push('\n\nStyling: ' + tips);
    }
    const description = descParts.filter(Boolean).join('').trim();

    // TODO:DOC-CONFIRM — top-level product object shape
    const payload = {
      name: product.title,
      description,
      taxonomy_type: typeof taxonomy === 'string' ? taxonomy : '',
      images,
      variants: faireVariants,
      // Ship from country (affects VAT/duties)
      country_of_origin: product.countryOfOrigin || undefined,
      // Weight for shipping calculations
      weight: product.weightGrams ? {
        amount: product.weightGrams,
        unit: 'GRAM',
      } : undefined,
      // HS code for international shipping
      hs_code: product.hsCode || undefined,
      // Initial state
      is_published: false, // always draft first
    };

    return { payload, warnings, errors };
  }

  async preview(product, connection) {
    const { payload, warnings, errors } = this.#mapToPayload(product);

    const effective = {
      name: payload.name,
      taxonomy: payload.taxonomy_type || '(required!)',
      wholesale_price: payload.variants[0] ?
        `$${(payload.variants[0].wholesale_price?.amount_minor || 0) / 100}` : '(required!)',
      retail_price: payload.variants[0] ?
        `$${(payload.variants[0].retail_price?.amount_minor || 0) / 100}` : '(required!)',
      margin: payload.variants[0] && payload.variants[0].retail_price?.amount_minor
        ? Math.round((1 - payload.variants[0].wholesale_price.amount_minor / payload.variants[0].retail_price.amount_minor) * 100) + '%'
        : '—',
      variant_count: payload.variants.length,
      image_count: payload.images.length,
      published: payload.is_published ? 'Published' : 'Draft',
    };

    return { payload, warnings, errors, effective };
  }

  async publish(product, connection) {
    const { payload, errors } = this.#mapToPayload(product);
    if (errors.length) {
      const err = new Error('Validation failed: ' + errors.join('; '));
      err.code = 'validation_failed';
      throw err;
    }

    // TODO:DOC-CONFIRM — endpoint: POST /products vs /brands/{id}/products
    const brandId = connection.meta?.brand_id;
    const path = brandId ? `/brands/${brandId}/products` : '/products';
    const res = await this.#request(connection, 'POST', path, payload);

    // TODO:DOC-CONFIRM — response shape
    const created = res.product || res;
    const externalId = created.id || created.product_id;

    return {
      externalProductId: String(externalId),
      externalUrl: `https://www.faire.com/dashboard/products/${externalId}`,
      rawResponse: res,
    };
  }

  async unpublish(externalId, connection) {
    // TODO:DOC-CONFIRM — endpoint for unpublish vs delete
    await this.#request(connection, 'PATCH', `/products/${externalId}`, {
      is_published: false,
    });
    return { ok: true };
  }
}
