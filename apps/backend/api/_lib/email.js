// Email sending via Resend.
// https://resend.com/docs — Free tier: 3,000/month, 100/day.
//
// Setup:
//   1. Sign up at resend.com, verify your domain
//   2. Get API key from dashboard
//   3. Add to .env:
//        RESEND_API_KEY=re_xxx
//        RESEND_FROM=MODLai <noreply@yourdomain.com>
//
// If RESEND_API_KEY is not set, sendEmail() returns { skipped: true } without throwing.
// This lets the app keep working in dev/demo without email configured.

const RESEND_API = 'https://api.resend.com/emails';

/**
 * Send an email via Resend.
 * @returns {Promise<{ok, id?, skipped?, error?}>}
 */
export async function sendEmail({ to, subject, html, text, from, replyTo, tags }) {
  const apiKey = process.env.RESEND_API_KEY;
  const defaultFrom = process.env.RESEND_FROM || 'MODLai <noreply@modlai.local>';

  if (!apiKey) {
    console.warn('[email] RESEND_API_KEY not set. Skipping email:', subject, '→', to);
    return { ok: false, skipped: true, reason: 'no_api_key' };
  }

  try {
    const response = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: from || defaultFrom,
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
        text,
        reply_to: replyTo,
        tags: tags ? tags.map(t => ({ name: t, value: '1' })) : undefined,
      }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error('[email] send failed:', response.status, data);
      return { ok: false, error: data.message || `HTTP ${response.status}` };
    }

    return { ok: true, id: data.id };
  } catch (err) {
    console.error('[email] exception:', err);
    return { ok: false, error: err.message };
  }
}

// ──────────────────────────────────────────────
// TEMPLATES
// Kept minimal and inline — no external templating engine.
// ──────────────────────────────────────────────

const BRAND_GREEN = '#2d5a35';
const BRAND_CREAM = '#f2f5f0';

function wrap(title, innerHtml) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:${BRAND_CREAM};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:40px 20px;">
    <div style="background:#fff;border:1px solid #e0e0d8;border-radius:14px;padding:36px 32px;">
      <div style="font-family:Georgia,serif;font-size:30px;font-weight:500;letter-spacing:-0.02em;margin-bottom:28px;">
        MOD<em style="font-style:italic;color:${BRAND_GREEN};">L</em>ai
      </div>
      ${innerHtml}
    </div>
    <div style="text-align:center;margin-top:20px;font-size:11px;color:#888;">
      © MODLai · AI-powered fashion imagery
    </div>
  </div>
</body></html>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

export function renderInviteEmail({ orgName, inviterEmail, role, inviteUrl }) {
  const html = wrap(`Invitation to join ${orgName}`, `
    <h2 style="font-family:Georgia,serif;font-weight:500;font-size:22px;margin:0 0 14px;">You've been invited</h2>
    <p style="color:#333;font-size:14px;line-height:1.6;margin:0 0 18px;">
      <strong>${escapeHtml(inviterEmail)}</strong> invited you to join
      <strong>${escapeHtml(orgName)}</strong> on MODLai as a <strong>${escapeHtml(role)}</strong>.
    </p>
    <p style="color:#666;font-size:13px;line-height:1.6;margin:0 0 22px;">
      MODLai lets fashion brands generate AI imagery, import product catalogs, publish to Shopify and Faire, and get AI-powered recommendations to optimize listings.
    </p>
    <a href="${inviteUrl}" style="display:inline-block;background:${BRAND_GREEN};color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:500;">
      Accept invitation →
    </a>
    <p style="color:#999;font-size:11px;line-height:1.5;margin:22px 0 0;">
      This invitation expires in 7 days. If the button doesn't work, copy and paste this URL:<br>
      <span style="word-break:break-all;color:#666;">${inviteUrl}</span>
    </p>
  `);

  const text = `You've been invited to join ${orgName} on MODLai as ${role}.

Invited by: ${inviterEmail}

Accept: ${inviteUrl}

This invitation expires in 7 days.`;

  return { html, text };
}

export function renderWelcomeEmail({ userEmail, orgName }) {
  const html = wrap('Welcome to MODLai', `
    <h2 style="font-family:Georgia,serif;font-weight:500;font-size:22px;margin:0 0 14px;">
      Welcome${orgName ? ` to ${escapeHtml(orgName)}` : ''}
    </h2>
    <p style="color:#333;font-size:14px;line-height:1.6;margin:0 0 14px;">
      Your MODLai workspace is ready. You've received <strong>100 welcome credits</strong> to start exploring.
    </p>
    <p style="color:#333;font-size:14px;line-height:1.6;margin:0 0 20px;">
      Here's what you can do:
    </p>
    <ul style="color:#333;font-size:13px;line-height:1.8;margin:0 0 20px;padding-left:20px;">
      <li><strong>Generate</strong> — Create AI fashion imagery from your product photos</li>
      <li><strong>Models</strong> — Train reusable fashion models with character sheets</li>
      <li><strong>Catalog</strong> — Import your product line from CSV or Excel</li>
      <li><strong>Insights</strong> — Get AI-powered recommendations for your listings</li>
    </ul>
    <p style="color:#666;font-size:12px;line-height:1.5;margin:20px 0 0;">
      Questions? Reply to this email.
    </p>
  `);
  const text = `Welcome to MODLai${orgName ? ' · ' + orgName : ''}!

Your workspace is ready. You've received 100 welcome credits.

Get started:
- Generate: AI fashion imagery from product photos
- Models: Reusable character sheets
- Catalog: Import your product line
- Insights: AI recommendations

Questions? Reply to this email.`;
  return { html, text };
}
