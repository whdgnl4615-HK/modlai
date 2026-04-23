// Abstract payment provider interface.
// Both Stripe and Balance adapters implement this contract, so the rest of the
// backend (and the frontend) only speaks to providers through these methods.
//
// If a third provider is ever added (PayPal, Toss, etc), just add another adapter
// that implements the same shape — nothing else in the app needs to change.

/**
 * @typedef {Object} CreateCheckoutInput
 * @property {object}  user        - { userId, email, displayName }
 * @property {object}  pkg         - credit_packages row { id, credits, amount_cents, currency, label }
 * @property {string}  [returnUrl] - where to redirect after hosted checkout (optional)
 * @property {object}  [buyer]     - { companyName, taxId, ... } - required for Balance
 */

/**
 * @typedef {Object} CheckoutResult
 * @property {'redirect'|'elements'|'embedded'} flow  - how the frontend should proceed
 * @property {string}  externalId              - provider-side id (PaymentIntent id, Balance transaction id, ...)
 * @property {string}  [clientSecret]          - Stripe only, for stripe.js
 * @property {string}  [hostedUrl]             - Balance only, buyer goes here
 * @property {string}  [status]                - provider-side status string
 * @property {string}  [dueDate]               - Balance Net terms due date ISO
 * @property {object}  raw                     - unchanged provider response (for debugging)
 */

/**
 * @typedef {Object} WebhookVerifyInput
 * @property {Buffer}  rawBody
 * @property {object}  headers
 */

/**
 * @typedef {Object} WebhookEvent
 * @property {string}  type     - normalized: 'payment.succeeded' | 'payment.failed' | 'payment.refunded'
 * @property {string}  externalId
 * @property {string}  userId   - from metadata
 * @property {number}  credits  - from metadata
 * @property {string}  packageId
 * @property {number}  amountCents
 * @property {string}  [reason] - failure reason
 * @property {object}  raw
 */

export class PaymentProvider {
  /** @returns {Promise<CheckoutResult>} */
  async createCheckout(input) {
    throw new Error('createCheckout not implemented');
  }

  /** @returns {Promise<WebhookEvent|null>} returns null if event type is not interesting */
  async verifyAndParseWebhook(input) {
    throw new Error('verifyAndParseWebhook not implemented');
  }

  /** @returns {Promise<object>} - account-level balance + recent activity */
  async getMerchantBalance() {
    throw new Error('getMerchantBalance not implemented');
  }

  /** @returns {Promise<{refunded: boolean, refundId?: string}>} */
  async refund(externalId, amountCents) {
    throw new Error('refund not implemented');
  }

  /** @returns {string} */
  get name() { return this.constructor.name.replace('Provider', '').toLowerCase(); }
}
