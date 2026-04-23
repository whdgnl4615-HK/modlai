// Sync engine — pulls entities from a DataSource and upserts into our DB.
// Handles pagination, incremental sync, job tracking, and error recovery.
//
// Usage:
//   const result = await runSync({
//     userId, channel: 'shopify', entity: 'products', incremental: true
//   });

import { getSupabaseAdmin } from '../utils.js';
import { getDataSourceByKey } from './index.js';

const MAX_PAGES_PER_SYNC = 40;  // safety cap - avoid infinite loops
const MAX_ITEMS_PER_SYNC = 5000; // safety cap

/**
 * Run a sync job for one entity (products, orders, customers).
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.channel
 * @param {string} opts.entity   'products' | 'orders' | 'customers'
 * @param {boolean} opts.incremental  if true, only fetch items updated since last successful sync
 */
export async function runSync({ userId, channel, entity, incremental = true }) {
  const admin = await getSupabaseAdmin();
  if (!admin) throw new Error('Database not configured');

  // Load connection
  const { data: conn } = await admin
    .from('channel_connections')
    .select('*')
    .eq('user_id', userId)
    .eq('channel', channel)
    .eq('status', 'active')
    .maybeSingle();
  if (!conn) throw new Error(`Not connected to ${channel}`);

  // Create sync_jobs row
  const { data: job } = await admin.from('sync_jobs').insert({
    user_id: userId,
    channel,
    entity,
    status: 'running',
    started_at: new Date().toISOString(),
  }).select('*').single();

  // Determine "since" for incremental
  let since = null;
  if (incremental) {
    const { data: lastJob } = await admin.from('sync_jobs')
      .select('completed_at')
      .eq('user_id', userId)
      .eq('channel', channel)
      .eq('entity', entity)
      .eq('status', 'completed')
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastJob?.completed_at) since = lastJob.completed_at;
  }

  const ds = getDataSourceByKey(channel);
  const fetcher = entity === 'products' ? ds.fetchProducts.bind(ds)
                : entity === 'orders'   ? ds.fetchOrders.bind(ds)
                : entity === 'customers' ? ds.fetchCustomers.bind(ds)
                : null;
  if (!fetcher) throw new Error(`Unknown entity: ${entity}`);

  const processor = entity === 'products' ? processProducts
                  : entity === 'orders'   ? processOrders
                  : processCustomers;

  const stats = { fetched: 0, created: 0, updated: 0, failed: 0 };
  let cursor = null;
  let pageCount = 0;
  let error = null;

  try {
    while (pageCount < MAX_PAGES_PER_SYNC && stats.fetched < MAX_ITEMS_PER_SYNC) {
      pageCount++;
      const page = await fetcher(conn, { since, cursor, limit: 250 });
      if (!page.items || !page.items.length) break;

      stats.fetched += page.items.length;

      const partial = await processor({ admin, userId, channel, items: page.items });
      stats.created += partial.created;
      stats.updated += partial.updated;
      stats.failed += partial.failed;

      if (!page.hasMore) break;
      cursor = page.cursor;
      if (!cursor) break; // safety
    }
  } catch (err) {
    console.error(`[sync:${channel}:${entity}]`, err);
    error = err.message;
  }

  // Update job
  const now = new Date();
  const jobUpdate = {
    status: error ? 'failed' : 'completed',
    items_fetched: stats.fetched,
    items_created: stats.created,
    items_updated: stats.updated,
    items_failed: stats.failed,
    error_message: error,
    completed_at: now.toISOString(),
    duration_ms: now - new Date(job.started_at),
  };
  await admin.from('sync_jobs').update(jobUpdate).eq('id', job.id);

  if (error) {
    const err = new Error(error);
    err.jobId = job.id;
    err.stats = stats;
    throw err;
  }

  return { jobId: job.id, ...stats };
}

// ═══════════════════════════════════════════════════
// Processors — upsert into our tables
// ═══════════════════════════════════════════════════

async function processProducts({ admin, userId, channel, items }) {
  let created = 0, updated = 0, failed = 0;
  for (const item of items) {
    const row = {
      user_id: userId,
      channel,
      external_id: item.externalId,
      external_url: item.externalUrl,
      title: item.title,
      description: item.description,
      vendor: item.vendor,
      product_type: item.productType,
      tags: item.tags,
      price_cents: item.priceCents,
      compare_at_price_cents: item.compareAtPriceCents,
      wholesale_price_cents: item.wholesalePriceCents,
      currency: item.currency,
      inventory_qty: item.inventoryQty,
      primary_image_url: item.primaryImageUrl,
      image_urls: item.imageUrls,
      variants: item.variants,
      status: item.status,
      published_at: item.publishedAt,
      raw_payload: item.rawPayload,
      synced_at: new Date().toISOString(),
    };

    // Link to MODLai generation if this product was published from MODLai
    const { data: pub } = await admin
      .from('publishings')
      .select('generation_id')
      .eq('user_id', userId)
      .eq('channel', channel)
      .eq('external_product_id', item.externalId)
      .maybeSingle();
    if (pub?.generation_id) row.modlai_generation_id = pub.generation_id;

    const { error, data } = await admin
      .from('external_products')
      .upsert(row, { onConflict: 'user_id,channel,external_id' })
      .select('id, created_at, updated_at');

    if (error) { failed++; console.warn('[sync:product]', error.message); }
    else if (data?.[0]) {
      // Rough heuristic: created_at == updated_at (or close) means new
      const row = data[0];
      if (row.created_at === row.updated_at) created++;
      else updated++;
    }
  }
  return { created, updated, failed };
}

async function processOrders({ admin, userId, channel, items }) {
  let created = 0, updated = 0, failed = 0;
  for (const item of items) {
    // Resolve customer_id if we have one
    let customerId = null;
    if (item.customerExternalId) {
      const { data: cust } = await admin
        .from('external_customers')
        .select('id')
        .eq('user_id', userId)
        .eq('channel', channel)
        .eq('external_id', item.customerExternalId)
        .maybeSingle();
      customerId = cust?.id || null;
    }

    const orderRow = {
      user_id: userId,
      channel,
      external_id: item.externalId,
      external_order_number: item.externalOrderNumber,
      customer_id: customerId,
      subtotal_cents: item.subtotalCents,
      total_cents: item.totalCents,
      currency: item.currency,
      financial_status: item.financialStatus,
      fulfillment_status: item.fulfillmentStatus,
      placed_at: item.placedAt,
      cancelled_at: item.cancelledAt,
      raw_payload: item.rawPayload,
      synced_at: new Date().toISOString(),
    };

    const { data: upserted, error } = await admin
      .from('external_orders')
      .upsert(orderRow, { onConflict: 'user_id,channel,external_id' })
      .select('id, created_at, updated_at')
      .single();

    if (error) { failed++; continue; }
    const isNew = upserted.created_at === upserted.updated_at;
    if (isNew) created++; else updated++;

    // Line items: delete old + insert new (simpler than diffing)
    if (item.lineItems && item.lineItems.length) {
      await admin.from('external_order_items')
        .delete()
        .eq('order_id', upserted.id);

      // Resolve product_id for each line item
      const productLookup = {};
      for (const li of item.lineItems) {
        if (li.externalProductId && !productLookup[li.externalProductId]) {
          const { data: p } = await admin
            .from('external_products')
            .select('id')
            .eq('user_id', userId)
            .eq('channel', channel)
            .eq('external_id', li.externalProductId)
            .maybeSingle();
          productLookup[li.externalProductId] = p?.id || null;
        }
      }

      const lineRows = item.lineItems.map(li => ({
        user_id: userId,
        order_id: upserted.id,
        product_id: li.externalProductId ? productLookup[li.externalProductId] : null,
        external_product_id: li.externalProductId,
        title: li.title,
        sku: li.sku,
        quantity: li.quantity,
        price_cents: li.priceCents,
        total_cents: li.totalCents,
      }));
      if (lineRows.length) {
        await admin.from('external_order_items').insert(lineRows);
      }
    }
  }
  return { created, updated, failed };
}

async function processCustomers({ admin, userId, channel, items }) {
  let created = 0, updated = 0, failed = 0;
  for (const item of items) {
    const row = {
      user_id: userId,
      channel,
      external_id: item.externalId,
      email_hash: item.emailHash,
      display_name: item.displayName,
      region: item.region,
      customer_type: item.customerType,
      total_orders: item.totalOrders,
      total_spent_cents: item.totalSpentCents,
      first_order_at: item.firstOrderAt,
      last_order_at: item.lastOrderAt,
      tags: item.tags,
      synced_at: new Date().toISOString(),
    };

    const { data, error } = await admin
      .from('external_customers')
      .upsert(row, { onConflict: 'user_id,channel,external_id' })
      .select('id, created_at, updated_at');

    if (error) { failed++; }
    else if (data?.[0]) {
      if (data[0].created_at === data[0].updated_at) created++;
      else updated++;
    }
  }
  return { created, updated, failed };
}

// ═══════════════════════════════════════════════════
// Analytics aggregation
// After orders are synced, roll them up into product_analytics_daily
// ═══════════════════════════════════════════════════
export async function rebuildProductAnalytics({ userId, sinceDays = 60 }) {
  const admin = await getSupabaseAdmin();
  if (!admin) throw new Error('Database not configured');

  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - sinceDays);

  // Aggregate orders by product by day
  // Note: This is done in SQL for efficiency. We delete old rows and rebuild.
  const sql = `
    with agg as (
      select
        oi.user_id,
        oi.product_id,
        date(o.placed_at) as date,
        count(distinct o.id)     as orders_count,
        sum(oi.quantity)::int     as units_sold,
        sum(oi.total_cents)::bigint as revenue_cents
      from public.external_order_items oi
      join public.external_orders o on o.id = oi.order_id
      where oi.user_id = $1
        and oi.product_id is not null
        and o.placed_at >= $2
        and o.cancelled_at is null
      group by oi.user_id, oi.product_id, date(o.placed_at)
    )
    insert into public.product_analytics_daily
      (user_id, product_id, date, orders_count, units_sold, revenue_cents)
    select * from agg
    on conflict (user_id, product_id, date) do update set
      orders_count  = excluded.orders_count,
      units_sold    = excluded.units_sold,
      revenue_cents = excluded.revenue_cents;
  `;

  // Supabase doesn't support $1/$2 via JS client directly for raw SQL;
  // use rpc or construct safely. Simpler: use JS-side aggregation.
  // For now we'll do the aggregation in JS to keep it simple.

  // Fetch order items joined with orders
  const { data: items } = await admin
    .from('external_order_items')
    .select('product_id, quantity, total_cents, external_orders!inner(user_id, placed_at, cancelled_at)')
    .eq('user_id', userId)
    .gte('external_orders.placed_at', sinceDate.toISOString());

  if (!items) return { ok: false };

  const agg = {};
  for (const item of items) {
    if (!item.product_id) continue;
    const order = item.external_orders;
    if (!order || order.cancelled_at) continue;
    const date = order.placed_at.slice(0, 10); // YYYY-MM-DD
    const key = `${item.product_id}::${date}`;
    if (!agg[key]) {
      agg[key] = {
        user_id: userId,
        product_id: item.product_id,
        date,
        orders_count: 0,
        units_sold: 0,
        revenue_cents: 0,
      };
    }
    agg[key].orders_count += 1;
    agg[key].units_sold += item.quantity || 0;
    agg[key].revenue_cents += item.total_cents || 0;
  }

  const rows = Object.values(agg);
  if (!rows.length) return { ok: true, rowsWritten: 0 };

  // Upsert in batches of 500
  let written = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const { error } = await admin
      .from('product_analytics_daily')
      .upsert(batch, { onConflict: 'user_id,product_id,date' });
    if (!error) written += batch.length;
  }

  return { ok: true, rowsWritten: written };
}
