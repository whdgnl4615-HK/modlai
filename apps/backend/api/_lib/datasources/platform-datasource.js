// PlatformDataSource — abstract interface for READING data from e-commerce platforms.
// This is the counterpart to PublishChannel (which WRITES to platforms).
//
// Why split?  Publishing and reading have different concerns:
//   - Publish: mapping MODLai→platform, validation, single-product writes
//   - Read: pagination, incremental sync, rate limit handling, schema normalization
//
// A channel might support both (Shopify), only publish (FashionGo), or only read
// (future: analytics-only connectors). Split cleanly.
//
// Each DataSource returns platform-neutral shapes that map to our DB columns.

/**
 * @typedef {Object} NormalizedProduct
 * Matches external_products table roughly. Platform-agnostic.
 *
 * @property {string}   externalId
 * @property {string}   title
 * @property {string}   description
 * @property {string}   vendor
 * @property {string}   productType
 * @property {string[]} tags
 * @property {number}   priceCents
 * @property {number}   compareAtPriceCents
 * @property {number}   wholesalePriceCents
 * @property {string}   currency
 * @property {number}   inventoryQty
 * @property {string}   primaryImageUrl
 * @property {string[]} imageUrls
 * @property {Array}    variants
 * @property {string}   status
 * @property {string}   publishedAt
 * @property {string}   externalUrl
 * @property {object}   rawPayload
 */

/**
 * @typedef {Object} NormalizedCustomer
 * @property {string} externalId
 * @property {string} emailHash            sha256 of lowercase email
 * @property {string} displayName          safe display form
 * @property {string} region
 * @property {string} customerType         'b2c' | 'retailer'
 * @property {number} totalOrders
 * @property {number} totalSpentCents
 * @property {string} firstOrderAt
 * @property {string} lastOrderAt
 * @property {string[]} tags
 */

/**
 * @typedef {Object} NormalizedOrder
 * @property {string} externalId
 * @property {string} externalOrderNumber
 * @property {string} customerExternalId   link by external id
 * @property {number} subtotalCents
 * @property {number} totalCents
 * @property {string} currency
 * @property {string} financialStatus
 * @property {string} fulfillmentStatus
 * @property {string} placedAt
 * @property {string} cancelledAt
 * @property {Array}  lineItems             [{ externalProductId, title, sku, quantity, priceCents, totalCents }]
 * @property {object} rawPayload
 */

/**
 * @typedef {Object} SyncResult
 * @property {number} fetched      how many items came back from the API
 * @property {number} created      new DB rows
 * @property {number} updated      updated DB rows
 * @property {number} failed
 * @property {string} cursor       pagination cursor (for resuming)
 * @property {boolean} hasMore
 */

export class PlatformDataSource {
  /** @returns {string} */
  get key() { throw new Error('not implemented'); }

  /**
   * Fetch products. Handles pagination internally via opts.cursor.
   * @param {object} connection
   * @param {{ since?: string, limit?: number, cursor?: string }} opts
   * @returns {Promise<{ items: NormalizedProduct[], cursor?: string, hasMore: boolean }>}
   */
  async fetchProducts(_connection, _opts) { throw new Error('fetchProducts not implemented'); }

  /**
   * @returns {Promise<{ items: NormalizedOrder[], cursor?: string, hasMore: boolean }>}
   */
  async fetchOrders(_connection, _opts) { throw new Error('fetchOrders not implemented'); }

  /**
   * @returns {Promise<{ items: NormalizedCustomer[], cursor?: string, hasMore: boolean }>}
   */
  async fetchCustomers(_connection, _opts) { throw new Error('fetchCustomers not implemented'); }

  /**
   * Optional: platform-native analytics (views, conversions).
   * Not all platforms expose this.
   * @returns {Promise<Array<{productExternalId, date, views, orders, revenue}>> | null}
   */
  async fetchAnalytics(_connection, _opts) { return null; }

  /**
   * Check rate limit status; called before big syncs.
   * @returns {Promise<{ok: boolean, resetSec?: number}>}
   */
  async checkRateLimit(_connection) { return { ok: true }; }
}

// Helper: hash an email in a consistent way for dedup without storing raw
import crypto from 'crypto';
export function hashEmail(email) {
  if (!email) return null;
  return crypto.createHash('sha256')
    .update(String(email).toLowerCase().trim())
    .digest('hex');
}

// Helper: safe display name from an email or full name
export function safeDisplayName(fullName, email) {
  if (fullName && fullName.trim()) {
    // Keep first name + last initial, e.g. "Catherine S."
    const parts = fullName.trim().split(/\s+/);
    if (parts.length === 1) return parts[0];
    return parts[0] + ' ' + parts[parts.length - 1][0].toUpperCase() + '.';
  }
  if (email) {
    // e.g. "catherine.smith@..." → "catherine.s"
    const local = email.split('@')[0];
    return local.slice(0, 20);
  }
  return 'Anonymous';
}
