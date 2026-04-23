// GET /api/insights/dashboard?channel=shopify&days=30
// Returns aggregated KPIs + top/bottom performers for the insights overview.

import {
  handleCors, errorResponse, requireAuth, getSupabaseAdmin, requireOrg} from '../_lib/utils.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'GET') return errorResponse(res, 405, 'method_not_allowed');

  let user;
  try { user = await requireAuth(req); }
  catch (err) { return errorResponse(res, err.status || 401, 'unauthorized', err.message); }

  let orgId;
  try { orgId = requireOrg(user); }
  catch (err) { return errorResponse(res, err.status || 403, err.code || 'no_org', err.message); }

  const channel = req.query?.channel;  // optional filter
  const days = Math.min(parseInt(req.query?.days || '30', 10), 365);

  const db = await getSupabaseAdmin();
  if (!db) return res.status(200).json(emptyDashboard());

  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceISO = since.toISOString();

  // 1. Revenue + orders in window
  let orderQuery = db.from('external_orders')
    .select('total_cents, placed_at, financial_status')
    .eq('org_id', orgId)
    .gte('placed_at', sinceISO)
    .is('cancelled_at', null);
  if (channel) orderQuery = orderQuery.eq('channel', channel);

  const { data: orders } = await orderQuery;

  const totalRevenueCents = (orders || []).reduce((s, o) => s + (o.total_cents || 0), 0);
  const totalOrders = (orders || []).length;
  const aov = totalOrders > 0 ? totalRevenueCents / totalOrders : 0;

  // 2. Revenue trend (daily bucket)
  const byDate = {};
  for (const o of (orders || [])) {
    const d = o.placed_at.slice(0, 10);
    if (!byDate[d]) byDate[d] = { date: d, revenue: 0, orders: 0 };
    byDate[d].revenue += o.total_cents || 0;
    byDate[d].orders += 1;
  }
  const trend = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));

  // 3. Top performers (last 30 days)
  let perfQuery = db.from('product_performance')
    .select('id, channel, external_id, title, primary_image_url, price_cents, units_30d, revenue_30d, views_30d, orders_30d, conv_rate_30d, status')
    .eq('org_id', orgId);
  if (channel) perfQuery = perfQuery.eq('channel', channel);

  const { data: performance } = await perfQuery;

  const withSales = (performance || []).filter(p => p.revenue_30d > 0);
  const top10 = [...withSales].sort((a, b) => b.revenue_30d - a.revenue_30d).slice(0, 10);

  // Underperformers: active products with 0 orders in window
  const underperformers = (performance || [])
    .filter(p => p.status === 'active' && (p.orders_30d || 0) === 0)
    .slice(0, 10);

  // 4. Category breakdown (sum revenue by product_type)
  let prodQuery = db.from('external_products')
    .select('id, product_type, price_cents')
    .eq('org_id', orgId);
  if (channel) prodQuery = prodQuery.eq('channel', channel);
  const { data: allProds } = await prodQuery;

  const prodByType = {};
  for (const p of (allProds || [])) {
    const t = p.product_type || 'Uncategorized';
    if (!prodByType[t]) prodByType[t] = { type: t, product_count: 0, revenue_cents: 0 };
    prodByType[t].product_count += 1;
    const perf = (performance || []).find(pp => pp.id === p.id);
    if (perf) prodByType[t].revenue_cents += perf.revenue_30d || 0;
  }
  const categoryBreakdown = Object.values(prodByType).sort((a, b) => b.revenue_cents - a.revenue_cents);

  // 5. Pending AI recommendations
  const { data: recs } = await db
    .from('ai_recommendations')
    .select('id, rec_type, priority, title, summary, estimated_impact, product_ids')
    .eq('org_id', orgId)
    .eq('status', 'pending')
    .order('priority')
    .limit(10);

  return res.status(200).json({
    period: { days, since: sinceISO, channel: channel || 'all' },
    kpis: {
      revenueCents: totalRevenueCents,
      orders: totalOrders,
      aovCents: Math.round(aov),
      activeProducts: (performance || []).filter(p => p.status === 'active').length,
      totalProducts: (performance || []).length,
    },
    trend,
    top10,
    underperformers,
    categoryBreakdown,
    recommendations: recs || [],
  });
}

function emptyDashboard() {
  return {
    period: { days: 30, channel: 'all' },
    kpis: { revenueCents: 0, orders: 0, aovCents: 0, activeProducts: 0, totalProducts: 0 },
    trend: [],
    top10: [],
    underperformers: [],
    categoryBreakdown: [],
    recommendations: [],
    demo: true,
  };
}
