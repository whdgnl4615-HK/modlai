// Channel factory + registry.
// Returns the appropriate PublishChannel adapter for a given channel key.

import { ShopifyChannel } from './shopify-channel.js';
import { FaireChannel }   from './faire-channel.js';

const _cache = new Map();

export function getChannelByKey(key) {
  if (_cache.has(key)) return _cache.get(key);
  let instance;
  switch (key) {
    case 'shopify': instance = new ShopifyChannel(); break;
    case 'faire':   instance = new FaireChannel();   break;
    // Magento and FashionGo adapters can be added later with the same shape.
    default:
      throw new Error(`Unknown channel: ${key}`);
  }
  _cache.set(key, instance);
  return instance;
}

export const SUPPORTED_CHANNELS = ['shopify', 'faire'];
