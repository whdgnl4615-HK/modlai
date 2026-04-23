// DataSource factory + registry.
import { ShopifyDataSource } from './shopify-datasource.js';
import { FaireDataSource }   from './faire-datasource.js';

const _cache = new Map();

export function getDataSourceByKey(key) {
  if (_cache.has(key)) return _cache.get(key);
  let ds;
  switch (key) {
    case 'shopify': ds = new ShopifyDataSource(); break;
    case 'faire':   ds = new FaireDataSource(); break;
    default: throw new Error(`Unknown data source: ${key}`);
  }
  _cache.set(key, ds);
  return ds;
}

export const SUPPORTED_DATASOURCES = ['shopify', 'faire'];
