# Multi-Tenancy (Organizations)

MODLai supports multiple companies (organizations) on a single deployment. Each brand gets their own isolated:

- Product catalog (masters, variants, generations)
- Channel connections (Shopify, Faire)
- AI Fashion Models + Character Sheets
- Credit pool (shared across all org members)
- Sales data & AI diagnoses

## Core concepts

### Organization = tenant
An organization is a company. All data is scoped to an `org_id`. Users can access data only through their org membership.

### 1 user = 1 organization (with one exception)
A regular user can belong to exactly one organization at a time — enforced at the DB level with a unique index on `organization_members(user_id) where status = 'active'`.

**Exception**: Platform admins (`users.is_admin = true`) can cross into any organization by sending `X-Org-Id: <uuid>` header. This is for support & debugging. There's only meant to be one platform admin — you, the MODLai operator.

### Roles within an org

| Role | Can do |
|---|---|
| `owner` | Everything. Only owners can delete the org or demote/remove other owners. |
| `admin` | Manage members, invitations, channel connections, settings. Cannot delete org. |
| `member` | Generate images, import products, publish — but cannot touch org settings. |

At least one owner is required — the DB prevents demoting/removing the last one.

### Credit pool
Credits belong to the organization, not individual users. When any member runs a generation:
1. Credits deducted from `organizations.credits_balance`
2. Transaction logged in `credit_transactions` with `user_id` (who did it) + `org_id` (pool it came from)

## Database architecture

```
organizations (tenant)
    │
    ├── organization_members (user ↔ org with role)
    ├── organization_invitations (pending email invites)
    └── data tables — all have org_id FK:
        ├── product_masters, product_master_variants
        ├── generations, generation_results
        ├── fashion_models
        ├── channel_connections
        ├── publishings, external_products, external_orders
        ├── ai_diagnoses, ai_recommendations
        ├── import_jobs, sync_jobs
        ├── credit_transactions
        └── (22 tables total)
```

## How RLS (Row Level Security) works

Every data table has this pattern:

```sql
create policy foo_org_all on public.foo
  for all using (
    (org_id is null and auth.uid() = user_id)                 -- legacy rows (grace period)
    or (org_id is not null and public.can_access_org(auth.uid(), org_id))
  );
```

The `can_access_org()` function returns true if:
1. User is a platform admin (`users.is_admin = true`), OR
2. User has an active membership in the org

So even if someone finds a way to call the database directly, they can only see their own org's data.

## How auth flows

```
POST /api/generate/nanobanana with Bearer token
    ↓
requireAuth(req)
    ↓ Verifies JWT with Supabase
    ↓ Fetches user profile
    ↓ Looks up active organization_members row
    ↓ Returns { userId, email, orgId, orgRole, orgCredits, isPlatformAdmin }
    ↓
requireOrg(user) throws if no org context
    ↓
Endpoint uses orgId for all DB queries + deductCredits(user, ...)
    ↓
deductCredits sees user.orgId and uses org pool
```

## API endpoints

### Organizations
| Method | Path | Description |
|---|---|---|
| GET | `/api/organizations` | Current user's active org (or null) |
| POST | `/api/organizations` | Create new org (becomes owner, 100 cr bonus) |
| GET | `/api/organizations/:id` | Org details + stats |
| PATCH | `/api/organizations/:id` | Update name, logo, settings |

### Members
| Method | Path | Description |
|---|---|---|
| GET | `/api/organizations/:id/members` | List members |
| POST | `/api/organizations/:id/members` | Change role `{userId, role}` |
| DELETE | `/api/organizations/:id/members?userId=...` | Remove member |

### Invitations
| Method | Path | Description |
|---|---|---|
| GET | `/api/organizations/:id/invitations` | Pending invites |
| POST | `/api/organizations/:id/invitations` | Invite by email `{email, role}` |
| DELETE | `/api/organizations/:id/invitations?inviteId=...` | Revoke |
| POST | `/api/invitations/accept` | Accept with `{token}` |

## Onboarding flow for new users

```
1. User signs up via Supabase Auth (email / Google)
     ↓
2. Frontend calls GET /api/organizations
     ↓ returns { organization: null }
     ↓
3. Frontend shows "Create organization" onboarding screen
     ↓ User enters "My Brand"
     ↓
4. POST /api/organizations { name: "My Brand" }
     ↓ Backend creates org, adds user as owner, gives 100 credit welcome bonus
     ↓
5. User is redirected to main app
```

## Invitation flow

```
Admin in Settings → Members tab:
     "Invite by email: colleague@brand.com, role: member"
     ↓
POST /api/organizations/:id/invitations
     ↓ Creates invite with random 24-byte token, 7-day expiry
     ↓ Returns { invite_url: 'https://app/invite/<token>' }
     ↓
Admin shares URL manually
     (email sending not yet integrated — TODO: Resend/SendGrid)
     ↓
Recipient signs up OR logs in
     ↓
Frontend detects /invite/<token> URL param
     ↓
POST /api/invitations/accept { token }
     ↓ Backend verifies email matches + not in another org + not expired
     ↓ Creates organization_members row
     ↓ Sets users.active_org_id
     ↓
User is now a member
```

## Platform admin override

Anthropic-side support/debugging:

```javascript
// You're logged in as a platform admin
fetch('/api/imports/masters', {
  headers: {
    'Authorization': 'Bearer <admin_jwt>',
    'X-Org-Id': '<target_org_uuid>',   // ← this bypasses membership check
  }
})
```

Platform admins see a separate "Admin" dashboard at `/admin.html` with:
- List of all organizations
- Sub-into any org (`X-Org-Id` header)
- View credit usage, suspend orgs, etc

## Data preservation

Every org-scoped FK uses `ON DELETE CASCADE` for org deletion — meaning if you delete an org, everything under it is cleaned up. But the DB never deletes orgs automatically; they're marked `is_active = false`.

Within an org, individual products use soft delete:
- `product_masters.is_archived = true` — recoverable from Archive list
- `product_masters.deleted_at` timestamp — permanent delete (cannot be recovered from UI)

## Migration strategy (for existing users)

If you already have data from before migration-008:
1. The old rows still have `org_id = null`, `user_id = <actual user>`
2. RLS policies allow these to be seen by their original user (`org_id is null and auth.uid() = user_id`)
3. To migrate: for each such user, create an org, set their `active_org_id`, and update all their rows with the new org_id

Not automated yet — do manually via SQL if you have existing users.
