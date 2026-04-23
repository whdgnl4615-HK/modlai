// Provider factory — returns the active payment provider based on system_settings.
// Reads the `active_payment_provider` key and instantiates the right adapter.
// Caches instances (the adapters themselves are stateless aside from credentials).

import { StripeProvider } from './stripe-provider.js';
import { BalanceProvider } from './balance-provider.js';

const _cache = new Map();

export function getProviderByName(name) {
  if (_cache.has(name)) return _cache.get(name);
  let instance;
  switch (name) {
    case 'stripe':
      instance = new StripeProvider();
      break;
    case 'balance':
      instance = new BalanceProvider();
      break;
    default:
      throw new Error(`Unknown payment provider: ${name}`);
  }
  _cache.set(name, instance);
  return instance;
}

/**
 * Returns the currently-active provider based on system_settings.
 * Falls back to 'stripe' if no setting exists or Supabase isn't configured.
 */
export async function getActiveProvider(supabaseAdmin) {
  if (!supabaseAdmin) return getProviderByName('stripe');

  const { data } = await supabaseAdmin
    .from('system_settings')
    .select('value')
    .eq('key', 'active_payment_provider')
    .single();

  const name = (data?.value && String(data.value).replace(/"/g, '')) || 'stripe';
  return getProviderByName(name);
}

export async function getActiveProviderName(supabaseAdmin) {
  if (!supabaseAdmin) return 'stripe';
  const { data } = await supabaseAdmin
    .from('system_settings')
    .select('value')
    .eq('key', 'active_payment_provider')
    .single();
  return (data?.value && String(data.value).replace(/"/g, '')) || 'stripe';
}
