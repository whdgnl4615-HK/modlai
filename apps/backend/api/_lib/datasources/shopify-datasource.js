// Shopify data source — reads products/orders/customers via Admin REST API.
// Docs:
//   Products: https://shopify.dev/docs/api/admin-rest/latest/resources/product
//   Orders:   https://shopify.dev/docs/api/admin-rest/latest/resources/order
//   Customers: https://shopify.dev/docs/api/admin-rest/latest/resources/customer
//
// Required scopes:
//   read_products, read_orders, read_customers
//   Optional: read_analytics (for native analytics fetchAnalytics)

import { PlatformDataSource, hashEmail, safeDisplayName } from './platform-datasource.js';

const API_VERSION = '2024-10';
const PAGE_SIZE = 250; // Shopify max

export class ShopifyDataSource extends PlatformDataSource {
  get key() { return 'shopify'; }

  #apiBase(connection) {
    const domain = connection.store_url || connection.meta?.myshopify_domain;
    if (!domain) throw new Error('Shopify store URL missing');
    return `https://${domain}/admin/api/${API_VERSION}`;
  }

  async #request(connection, path, opts = {}) {
    const url = `${this.#apiBase(connection)}${path}`;
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers: {
        'X-Shopify-Access-Token': connection.access_token,
        'Accept': 'application/json',
      },
    });

    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`Shopify ${res.status}: ${text}`);
      err.status = res.status;
      throw err;
    }

    const data = await res.json();
    // Shopify uses Link header for cursor-based pagination
    const linkHeader = res.headers.get('link') || '';
    const nextUrl = extractNextLink(linkHeader);
    const nextCursor = nextUrl ? new URL(nextUrl).searchParams.get('page_info') : null;

    return { data, nextCursor, hasMore: !!nextCursor };
  }

  // ═══════════════════════════════════════════════════
  // PRODUCTS
  // ═══════════════════════════════════════════════════
  async fetchProducts(connection, opts = {}) {
    const params = new URLSearchParams();
    params.set('limit', String(opts.limit || PAGE_SIZE));
    if (opts.cursor) {
      params.set('page_info', opts.cursor);
    } else if (opts.since) {
      params.set('updated_at_min', opts.since);
    }

    const { data, nextCursor, hasMore } = await this.#request(
      connection, `/products.json?${params}`
    );

    const items = (data.products || []).map(p => this.#normalizeProduct(p, connection));
    return { items, cursor: nextCursor, hasMore };
  }

  #normalizeProduct(p, connection) {
    const firstVariant = p.variants?.[0] || {};
    const images = (p.images || []).map(img => img.src).filter(Boolean);

    // Compute total inventory across variants
    const inventoryQty = (p.variants || []).reduce(
      (sum, v) => sum + (v.inventory_quantity ?? 0), 0
    );

    return {
      externalId: String(p.id),
      title: p.title || '',
      description: p.body_html || '',
      vendor: p.vendor || '',
      productType: p.product_type || '',
      tags: typeof p.tags === 'string' ? p.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
      priceCents: firstVariant.price ? Math.round(parseFloat(firstVariant.price) * 100) : null,
      compareAtPriceCents: firstVariant.compare_at_price ? Math.round(parseFloat(firstVariant.compare_at_price) * 100) : null,
      wholesalePriceCents: null, // Shopify doesn't have native wholesale
      currency: 'usd', // TODO: get from shop info
      inventoryQty,
      primaryImageUrl: images[0] || p.image?.src || null,
      imageUrls: images,
      variants: (p.variants || []).map(v => ({
        externalId: String(v.id),
        title: v.title,
        sku: v.sku,
        priceCents: v.price ? Math.round(parseFloat(v.price) * 100) : null,
        inventoryQty: v.inventory_quantity ?? 0,
        option1: v.option1, option2: v.option2, option3: v.option3,
      })),
      status: p.status, // 'active', 'archived', 'draft'
      publishedAt: p.published_at,
      externalUrl: `https://${connection.store_url}/admin/products/${p.id}`,
      rawPayload: p,
    };
  }

  // ═══════════════════════════════════════════════════
  // ORDERS
  // ═══════════════════════════════════════════════════
  async fetchOrders(connection, opts = {}) {
    const params = new URLSearchParams();
    params.set('limit', String(opts.limit || PAGE_SIZE));
    params.set('status', 'any');  // include closed/cancelled
    if (opts.cursor) {
      params.set('page_info', opts.cursor);
    } else if (opts.since) {
      params.set('updated_at_min', opts.since);
    }

    const { data, nextCursor, hasMore } = await this.#request(
      connection, `/orders.json?${params}`
    );

    const items = (data.orders || []).map(o => this.#normalizeOrder(o));
    return { items, cursor: nextCursor, hasMore };
  }

  #normalizeOrder(o) {
    return {
      externalId: String(o.id),
      externalOrderNumber: o.name, // e.g. "#1042"
      customerExternalId: o.customer?.id ? String(o.customer.id) : null,
      subtotalCents: o.subtotal_price ? Math.round(parseFloat(o.subtotal_price) * 100) : null,
      totalCents: o.total_price ? Math.round(parseFloat(o.total_price) * 100) : null,
      currency: (o.currency || 'usd').toLowerCase(),
      financialStatus: o.financial_status,
      fulfillmentStatus: o.fulfillment_status,
      placedAt: o.created_at,
      cancelledAt: o.cancelled_at,
      lineItems: (o.line_items || []).map(li => ({
        externalProductId: li.product_id ? String(li.product_id) : null,
        title: li.title,
        sku: li.sku,
        quantity: li.quantity || 1,
        priceCents: li.price ? Math.round(parseFloat(li.price) * 100) : null,
        totalCents: li.price ? Math.round(parseFloat(li.price) * 100 * li.quantity) : null,
      })),
      rawPayload: o,
    };
  }

  // ═══════════════════════════════════════════════════
  // CUSTOMERS
  // ═══════════════════════════════════════════════════
  async fetchCustomers(connection, opts = {}) {
    const params = new URLSearchParams();
    params.set('limit', String(opts.limit || PAGE_SIZE));
    if (opts.cursor) {
      params.set('page_info', opts.cursor);
    } else if (opts.since) {
      params.set('updated_at_min', opts.since);
    }

    const { data, nextCursor, hasMore } = await this.#request(
      connection, `/customers.json?${params}`
    );

    const items = (data.customers || []).map(c => this.#normalizeCustomer(c));
    return { items, cursor: nextCursor, hasMore };
  }

  #normalizeCustomer(c) {
    const fullName = [c.first_name, c.last_name].filter(Boolean).join(' ');
    return {
      externalId: String(c.id),
      emailHash: hashEmail(c.email),
      displayName: safeDisplayName(fullName, c.email),
      region: c.default_address?.country || c.default_address?.province_code || null,
      customerType: 'b2c',
      totalOrders: c.orders_count || 0,
      totalSpentCents: c.total_spent ? Math.round(parseFloat(c.total_spent) * 100) : 0,
      firstOrderAt: null, // derive from orders
      lastOrderAt: c.updated_at, // approximation
      tags: typeof c.tags === 'string' ? c.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
    };
  }

  async checkRateLimit(connection) {
    // Shopify returns X-Shopify-Shop-Api-Call-Limit header like "40/80"
    // We could preemptively back off; for now, trust the platform to 429 us
    return { ok: true };
  }
}

// Parse Shopify's Link header for the "next" page URL
function extractNextLink(linkHeader) {
  if (!linkHeader) return null;
  // Format: <https://...?page_info=abc>; rel="next", <...>; rel="previous"
  const parts = linkHeader.split(',');
  for (const p of parts) {
    const m = p.match(/<([^>]+)>;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}
