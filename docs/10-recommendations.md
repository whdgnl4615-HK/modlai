# AI Recommendation Application

The "loop" from AI diagnosis back to real-world product updates.

## The full cycle

```
  ┌───────────────────────────────────────────────┐
  │ 1. User runs AI Diagnosis on a product        │
  │    → Claude analyzes image + copy + data      │
  │    → Returns { score, issues[], recs[] }      │
  └───────────────────────────────────────────────┘
                     │
                     ▼
  ┌───────────────────────────────────────────────┐
  │ 2. Each rec has action_type:                  │
  │    - regenerate_image                         │
  │    - rewrite_title                            │
  │    - rewrite_description                      │
  │    - update_tags                              │
  │    - adjust_price                             │
  └───────────────────────────────────────────────┘
                     │
                     ▼
  ┌───────────────────────────────────────────────┐
  │ 3. User clicks "Apply to site"                │
  │    → POST /recommendations/apply (action=preview)│
  │    → Claude generates 3 variants (for text)   │
  │    → Or shows current vs suggested (tags/price)│
  └───────────────────────────────────────────────┘
                     │
                     ▼
  ┌───────────────────────────────────────────────┐
  │ 4. User picks a variant / approves            │
  │    → POST /recommendations/apply (action=apply)│
  │    → Backend updates local DB                 │
  │    → Pushes change to Shopify/Faire           │
  │    → Records in recommendation_applications   │
  └───────────────────────────────────────────────┘
                     │
                     ▼
  ┌───────────────────────────────────────────────┐
  │ 5. (Future) Impact measurement                │
  │    → Compare post-change metrics to baseline  │
  │    → Store in impact_summary jsonb            │
  └───────────────────────────────────────────────┘
```

## Action types

### `regenerate_image`
Jumps directly to the Generate view with the suggested prompt pre-filled.
The generated image gets automatically linked to the master via `state.pendingMasterId`.

No preview step — user just clicks through to Generate.

### `rewrite_title` / `rewrite_description`
1. Preview: Claude generates 3 alternative versions based on the original + the AI diagnosis reasoning
2. User picks one (or types their own in the variant field)
3. Apply: updates `external_products.title` / `body_html` locally + pushes to Shopify

Claude prompt engineering:
- **Titles**: SEO-optimized, <70 chars, searchable keywords, premium tone
- **Descriptions**: 80-150 words, hook-first, fit/material/styling woven in, subtle CTA

### `update_tags`
1. Preview: shows current tags + suggested tags with add/remove/keep labels
2. User toggles checkboxes to cherry-pick
3. Apply: updates `external_products.tags` + pushes to Shopify

### `adjust_price`
1. Preview: shows current price, suggested price, % delta, and impact estimate
2. User confirms
3. Apply: updates price on all variants (for Shopify) + pushes

## Database: `recommendation_applications`

Every application is recorded for audit and future impact measurement:

```sql
recommendation_applications (
  id uuid,
  org_id uuid,                       -- who applied
  user_id uuid,                      -- who applied (can be null if user deleted)
  applied_by_email text,             -- snapshot in case user is gone
  diagnosis_id uuid,                 -- which AI analysis
  recommendation_index int,          -- which rec in that analysis
  action_type text,
  master_id uuid,                    -- target master (or null)
  product_id uuid,                   -- target external product (or null)
  before_state jsonb,                -- full snapshot before change
  after_state jsonb,                 -- full snapshot after change
  pushed_to_channel text,            -- shopify | faire | null
  push_status text,                  -- pending | pushed | failed | skipped
  push_error text,
  external_id text,                  -- updated product id on channel
  impact_measured_at timestamptz,
  impact_summary jsonb,              -- filled later by measurement job
  created_at timestamptz
)
```

## API endpoints

### `POST /api/recommendations/apply`
**Preview mode:**
```json
// Request
{
  "diagnosisId": "uuid",
  "recommendationIndex": 2,
  "action": "preview"
}
// Response (for rewrite_title)
{
  "ok": true,
  "actionType": "rewrite_title",
  "preview": {
    "current": "Cute T-shirt",
    "variants": [
      "Organic Cotton Relaxed-Fit Tee",
      "Essential Everyday Jersey Tee",
      "Signature Soft-Cotton T-Shirt"
    ]
  }
}
```

**Apply mode:**
```json
// Request
{
  "diagnosisId": "uuid",
  "recommendationIndex": 2,
  "action": "apply",
  "customValue": "Organic Cotton Relaxed-Fit Tee"
}
// Response
{
  "ok": true,
  "applicationId": "uuid",
  "pushResult": {
    "channel": "shopify",
    "status": "pushed",
    "externalId": "12345"
  },
  "before": { "title": "Cute T-shirt", ... },
  "after":  { "title": "Organic Cotton Relaxed-Fit Tee", ... }
}
```

### `GET /api/recommendations/history`
Paginated list of past applications for the org.

## Channel adapter requirements

For an application to push to a channel, the channel adapter must implement `updateProduct`:

```js
async updateProduct({ credentials, externalId, patch }) {
  // patch may contain: title, body_html, tags, price_cents
  // Return: { externalId, externalUrl }
}
```

Currently implemented:
- ✅ Shopify (title, body_html, tags, price via variant update)
- ❌ Faire (no public update API yet — skipped with status='skipped')

## UI state flow

```javascript
// After diagnosis
window._currentDiagnosis = diagnosis;  // for Apply buttons

// User clicks Apply on rec index 2
applyRecommendation(2)
  → if (regenerate_image) jump to Generate + fill prompt
  → else open Apply modal
       → fetch preview
       → render variants with selection UI
       → on confirm: commitApply(idx, chosen_value)
          → POST /recommendations/apply (action=apply)
          → toast result
          → close modal
```

## Failure modes handled

| Scenario | Behavior |
|---|---|
| No channel connected | Apply succeeds locally, `push_status='skipped'` |
| Channel API returns 4xx | Apply succeeds locally, `push_status='failed'`, error logged |
| User reduces credits below 0 | n/a (this endpoint doesn't consume credits; Claude variant gen does indirectly via the normal Claude budget) |
| Target product was archived | Update proceeds; archived products are still updatable |
| User picks empty variant | Button disabled until selection |
| Diagnosis is from another org | 404 diagnosis_not_found (RLS enforced) |

## Future enhancements

- **Bulk apply**: "apply this type of fix to all flagged products"
- **Impact measurement job**: 7-day, 30-day delta on orders/revenue after apply
- **Rollback**: one-click revert using `before_state`
- **A/B test mode**: apply variant A to half of traffic, measure
- **Auto-apply mode**: for high-confidence actions (>90% predicted lift), skip preview
