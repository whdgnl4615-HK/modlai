// Shopify channel adapter.
// Uses Shopify Admin REST API (products endpoint).
// Docs: https://shopify.dev/docs/api/admin-rest/latest/resources/product
//
// Connection.meta expected shape:
//   { shop_id?, myshopify_domain }   — myshopify_domain like 'mystore.myshopify.com'
//
// Credentials: access_token is a Shopify Admin API access token (OAuth or private app).

import { PublishChannel } from './publish-channel.js';

const API_VERSION = '2024-10';

export class ShopifyChannel extends PublishChannel {
  get key()  { return 'shopify'; }
  get name() { return 'Shopify'; }

  #apiBase(connection) {
    const domain = connection.store_url || connection.meta?.myshopify_domain;
    if (!domain) throw new Error('Shopify store URL not configured');
    return `https://${domain}/admin/api/${API_VERSION}`;
  }

  async #request(connection, method, path, body) {
    const res = await fetch(`${this.#apiBase(connection)}${path}`, {
      method,
      headers: {
        'X-Shopify-Access-Token': connection.access_token,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) {
      const err = new Error(`Shopify ${res.status}: ${data.errors ? JSON.stringify(data.errors) : text}`);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  async testConnection(connection) {
    try {
      const data = await this.#request(connection, 'GET', '/shop.json');
      return {
        ok: true,
        shopInfo: {
          name: data.shop?.name,
          domain: data.shop?.domain,
          email: data.shop?.email,
          currency: data.shop?.currency,
          country: data.shop?.country_name,
        },
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * Map CanonicalProduct → Shopify product payload.
   * This is the core mapping function.
   */
  #mapToPayload(product) {
    const warnings = [];
    const errors = [];

    if (!product.title)         errors.push('Title is required');
    if (!product.imageUrls?.length) errors.push('At least one image URL is required');
    if (!product.retailPriceCents) errors.push('Retail price is required');

    // Shopify wants prices as strings like "29.99"
    const priceStr = product.retailPriceCents
      ? (product.retailPriceCents / 100).toFixed(2)
      : '0.00';

    // Build HTML body from description + highlights + styling tips
    const bodyParts = [];
    if (product.description) bodyParts.push(`<p>${escapeHtml(product.description)}</p>`);
    if (product.highlights?.length) {
      bodyParts.push('<h3>Highlights</h3><ul>' +
        product.highlights.map(h => `<li>${escapeHtml(h)}</li>`).join('') + '</ul>');
    }
    if (product.stylingTips?.length) {
      const tips = Array.isArray(product.stylingTips) ? product.stylingTips.join(' ') : product.stylingTips;
      bodyParts.push(`<h3>Styling Tips</h3><p>${escapeHtml(tips)}</p>`);
    }
    const body_html = bodyParts.join('\n') || `<p>${escapeHtml(product.title)}</p>`;

    // Variants: Shopify requires at least 1 variant. If none specified, create a default.
    let shopifyVariants;
    if (product.variants && product.variants.length) {
      shopifyVariants = product.variants.map(v => ({
        title: v.name,
        sku: v.sku || product.sku || undefined,
        price: v.priceCents ? (v.priceCents / 100).toFixed(2) : priceStr,
        inventory_quantity: v.qty ?? 0,
        inventory_management: 'shopify',
        inventory_policy: 'deny',
      }));
    } else {
      if (!product.sku) warnings.push('No SKU provided; Shopify will auto-generate');
      shopifyVariants = [{
        sku: product.sku || undefined,
        price: priceStr,
        inventory_quantity: product.inventoryQty ?? 0,
        inventory_management: 'shopify',
        inventory_policy: 'deny',
      }];
    }

    // Images
    const images = (product.imageUrls || []).map(src => ({ src }));
    // Warn on non-public URLs
    for (const src of (product.imageUrls || [])) {
      if (src.startsWith('data:')) {
        errors.push('Image is a data URL — Shopify needs public HTTPS URLs. Upload to Storage first.');
        break;
      }
    }

    const productType = product.categoryByChannel?.shopify?.product_type
      || product.categoryByChannel?.shopify
      || 'Apparel';

    const tags = (product.tags || []).join(', ');

    const payload = {
      product: {
        title: product.title,
        body_html,
        vendor: product.categoryByChannel?.shopify?.vendor || undefined,
        product_type: typeof productType === 'string' ? productType : 'Apparel',
        tags,
        status: 'draft', // always publish as draft - user reviews on Shopify admin before going live
        variants: shopifyVariants,
        images,
      },
    };

    // SEO fields via metafields (Shopify has a native SEO spot)
    if (product.seoTitle || product.seoDescription) {
      payload.product.metafields_global_title_tag = product.seoTitle;
      payload.product.metafields_global_description_tag = product.seoDescription;
    }

    return { payload, warnings, errors };
  }

  async preview(product, connection) {
    const { payload, warnings, errors } = this.#mapToPayload(product);

    const effective = {
      title: payload.product.title,
      status: payload.product.status,
      product_type: payload.product.product_type,
      price: payload.product.variants[0]?.price,
      sku: payload.product.variants[0]?.sku,
      variant_count: payload.product.variants.length,
      image_count: payload.product.images.length,
      tags: payload.product.tags,
      store: connection.store_url || 'not connected',
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

    const res = await this.#request(connection, 'POST', '/products.json', payload);
    const created = res.product;

    return {
      externalProductId: String(created.id),
      externalUrl: `https://${connection.store_url}/admin/products/${created.id}`,
      rawResponse: res,
    };
  }

  async unpublish(externalId, connection) {
    // Shopify: DELETE = permanent delete. Safer: set status='archived'
    await this.#request(connection, 'PUT', `/products/${externalId}.json`, {
      product: { id: externalId, status: 'archived' },
    });
    return { ok: true };
  }

  // Partial update — push title/description/tags/price changes back to Shopify.
  // Called by /api/recommendations/apply when the user approves a suggestion.
  async updateProduct({ credentials, externalId, patch }) {
    const connection = credentials;
    const body = { product: { id: externalId } };

    if (patch.title) body.product.title = patch.title;
    if (patch.body_html || patch.description) body.product.body_html = patch.body_html || patch.description;
    if (patch.tags) {
      body.product.tags = Array.isArray(patch.tags) ? patch.tags.join(', ') : patch.tags;
    }
    if (patch.price_cents) {
      // Shopify price is on the variant, not the product. We need to fetch first.
      const existing = await this.#request(connection, 'GET', `/products/${externalId}.json`);
      const variants = existing?.product?.variants || [];
      if (variants.length) {
        // Apply to all variants
        body.product.variants = variants.map(v => ({
          id: v.id,
          price: (patch.price_cents / 100).toFixed(2),
        }));
      }
    }

    const res = await this.#request(connection, 'PUT', `/products/${externalId}.json`, body);
    return {
      externalId: String(res.product?.id || externalId),
      externalUrl: `https://${connection.store_url}/admin/products/${res.product?.id}`,
    };
  }
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
