// Balance adapter — implements PaymentProvider using Balance's B2B API.
//
// ⚠️  NOTICE: Balance's public API documentation is gated (request access at
//     https://www.getbalance.com/get-api/). This adapter is built from publicly
//     known facts:
//       - API v2.0 released Apr 2024
//       - Stripe-like resource model: Account / Charge / Customer / Refund /
//         Subscription / Transfer, each supporting a `metadata` field
//       - Hosted checkout flow: merchant creates a transaction, buyer is
//         redirected to Balance-hosted payment portal
//       - Net terms: 30 / 45 / 60 / 90 days
//       - Webhooks signed with a shared secret
//
// The endpoint paths, exact request/response shapes, and signature algorithm
// below are BEST-EFFORT STUBS. Once you have official docs, update these three
// things and everything else in the app will keep working:
//   1. API_BASE / endpoint paths (`POST /v2/checkout`, `GET /v2/balance`, etc)
//   2. Field names inside request/response JSON
//   3. Webhook signature verification algorithm (HMAC SHA256 is assumed)
//
// Helper constants up top are marked TODO:DOC-CONFIRM so they're easy to find.

import crypto from 'crypto';
import { PaymentProvider } from './payment-provider.js';

// TODO:DOC-CONFIRM — the live API base. Balance dashboard URL hints at getbalance.com.
const API_BASE = process.env.BALANCE_API_BASE || 'https://api.getbalance.com/v2';

// TODO:DOC-CONFIRM — canonical signature header name
const SIGNATURE_HEADER = 'balance-signature';

export class BalanceProvider extends PaymentProvider {
  constructor() {
    super();
    if (!process.env.BALANCE_API_KEY) {
      throw new Error('BALANCE_API_KEY is not configured');
    }
    this.apiKey = process.env.BALANCE_API_KEY;
    this.webhookSecret = process.env.BALANCE_WEBHOOK_SECRET;
    this.termsDays = parseInt(process.env.BALANCE_TERMS_DAYS || '30', 10); // 30, 45, 60, 90
  }

  async #request(method, path, body) {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) {
      const err = new Error(`Balance API ${res.status}: ${data.message || data.error || text}`);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  async createCheckout({ user, pkg, returnUrl, buyer = {} }) {
    // Create a transaction with hosted checkout flow.
    //
    // Expected response shape (TODO:DOC-CONFIRM):
    //   {
    //     id: 'txn_...',
    //     status: 'pending',
    //     hosted_url: 'https://pay.getbalance.com/...',
    //     due_date: '2026-05-22T...',
    //     invoice: { url: '...', id: '...' }
    //   }
    const payload = {
      amount: pkg.amount_cents,
      currency: (pkg.currency || 'usd').toUpperCase(),
      description: `MODLai — ${pkg.label}`,
      payment_terms: `net${this.termsDays}`,
      // Buyer info for B2B — may need to pre-register buyer via /customers first
      customer: {
        external_id: user.userId,
        email: user.email,
        name: user.displayName || user.email,
        business_name: buyer.companyName || user.displayName || user.email,
        ...(buyer.taxId ? { tax_id: buyer.taxId } : {}),
      },
      // Return URL after buyer completes hosted checkout
      success_url: returnUrl,
      cancel_url: returnUrl,
      // Metadata (same shape as Stripe's) — Balance supports metadata per v2.0
      metadata: {
        userId: user.userId,
        packageId: pkg.id,
        credits: String(pkg.credits),
        provider: 'balance',
      },
    };

    const transaction = await this.#request('POST', '/checkout', payload);

    return {
      flow: 'redirect',
      externalId: transaction.id,
      hostedUrl: transaction.hosted_url || transaction.checkout_url,
      status: transaction.status,
      dueDate: transaction.due_date,
      raw: transaction,
    };
  }

  async verifyAndParseWebhook({ rawBody, headers }) {
    if (!this.webhookSecret) {
      throw new Error('BALANCE_WEBHOOK_SECRET is not configured');
    }

    // TODO:DOC-CONFIRM — signature scheme. Assuming HMAC-SHA256 over raw body.
    const signature = headers[SIGNATURE_HEADER] || headers[SIGNATURE_HEADER.toLowerCase()];
    if (!signature) throw new Error('Missing webhook signature');

    const expected = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(rawBody)
      .digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      throw new Error('Invalid webhook signature');
    }

    const event = JSON.parse(rawBody.toString('utf8'));

    // TODO:DOC-CONFIRM — event types. Educated guess based on v2.0 resources.
    const tx = event.data?.object || event.object || event;
    const base = {
      externalId: tx.id,
      userId:     tx.metadata?.userId,
      credits:    parseInt(tx.metadata?.credits || '0', 10),
      packageId:  tx.metadata?.packageId,
      amountCents: tx.amount,
      raw: event,
    };

    switch (event.type) {
      case 'transaction.paid':
      case 'invoice.paid':
      case 'payment.succeeded':
        return { ...base, type: 'payment.succeeded' };

      case 'transaction.failed':
      case 'invoice.failed':
      case 'payment.failed':
        return { ...base, type: 'payment.failed', reason: tx.failure_reason };

      case 'refund.created':
      case 'payment.refunded':
        return { ...base, type: 'payment.refunded' };

      case 'transaction.created':
      case 'invoice.issued':
        // For Net terms: the transaction exists but is not yet paid.
        // We use this to decide whether to grant credits on issuance (risky)
        // or wait until paid (safer). Default: wait.
        return null;

      default:
        return null;
    }
  }

  async getMerchantBalance() {
    // TODO:DOC-CONFIRM — exact endpoint. Educated guess.
    // Expected: current balance, pending invoices, receivables.
    const [balance, invoices] = await Promise.all([
      this.#request('GET', '/balance').catch(() => null),
      this.#request('GET', '/invoices?status=pending&limit=10').catch(() => null),
    ]);

    return {
      provider: 'balance',
      available:     balance?.available     || [],
      pending:       balance?.pending       || [],
      receivables:   balance?.receivables   || [],   // B2B specific: invoiced but not yet collected
      nextPayout:    balance?.next_payout   || null,
      pendingInvoices: (invoices?.data || []).slice(0, 10).map(inv => ({
        id: inv.id,
        amount: inv.amount,
        currency: inv.currency,
        status: inv.status,
        dueDate: inv.due_date,
        customer: inv.customer?.business_name || inv.customer?.name,
      })),
    };
  }

  async refund(externalId, amountCents) {
    // TODO:DOC-CONFIRM — refund endpoint path
    const refund = await this.#request('POST', '/refunds', {
      transaction_id: externalId,
      ...(amountCents ? { amount: amountCents } : {}),
    });
    return {
      refunded: refund.status === 'succeeded' || refund.status === 'completed',
      refundId: refund.id,
    };
  }
}
