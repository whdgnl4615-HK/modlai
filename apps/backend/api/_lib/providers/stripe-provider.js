// Stripe adapter — implements PaymentProvider using Stripe's PaymentIntent API.

import Stripe from 'stripe';
import { PaymentProvider } from './payment-provider.js';

export class StripeProvider extends PaymentProvider {
  constructor() {
    super();
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY is not configured');
    }
    this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  }

  async createCheckout({ user, pkg, returnUrl }) {
    const paymentIntent = await this.stripe.paymentIntents.create({
      amount: pkg.amount_cents,
      currency: pkg.currency || 'usd',
      automatic_payment_methods: { enabled: true },
      metadata: {
        userId: user.userId,
        packageId: pkg.id,
        credits: String(pkg.credits),
        provider: 'stripe',
      },
      description: `MODLai — ${pkg.label}`,
      ...(user.email ? { receipt_email: user.email } : {}),
    });

    return {
      flow: 'elements',                            // frontend mounts Stripe Elements
      externalId: paymentIntent.id,
      clientSecret: paymentIntent.client_secret,
      status: paymentIntent.status,
      raw: paymentIntent,
    };
  }

  async verifyAndParseWebhook({ rawBody, headers }) {
    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
    }
    const signature = headers['stripe-signature'];
    const event = this.stripe.webhooks.constructEvent(
      rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET
    );

    // Normalize to our WebhookEvent shape
    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object;
      return {
        type: 'payment.succeeded',
        externalId: pi.id,
        userId:   pi.metadata?.userId,
        credits:  parseInt(pi.metadata?.credits || '0', 10),
        packageId: pi.metadata?.packageId,
        amountCents: pi.amount,
        raw: pi,
      };
    }
    if (event.type === 'payment_intent.payment_failed') {
      const pi = event.data.object;
      return {
        type: 'payment.failed',
        externalId: pi.id,
        userId:   pi.metadata?.userId,
        credits:  parseInt(pi.metadata?.credits || '0', 10),
        packageId: pi.metadata?.packageId,
        amountCents: pi.amount,
        reason: pi.last_payment_error?.message,
        raw: pi,
      };
    }
    if (event.type === 'charge.refunded') {
      const charge = event.data.object;
      return {
        type: 'payment.refunded',
        externalId: charge.payment_intent,
        userId:   charge.metadata?.userId,
        credits:  parseInt(charge.metadata?.credits || '0', 10),
        packageId: charge.metadata?.packageId,
        amountCents: charge.amount_refunded,
        raw: charge,
      };
    }
    return null; // ignore other events
  }

  async getMerchantBalance() {
    // Current account balance (available / pending)
    const bal = await this.stripe.balance.retrieve();
    // Recent payouts (settlement to bank)
    const payouts = await this.stripe.payouts.list({ limit: 10 });
    // Next scheduled payout (if any)
    const upcoming = payouts.data.find(p => p.status === 'pending' || p.status === 'in_transit');

    return {
      provider: 'stripe',
      available: bal.available.map(b => ({ amount: b.amount, currency: b.currency })),
      pending:   bal.pending.map(b => ({ amount: b.amount, currency: b.currency })),
      nextPayout: upcoming ? {
        amount:         upcoming.amount,
        currency:       upcoming.currency,
        arrivalDate:    new Date(upcoming.arrival_date * 1000).toISOString(),
        status:         upcoming.status,
      } : null,
      recentPayouts: payouts.data.slice(0, 5).map(p => ({
        id: p.id,
        amount: p.amount,
        currency: p.currency,
        status: p.status,
        arrivalDate: new Date(p.arrival_date * 1000).toISOString(),
      })),
    };
  }

  async refund(externalId, amountCents) {
    const refund = await this.stripe.refunds.create({
      payment_intent: externalId,
      ...(amountCents ? { amount: amountCents } : {}),
    });
    return { refunded: refund.status === 'succeeded', refundId: refund.id };
  }
}
