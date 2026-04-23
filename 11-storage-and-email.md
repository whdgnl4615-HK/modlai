# Storage & Email Setup

Two services power reliable production operation:
- **Supabase Storage** — persistent hosting for AI-generated images (needed for Faire publishing, embedding in emails, etc.)
- **Resend** — transactional email (invitations, welcome messages)

Both are optional during development — MODLai degrades gracefully if either is missing.

## Supabase Storage

### Why
AI generation endpoints (Nano Banana / OpenAI / Stability / Edit) originally returned `data:` URLs. These are huge (1-2MB base64 strings), can't be embedded in emails, and **Faire rejects them** when publishing products. Proper hosted URLs are required.

### Setup

1. **Create the storage buckets in Supabase**
   - Open the Supabase dashboard → Storage
   - Create bucket `generated-images` (public)
   - Create bucket `user-uploads` (private — for source images user uploads)

   Or run in SQL Editor:
   ```sql
   -- Already included in schema-storage.sql (section 3 of supabase setup)
   insert into storage.buckets (id, name, public)
   values
     ('generated-images', 'generated-images', true),
     ('user-uploads', 'user-uploads', false)
   on conflict do nothing;
   ```

2. **Configure RLS policies**
   See `apps/backend/supabase/schema-storage.sql` — grants authenticated users read/write access to their own folder (`{userId}/…`).

3. **No code change needed** — the `uploadGeneratedImage()` helper in `_lib/utils.js` is already called by:
   - `api/generate/nanobanana.js`
   - `api/generate/openai.js`
   - `api/generate/stability.js`
   - `api/edit.js`
   - `api/models/[id]/generate-sheet.js` (character sheets)

### Folder structure

```
generated-images/
  {userId}/
    generate/            ← from /api/generate/*
      {uuid}.png
      {uuid}.jpg
    edit/                ← from /api/edit.js
      {uuid}.png
    character-sheet/     ← from /api/models/:id/generate-sheet.js
      {uuid}-front.png
      {uuid}-34.png
      {uuid}-side.png
      {uuid}-back.png
```

### Fallback behavior

If Supabase credentials aren't set OR the upload fails, each endpoint falls back to returning a `data:` URL:

```javascript
let imageUrl;
try {
  imageUrl = await uploadGeneratedImage(user.userId, b64, mimeType, { ... });
} catch (uploadErr) {
  console.warn('[stability] storage upload failed, falling back to data URL');
  imageUrl = `data:image/png;base64,${b64}`;
}
```

This keeps local dev smooth — you don't need Supabase configured just to play with AI generation. But **in production, storage must work** for Faire to accept publishes.

### Verify it's working

After deployment, generate an image in the UI and open DevTools Network tab. The returned `imageUrl` should look like:
```
https://<your-project>.supabase.co/storage/v1/object/public/generated-images/<uuid>/generate/<image>.png
```

Not:
```
data:image/png;base64,iVBORw0KG...   ❌ means storage isn't working
```

---

## Resend (Email)

### Why
Two things need email to work:
- **Organization invitations** — admin clicks "Invite by email" → recipient gets a real email with a branded invite link
- **Welcome messages** — new signups get a welcome email with feature highlights

Without Resend configured, invitations still work but the admin has to **manually copy & share** the invite URL (a `prompt()` dialog pops up with the link).

### Setup (5 min)

1. **Sign up at resend.com** (free tier: 3,000 emails/month, 100/day)

2. **Verify a domain**
   - Add a domain you own (e.g. `modlai.com`)
   - Add the 3 DNS records Resend shows you (SPF, DKIM, DMARC)
   - Wait ~15 min for verification

3. **Get API key**
   - API Keys → Create API Key
   - Starts with `re_...`

4. **Add to backend `.env`**
   ```
   RESEND_API_KEY=re_xxxxxxxxxxxxxxxx
   RESEND_FROM=MODLai <noreply@modlai.com>
   ```
   The "from" address MUST use the domain you verified in step 2.

5. **Set FRONTEND_URL** to your production app URL (used in invitation links):
   ```
   FRONTEND_URL=https://app.modlai.com
   ```

### Fallback behavior

When `RESEND_API_KEY` is missing, `sendEmail()` logs a warning and returns `{ ok: false, skipped: true }`. No exception is thrown, so the app keeps working.

The invitation endpoint inspects this result:

```javascript
const emailResult = await sendEmail({ to, subject, html, ... });

return {
  invitation: {...},
  invite_url: inviteUrl,
  email_sent: emailResult.ok === true,
  email_skipped: emailResult.skipped === true,
  note: emailResult.ok ? 'Invitation email sent.'
       : emailResult.skipped ? 'Email not configured. Share manually.'
       : 'Email send failed.',
};
```

The frontend's `sendInvite()` handler then shows the appropriate toast:
- `email_sent: true` → "Invitation emailed to X" ✓
- `email_skipped: true` → "Email not configured. Copy the link below." → shows `prompt()` with URL
- otherwise → "Email delivery failed. Copy link manually." → shows `prompt()` with URL

### Templates

Two transactional templates in `api/_lib/email.js`:

| Function | Trigger | Example subject |
|---|---|---|
| `renderInviteEmail()` | Admin invites new member | `You're invited to Acme Brand on MODLai` |
| `renderWelcomeEmail()` | New org created (signup flow) | `Welcome to Acme Brand on MODLai` |

Both use branded HTML (forest green + cream) with plaintext fallback. No external templating engine — just template literals.

### Adding more email types

```javascript
import { sendEmail } from '../_lib/email.js';

export function renderPasswordReset({ resetUrl }) {
  return {
    html: `...`,
    text: `Reset your password: ${resetUrl}`,
  };
}

// Then:
const { html, text } = renderPasswordReset({ resetUrl });
await sendEmail({
  to: email,
  subject: 'Reset your MODLai password',
  html, text,
  tags: ['password-reset'],
});
```

### Authentication emails (separate from Resend)

Supabase Auth handles its own emails for:
- Email confirmation on signup
- Magic link
- Password reset

These use Supabase's built-in SMTP. For production, configure custom SMTP in Supabase dashboard → Authentication → Email Templates. You can point Supabase's SMTP at Resend too if you want unified email infrastructure.

---

## Production checklist

- [ ] Supabase project created with storage buckets `generated-images` (public) and `user-uploads` (private)
- [ ] `schema-storage.sql` applied
- [ ] `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` set
- [ ] Resend account with verified domain
- [ ] `RESEND_API_KEY`, `RESEND_FROM` set
- [ ] `FRONTEND_URL` set to production app URL
- [ ] First test: generate an image → returned URL is `https://...supabase.co/...` not `data:`
- [ ] Second test: invite a colleague → they receive a branded email with working link
