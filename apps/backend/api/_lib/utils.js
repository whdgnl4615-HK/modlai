// Shared utilities for all API routes
// Consolidated here: CORS, auth, env validation, credit ops, data URL parsing

import crypto from 'crypto';

// ─────────────────────────────────────────────
// CORS
// ─────────────────────────────────────────────
export function handleCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Org-Id');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────
// ERROR RESPONSE
// ─────────────────────────────────────────────
export function errorResponse(res, status, code, message, detail) {
  return res.status(status).json({
    error: { code, message, detail: detail ? String(detail) : undefined }
  });
}

// ─────────────────────────────────────────────
// ENV VALIDATION
// Fails fast with helpful message if a required key is missing
// ─────────────────────────────────────────────
export function requireEnv(key) {
  const val = process.env[key];
  if (!val) {
    const err = new Error(`Missing required env var: ${key}`);
    err.code = 'missing_env';
    err.envKey = key;
    throw err;
  }
  return val;
}

export function envMiddleware(res, keys) {
  for (const k of keys) {
    if (!process.env[k]) {
      errorResponse(res, 500, 'missing_env', `Server not configured: ${k} missing`);
      return false;
    }
  }
  return true;
}

// ─────────────────────────────────────────────
// AUTH
// Verifies Supabase JWT from Authorization header
// Returns { userId, email, role, credits } or throws
// Falls back to demo mode when SUPABASE_* env vars are missing
// ─────────────────────────────────────────────
let _supabaseAdmin = null;
export async function getSupabaseAdmin() {
  if (_supabaseAdmin) return _supabaseAdmin;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  const { createClient } = await import('@supabase/supabase-js');
  _supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
  return _supabaseAdmin;
}

// ─────────────────────────────────────────────
// SYSTEM SETTINGS & PACKAGES
// ─────────────────────────────────────────────
export async function getCreditPackage(packageId) {
  const admin = await getSupabaseAdmin();
  if (!admin) {
    // Demo fallback
    const demoMap = {
      starter: { id: 'starter', credits: 500,   amount_cents: 900,   currency: 'usd', label: '500 credits' },
      pro:     { id: 'pro',     credits: 2500,  amount_cents: 3900,  currency: 'usd', label: '2,500 credits' },
      studio:  { id: 'studio',  credits: 10000, amount_cents: 12900, currency: 'usd', label: '10,000 credits' },
      enterprise_50k: { id: 'enterprise_50k', credits: 50000, amount_cents: 59900, currency: 'usd', label: '50,000 credits · Net 30', is_enterprise: true },
    };
    return demoMap[packageId] || null;
  }
  const { data, error } = await admin
    .from('credit_packages')
    .select('*')
    .eq('id', packageId)
    .eq('is_active', true)
    .single();
  if (error) return null;
  return data;
}

export async function listCreditPackages(opts = {}) {
  const admin = await getSupabaseAdmin();
  if (!admin) {
    return [
      { id: 'starter', credits: 500,   amount_cents: 900,   currency: 'usd', label: '500 credits',   is_enterprise: false, sort_order: 10 },
      { id: 'pro',     credits: 2500,  amount_cents: 3900,  currency: 'usd', label: '2,500 credits', is_enterprise: false, sort_order: 20 },
      { id: 'studio',  credits: 10000, amount_cents: 12900, currency: 'usd', label: '10,000 credits',is_enterprise: false, sort_order: 30 },
    ];
  }
  let query = admin.from('credit_packages').select('*').eq('is_active', true).order('sort_order');
  if (opts.includeEnterprise === false) query = query.eq('is_enterprise', false);
  const { data } = await query;
  return data || [];
}

export async function getSystemSetting(key, fallback = null) {
  const admin = await getSupabaseAdmin();
  if (!admin) return fallback;
  const { data } = await admin
    .from('system_settings')
    .select('value')
    .eq('key', key)
    .single();
  if (!data) return fallback;
  // JSONB could be a JSON string like "stripe", a number, boolean, or object
  return data.value;
}

export async function requireAuth(req) {
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');

  const admin = await getSupabaseAdmin();

  // Demo mode: Supabase not configured yet — accept any request
  if (!admin) {
    console.warn('[auth] Supabase not configured — running in demo mode');
    return {
      userId: 'demo-user', email: 'demo@modlai.local', role: 'user',
      credits: 9999, demo: true,
      orgId: 'demo-org', orgRole: 'owner', orgName: 'Demo Org',
    };
  }

  if (!token) {
    const err = new Error('Missing auth token');
    err.status = 401;
    throw err;
  }

  // Verify JWT
  const { data: { user }, error } = await admin.auth.getUser(token);
  if (error || !user) {
    const err = new Error('Invalid token');
    err.status = 401;
    throw err;
  }

  // Fetch profile (role, credits)
  const { data: profile, error: profileErr } = await admin
    .from('users')
    .select('id, email, role, credits, is_blocked, active_org_id')
    .eq('id', user.id)
    .single();

  if (profileErr || !profile) {
    const err = new Error('User profile not found');
    err.status = 401;
    throw err;
  }

  if (profile.is_blocked) {
    const err = new Error('Account blocked');
    err.status = 403;
    throw err;
  }

  // Try to resolve user's active organization
  //   1. Read from X-Org-Id header if user is a platform admin (impersonation)
  //   2. Otherwise use user's single active membership
  let orgId = null;
  let orgRole = null;
  let orgName = null;
  let orgCredits = 0;

  const headerOrgId = req.headers['x-org-id'];
  const isPlatformAdmin = profile.role === 'admin';

  if (headerOrgId && isPlatformAdmin) {
    // Platform admin can switch into any org
    orgId = headerOrgId;
    orgRole = 'owner'; // admins act as owners
  } else {
    // Regular user: find their single membership
    const { data: membership } = await admin
      .from('organization_members')
      .select('organization_id, role, organizations!inner(id, name, credits_balance)')
      .eq('user_id', profile.id)
      .eq('status', 'active')
      .limit(1)
      .maybeSingle();

    if (membership) {
      orgId = membership.organization_id;
      orgRole = membership.role;
      orgName = membership.organizations?.name;
      orgCredits = membership.organizations?.credits_balance || 0;
    }
  }

  // If we have an org but not yet credits info, fetch it
  if (orgId && !orgName) {
    const { data: org } = await admin
      .from('organizations')
      .select('name, credits_balance')
      .eq('id', orgId)
      .maybeSingle();
    if (org) {
      orgName = org.name;
      orgCredits = org.credits_balance || 0;
    }
  }

  return {
    userId: profile.id,
    email: profile.email,
    role: profile.role,
    credits: profile.credits,  // legacy user-level credits (kept for backward compat)
    demo: false,

    // Org context
    orgId,
    orgRole,
    orgName,
    orgCredits,
    isPlatformAdmin,
  };
}

// Enforces that the request has an org context.
// Call this after requireAuth when the endpoint is org-scoped.
export function requireOrg(user) {
  if (!user.orgId) {
    const err = new Error('No organization context. Create or join an organization first.');
    err.status = 403;
    err.code = 'no_org';
    throw err;
  }
  return user.orgId;
}

// Enforces that the caller is owner/admin of the org
export function requireOrgAdmin(user) {
  requireOrg(user);
  if (user.isPlatformAdmin) return user.orgId;
  if (user.orgRole !== 'owner' && user.orgRole !== 'admin') {
    const err = new Error('Organization admin access required');
    err.status = 403;
    err.code = 'org_admin_required';
    throw err;
  }
  return user.orgId;
}

export function requireOrgOwner(user) {
  requireOrg(user);
  if (user.isPlatformAdmin) return user.orgId;
  if (user.orgRole !== 'owner') {
    const err = new Error('Organization owner access required');
    err.status = 403;
    err.code = 'org_owner_required';
    throw err;
  }
  return user.orgId;
}

export async function requireAdmin(req) {
  const user = await requireAuth(req);
  if (user.role !== 'admin') {
    const err = new Error('Admin access required');
    err.status = 403;
    throw err;
  }
  return user;
}

// ─────────────────────────────────────────────
// CREDIT OPERATIONS
// Uses Supabase atomic RPC functions; falls back to no-op in demo mode
// ─────────────────────────────────────────────
export const MODEL_COSTS = {
  nanobanana: 30,
  openai: 50,
  stability: 20,
};
export const DESCRIPTION_COST = 10;
export const EDIT_COST = 30;

export async function deductCredits(userIdOrUser, amount, kind, referenceId = null, note = null) {
  const admin = await getSupabaseAdmin();
  if (!admin) {
    console.log('[credits:demo] deduct', { amount, kind });
    return true;
  }

  // Accept either a user object (from requireAuth) or a raw userId for legacy callers
  const user = typeof userIdOrUser === 'object' ? userIdOrUser : null;
  const userId = user ? user.userId : userIdOrUser;
  const orgId = user ? user.orgId : null;

  // Prefer org pool if we have org context
  if (orgId) {
    const { data, error } = await admin.rpc('deduct_org_credits', {
      p_org_id: orgId,
      p_user_id: userId,
      p_amount: amount,
      p_reason: kind,
      p_reference_id: referenceId,
      p_description: note,
    });
    if (error) {
      console.error('[credits:org] deduct error:', error);
      return false;
    }
    return data === true;
  }

  // Fallback: legacy user-level deduction
  const { data, error } = await admin.rpc('deduct_credits', {
    p_user_id: userId,
    p_amount: amount,
    p_reason: kind,
    p_reference_id: referenceId,
    p_description: note,
  });
  if (error) {
    console.error('[credits] deduct error:', error);
    return false;
  }
  return data === true;
}

export async function refundCredits(userIdOrUser, amount, kind = 'refund', note = null) {
  const admin = await getSupabaseAdmin();
  if (!admin) return true;

  const user = typeof userIdOrUser === 'object' ? userIdOrUser : null;
  const userId = user ? user.userId : userIdOrUser;
  const orgId = user ? user.orgId : null;

  if (orgId) {
    const { error } = await admin.rpc('add_org_credits', {
      p_org_id: orgId,
      p_user_id: userId,
      p_amount: amount,
      p_reason: kind,
      p_description: note,
    });
    if (error) console.error('[credits:org] refund error:', error);
    return !error;
  }

  // Legacy
  const { error } = await admin.rpc('add_credits', {
    p_user_id: userId,
    p_amount: amount,
    p_reason: kind,
    p_description: note,
  });
  if (error) console.error('[credits] refund error:', error);
  return !error;
}

export async function grantCredits(userIdOrUser, amount, kind, opts = {}) {
  const admin = await getSupabaseAdmin();
  if (!admin) {
    console.log('[credits:demo] grant', { amount, kind });
    return;
  }

  const user = typeof userIdOrUser === 'object' ? userIdOrUser : null;
  const userId = user ? user.userId : userIdOrUser;
  const orgId = (user && user.orgId) || opts.orgId || null;

  if (orgId) {
    const { error } = await admin.rpc('add_org_credits', {
      p_org_id: orgId,
      p_user_id: userId,
      p_amount: amount,
      p_reason: kind,
      p_description: opts.note || null,
    });
    if (error) throw new Error('Credit grant failed: ' + error.message);
    return;
  }

  // Legacy
  const { error } = await admin.rpc('grant_credits', {
    p_user_id: userId,
    p_amount: amount,
    p_kind: kind,
    p_reference_id: opts.referenceId || null,
    p_stripe_payment_intent_id: opts.stripePaymentIntentId || null,
    p_note: opts.note || null,
  });
  if (error) throw new Error('Credit grant failed: ' + error.message);
}

// ─────────────────────────────────────────────
// DATA URL PARSING (was duplicated across 4 files)
// ─────────────────────────────────────────────
export function parseDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  return { mimeType: m[1], data: m[2] };
}

// ─────────────────────────────────────────────
// REQUEST BODY PARSING
// ─────────────────────────────────────────────
export async function readJson(req) {
  if (req.body) {
    return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

// ─────────────────────────────────────────────
// STORAGE (Supabase Storage)
// Uploads an image, returns public URL (or data URL in demo mode)
// ─────────────────────────────────────────────
export async function uploadGeneratedImage(userId, base64Data, mimeType = 'image/png', opts = {}) {
  const bucket = opts.bucket || 'generated-images';
  const subfolder = opts.subfolder || '';
  const admin = await getSupabaseAdmin();
  if (!admin) {
    // Demo mode — return data URL directly
    return `data:${mimeType};base64,${base64Data}`;
  }

  const ext = mimeType.split('/')[1] || 'png';
  const path = subfolder
    ? `${userId}/${subfolder}/${crypto.randomUUID()}.${ext}`
    : `${userId}/${crypto.randomUUID()}.${ext}`;
  const buffer = Buffer.from(base64Data, 'base64');

  const { error } = await admin.storage
    .from(bucket)
    .upload(path, buffer, { contentType: mimeType, cacheControl: '31536000' });

  if (error) throw new Error('Storage upload failed: ' + error.message);

  if (bucket === 'user-uploads') {
    // Private bucket — return signed URL
    const { data } = await admin.storage.from(bucket).createSignedUrl(path, 60 * 60 * 24 * 7);
    return data?.signedUrl || null;
  }
  const { data } = admin.storage.from(bucket).getPublicUrl(path);
  return data.publicUrl;
}

// Convenience: upload a data URL (base64) in one call
export async function uploadDataUrl(userId, dataUrl, opts = {}) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) {
    // Not a data URL — return as-is (might already be a public URL)
    return dataUrl;
  }
  return uploadGeneratedImage(userId, parsed.data, parsed.mimeType, opts);
}

// ─────────────────────────────────────────────
// FASHION MODEL HELPERS
// Loads a model's character sheet images as refImages for AI generation.
// Used by /api/generate/* to ensure consistency when a model is selected.
// ─────────────────────────────────────────────
export async function getModelSheetAsRefImages(userId, modelId) {
  const admin = await getSupabaseAdmin();
  if (!admin || !modelId) return null;

  // Look up the model — either owned by this user or a system model (org_id IS NULL).
  // System models are usable by any authenticated user.
  const { data: model } = await admin
    .from('fashion_models')
    .select('id, enriched_appearance, appearance, status, org_id, user_id')
    .eq('id', modelId)
    .or(`user_id.eq.${userId},org_id.is.null`)
    .maybeSingle();
  if (!model) return null;

  const { data: sheets } = await admin
    .from('fashion_model_sheets')
    .select('angle, image_url')
    .eq('fashion_model_id', modelId)
    .order('sort_order');

  if (!sheets || !sheets.length) return { model, refImages: {} };

  // Map angles to refImage slots. 'front' becomes 'main', others use their angle name.
  const refImages = {};
  for (const s of sheets) {
    // Fetch each as data URL (AI providers want base64)
    try {
      const res = await fetch(s.image_url);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      const mime = res.headers.get('content-type') || 'image/png';
      const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
      const slot = s.angle === 'front' ? 'model_front'
                 : s.angle === 'three_quarter' ? 'model_34'
                 : s.angle === 'side' ? 'model_side'
                 : s.angle === 'back' ? 'model_back'
                 : s.angle === 'full_body' ? 'model_body'
                 : `model_${s.angle}`;
      refImages[slot] = dataUrl;
    } catch (e) {
      // skip on error
    }
  }
  return { model, refImages };
}

// ─────────────────────────────────────────────
// DB HELPERS - record generation activity
// ─────────────────────────────────────────────
export async function recordGeneration(userOrUserId, payload) {
  const admin = await getSupabaseAdmin();
  if (!admin) return { id: 'demo-' + Date.now() };

  // Accept either a user object (from requireAuth) or raw userId
  const user = typeof userOrUserId === 'object' ? userOrUserId : null;
  const userId = user ? user.userId : userOrUserId;
  const orgId = user ? user.orgId : null;

  const { data, error } = await admin
    .from('generations')
    .insert({
      user_id: userId,
      org_id: orgId,
      prompt: payload.prompt,
      user_prompt: payload.userPrompt,
      category: payload.category,
      background: payload.background,
      aspect_ratio: payload.aspectRatio,
      ref_images: payload.refImages || {},
      acc_images: payload.accImages || {},
      fashion_model_id: payload.fashionModelId || null,
      total_cost: payload.totalCost || 0,
    })
    .select('id')
    .single();

  if (error) throw new Error('Generation record failed: ' + error.message);
  return data;
}

export async function recordGenerationResult(generationId, userOrUserId, result) {
  const admin = await getSupabaseAdmin();
  if (!admin) return { id: 'demo-r-' + Date.now() };

  const user = typeof userOrUserId === 'object' ? userOrUserId : null;
  const userId = user ? user.userId : userOrUserId;
  const orgId = user ? user.orgId : null;

  const { data, error } = await admin
    .from('generation_results')
    .insert({
      generation_id: generationId,
      user_id: userId,
      org_id: orgId,
      model_key: result.modelKey,
      image_url: result.imageUrl,
      cost: result.cost || 0,
      error_message: result.error || null,
      meta: result.meta || {},
    })
    .select('id')
    .single();

  if (error) throw new Error('Result record failed: ' + error.message);
  return data;
}
