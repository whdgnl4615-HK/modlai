// GET /api/admin/stats
// Returns aggregate stats for the admin dashboard:
//   - revenue (today / week / month, from payments table)
//   - users (total, active today)
//   - generations (today / week / month)
//   - model performance (avg rating per AI model)

import {
  handleCors, errorResponse, requireAdmin, getSupabaseAdmin,
} from '../_lib/utils.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'GET') return errorResponse(res, 405, 'method_not_allowed', 'GET only');

  try { await requireAdmin(req); }
  catch (err) { return errorResponse(res, err.status || 401, 'unauthorized', err.message); }

  const db = await getSupabaseAdmin();
  if (!db) return errorResponse(res, 500, 'no_database', 'Database not configured');

  try {
    const now = new Date();
    const startOfDay = new Date(now); startOfDay.setUTCHours(0,0,0,0);
    const startOfWeek = new Date(now); startOfWeek.setUTCDate(now.getUTCDate() - 7);
    const startOfMonth = new Date(now); startOfMonth.setUTCDate(now.getUTCDate() - 30);

    // Parallel queries
    const [
      usersTotal,
      activeToday,
      revenueDay,
      revenueWeek,
      revenueMonth,
      gensDay,
      gensMonth,
      modelPerf,
      recentPayments,
    ] = await Promise.all([
      db.from('users').select('*', { count: 'exact', head: true }),
      db.from('users').select('*', { count: 'exact', head: true }).gte('updated_at', startOfDay.toISOString()),
      db.from('payments').select('amount_cents').eq('status', 'succeeded').gte('created_at', startOfDay.toISOString()),
      db.from('payments').select('amount_cents').eq('status', 'succeeded').gte('created_at', startOfWeek.toISOString()),
      db.from('payments').select('amount_cents').eq('status', 'succeeded').gte('created_at', startOfMonth.toISOString()),
      db.from('generations').select('*', { count: 'exact', head: true }).gte('created_at', startOfDay.toISOString()),
      db.from('generations').select('*', { count: 'exact', head: true }).gte('created_at', startOfMonth.toISOString()),
      db.from('model_performance').select('*'),
      db.from('payments').select('*').eq('status', 'succeeded').order('created_at', { ascending: false }).limit(10),
    ]);

    const sumCents = (rows) => (rows.data || []).reduce((s, r) => s + (r.amount_cents || 0), 0);

    return res.status(200).json({
      users: {
        total: usersTotal.count || 0,
        activeToday: activeToday.count || 0,
      },
      revenue: {
        today: sumCents(revenueDay),
        week:  sumCents(revenueWeek),
        month: sumCents(revenueMonth),
        currency: 'usd',
      },
      generations: {
        today: gensDay.count || 0,
        month: gensMonth.count || 0,
      },
      modelPerformance: modelPerf.data || [],
      recentPayments: (recentPayments.data || []).map(p => ({
        id: p.id,
        provider: p.provider,
        user_id: p.user_id,
        amount_cents: p.amount_cents,
        credits: p.credits_granted,
        package_id: p.package_id,
        created_at: p.created_at,
      })),
    });

  } catch (err) {
    console.error('[admin/stats]', err);
    return errorResponse(res, 500, 'stats_failed', 'Failed to fetch stats', err.message);
  }
}
