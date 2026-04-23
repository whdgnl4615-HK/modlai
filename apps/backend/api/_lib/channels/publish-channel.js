// Abstract PublishChannel interface.
// Each e-commerce platform (Shopify, Faire, Magento, FashionGo) implements this
// contract. The rest of the app calls the interface and never knows about
// platform specifics.
//
// Core idea: MODLai has a canonical "commerce product" shape, and each adapter
// maps it to the target platform's schema.

/**
 * @typedef {Object} CanonicalProduct
 *
 * This is MODLai's platform-neutral representation of a product about to be
 * published. It's assembled from:
 *   - generations           (title, description, tags from Claude)
 *   - generation_results    (image URLs)
 *   - generation_commerce_meta (price, SKU, inventory, variants)
 *   - fashion_models        (optional model info)
 *
 * @property {string}   title
 * @property {string}   description     (HTML is OK — platforms generally accept it)
 * @property {string}   tagline
 * @property {string[]} highlights
 * @property {string[]} stylingTips
 * @property {string[]} tags
 * @property {string}   seoTitle
 * @property {string}   seoDescription
 * @property {string[]} imageUrls        (must be public HTTPS)
 * @property {string}   primaryImageUrl
 * @property {string}   sku
 * @property {number}   retailPriceCents
 * @property {number}   wholesalePriceCents
 * @property {string}   currency
 * @property {number}   inventoryQty
 * @property {Array<{name, sku, qty, priceCents?}>} variants
 * @property {object}   categoryByChannel   e.g. { shopify: {...}, faire: {...} }
 * @property {number}   weightGrams
 * @property {string}   hsCode
 * @property {string}   countryOfOrigin
 */

/**
 * @typedef {Object} PublishResult
 * @property {string}  externalProductId
 * @property {string}  externalUrl              link to view/edit on target platform
 * @property {object}  rawResponse              full platform response for debugging
 */

/**
 * @typedef {Object} PreviewResult
 *
 * What the platform will see after our mapping. Shown in the UI's "target side"
 * panel so the user can verify before pressing Publish.
 *
 * @property {object}   payload      exact JSON we'd POST to the platform
 * @property {string[]} warnings     non-fatal issues ("SKU missing, will auto-generate")
 * @property {string[]} errors       blocking issues ("Price required for Faire")
 * @property {object}   effective    human-readable summary of key fields
 */

export class PublishChannel {
  /** @returns {string} channel key e.g. 'shopify' */
  get key() { throw new Error('not implemented'); }

  /** @returns {string} display name */
  get name() { throw new Error('not implemented'); }

  /**
   * Validate credentials by calling a cheap endpoint (e.g. GET /shop).
   * @param {object} connection  row from channel_connections
   * @returns {Promise<{ok: boolean, shopInfo?: object, error?: string}>}
   */
  async testConnection(connection) {
    throw new Error('testConnection not implemented');
  }

  /**
   * Map a CanonicalProduct into the platform's payload WITHOUT sending.
   * Used for the preview UI.
   * @returns {Promise<PreviewResult>}
   */
  async preview(product, connection) {
    throw new Error('preview not implemented');
  }

  /**
   * Actually create the product on the platform.
   * @returns {Promise<PublishResult>}
   */
  async publish(product, connection) {
    throw new Error('publish not implemented');
  }

  /**
   * Optional — remove/unpublish. Not all platforms allow hard delete.
   */
  async unpublish(externalId, connection) {
    throw new Error('unpublish not implemented');
  }

  /**
   * OAuth flow entry point (if applicable).
   * @returns {{authUrl: string, stateToken: string}}
   */
  getOAuthUrl(_params) { return null; }

  /**
   * OAuth callback — exchange code for tokens.
   */
  async handleOAuthCallback(_code, _state) { return null; }
}
