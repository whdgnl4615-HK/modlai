// Faire data source — stub for Phase 4 (B2B buyer analysis).
//
// Status: structure matches interface, but fetchers are stubbed out because:
//   1. Faire's read API requires brand approval + specific docs (private)
//   2. Buyer PII access is restricted
//   3. Full implementation belongs in Phase 4
//
// The methods WILL be implemented, but they'll return empty for now so the
// rest of the system (insights UI, sync jobs) works cleanly.

import { PlatformDataSource, hashEmail, safeDisplayName } from './platform-datasource.js';

// TODO:DOC-CONFIRM once Faire docs arrive
const API_BASE = process.env.FAIRE_API_BASE || 'https://www.faire.com/external-api/v2';

export class FaireDataSource extends PlatformDataSource {
  get key() { return 'faire'; }

  async #request(connection, path, opts = {}) {
    const res = await fetch(`${API_BASE}${path}`, {
      method: opts.method || 'GET',
      headers: {
        'X-FAIRE-ACCESS-TOKEN': connection.access_token,
        'Accept': 'application/json',
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Faire ${res.status}: ${text}`);
    }
    return res.json();
  }

  // ═══════════════════════════════════════════════════
  // PRODUCTS — attempt to read from Faire
  // Structure based on public knowledge of Faire's product model
  // ═══════════════════════════════════════════════════
  async fetchProducts(connection, opts = {}) {
    // TODO:DOC-CONFIRM — path and pagination
    const brandId = connection.meta?.brand_id;
    const path = brandId ? `/brands/${brandId}/products` : '/products';
    const params = new URLSearchParams();
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.cursor) params.set('page_token', opts.cursor);

    try {
      const data = await this.#request(connection, `${path}?${params}`);
      const products = data.products || data.items || [];
      const items = products.map(p => this.#normalizeProduct(p, connection));
      return {
        items,
        cursor: data.next_page_token || data.cursor || null,
        hasMore: !!(data.next_page_token || data.cursor),
      };
    } catch (err) {
      // Graceful: if Faire API isn't available yet, return empty
      console.warn('[faire:fetchProducts] failed (expected if API not approved):', err.message);
      return { items: [], hasMore: false };
    }
  }

  #normalizeProduct(p, connection) {
    const firstVariant = p.variants?.[0] || {};
    const images = (p.images || []).map(img => img.url || img.src).filter(Boolean);
    return {
      externalId: String(p.id),
      title: p.name || p.title || '',
      description: p.description || '',
      vendor: connection.meta?.brand_name || '',
      productType: p.taxonomy_type || '',
      tags: [],
      priceCents: firstVariant.retail_price?.amount_minor || null,
      wholesalePriceCents: firstVariant.wholesale_price?.amount_minor || null,
      currency: (firstVariant.retail_price?.currency || 'usd').toLowerCase(),
      inventoryQty: (p.variants || []).reduce((s, v) => s + (v.available_quantity ?? 0), 0),
      primaryImageUrl: images[0] || null,
      imageUrls: images,
      variants: (p.variants || []).map(v => ({
        externalId: String(v.id),
        sku: v.sku,
        priceCents: v.retail_price?.amount_minor || null,
        wholesalePriceCents: v.wholesale_price?.amount_minor || null,
        inventoryQty: v.available_quantity ?? 0,
      })),
      status: p.is_published ? 'active' : 'draft',
      externalUrl: `https://www.faire.com/dashboard/products/${p.id}`,
      rawPayload: p,
    };
  }

  // ═══════════════════════════════════════════════════
  // ORDERS — stub for Phase 4
  // ═══════════════════════════════════════════════════
  async fetchOrders(_connection, _opts = {}) {
    // TODO:Phase-4 — implement using Faire orders API
    return { items: [], hasMore: false };
  }

  // ═══════════════════════════════════════════════════
  // CUSTOMERS — Faire "retailers"
  // ═══════════════════════════════════════════════════
  async fetchCustomers(_connection, _opts = {}) {
    // TODO:Phase-4 — aggregated from orders (Faire doesn't expose raw buyer list)
    return { items: [], hasMore: false };
  }
}
