# Insights & Analytics

MODLai extends beyond generation into **AI-driven merchandising**: pull your store's product, order, and customer data, then get Claude-powered diagnoses and recommendations on what's working and what needs improvement.

## What this gives you

### Phase 1 (implemented) — Data Sync + Dashboard
- Sync products, orders, customers from Shopify (and Faire Phase 4)
- Dashboard with KPIs: revenue, orders, AOV, product count
- Top performers (by revenue, last 30d)
- Underperformers (active, 0 orders)
- Category breakdown
- Daily aggregation in `product_analytics_daily`

### Phase 2 (implemented) — AI Product Diagnosis
- [AI 진단] button on each product
- Claude (vision + text) analyzes:
  - **Image quality** — lighting, composition, thumbnail impact
  - **Title & copy** — keywords, clarity, benefit focus
  - **Tags & categorization**
  - **Pricing** — based on positioning signals
  - **Sales metrics** — conversion gaps, views-to-purchase
- Returns structured output:
  - Overall score (0-100)
  - Issues (with severity + evidence)
  - Strengths
  - Recommendations (with estimated impact + suggested prompts)
- Costs 20 credits per diagnosis; results cached in `ai_diagnoses`

### Phase 3 (future) — Action Loop
Wired into recommendations:
- Each recommendation has `action_type`: `regenerate_image`, `rewrite_title`, `rewrite_description`, `update_tags`, `adjust_price`, `run_ab_test`
- [AI로 개선] button → triggers generation with suggested prompt
- Diff view vs original → Publish directly to replace

### Phase 4 (future) — B2B Buyer Analysis (Faire)
- Aggregate Faire retailer order history
- Profile each buyer: preferred styles, prices, seasons
- Generate targeted catalogs per buyer segment
- Auto-draft Faire messages for top buyers

## Architecture

The same abstraction pattern as `PaymentProvider` and `PublishChannel`:

```
PlatformDataSource (abstract)   [_lib/datasources/platform-datasource.js]
├── ShopifyDataSource            [shopify-datasource.js] — implemented
├── FaireDataSource              [faire-datasource.js] — stub
├── MagentoDataSource            — future
└── FashionGoDataSource          — future (likely CSV-based)
```

**Note**: `PublishChannel` writes TO platforms; `PlatformDataSource` reads FROM platforms. A platform can support both (Shopify), only one, or neither.

## Data Flow

```
Cron job every 6h
        │
        ▼
Loop through all active channel_connections
        │
        ▼
For each user+channel, sync products → customers → orders
        │
        ▼
Normalize to platform-agnostic rows → upsert into external_* tables
        │
        ▼
Rebuild product_analytics_daily from order items
        │
        ▼
product_performance view updates automatically
```

## Tables

| Table | Purpose |
|---|---|
| `external_products` | Cached products from channels; linked to `generations` via `modlai_generation_id` if published from MODLai |
| `external_customers` | Cached customers (emails hashed, display names safe) |
| `external_orders` | Order headers |
| `external_order_items` | Line items per order (joined to products) |
| `product_analytics_daily` | Daily rollup per product (orders, units, revenue, views) |
| `ai_diagnoses` | Cached Claude analyses per product |
| `ai_recommendations` | Top-level store recommendations |
| `sync_jobs` | Sync history + status |
| `buyer_profiles` | (Phase 4) Aggregated B2B buyer profiles |

Plus the `product_performance` view, which pre-joins products with 30-day analytics.

## API endpoints

### Sync
- `POST /api/datasources/sync` — trigger a sync (body: `{ channel, entity, incremental }`)
- `GET /api/datasources/status` — last sync status + counts
- `GET /api/datasources/cron` — scheduled job (Vercel cron; every 6 hours)

### Insights
- `GET /api/insights/dashboard` — KPIs + top/under performers + recs
- `GET /api/insights/products` — paginated product list with performance data
- `POST /api/insights/diagnose` — run Claude diagnosis on a product (20 credits)

## Credit costs

| Action | Credits |
|---|---|
| AI product diagnosis | 20 |
| Sync (free) | 0 |
| Future: AI image regeneration from rec | 30 (same as normal generate) |
| Future: AI copy rewrite | 10 (same as description) |

## Shopify scopes required

When user connects Shopify, ask for these scopes:
- `read_products`, `write_products`
- `read_orders`
- `read_customers`
- `read_analytics` (optional, for native views/conversion data)
- `read_inventory`

These are in addition to the publishing scopes already needed.

## Scheduling

Sync runs automatically every 6 hours via Vercel cron (`vercel.json`):
```json
"crons": [
  { "path": "/api/datasources/cron", "schedule": "0 */6 * * *" }
]
```

Users can also trigger manual syncs from the Insights view via the [동기화] button.

For extra safety, set a `CRON_SECRET` env var; the cron endpoint requires either Vercel's internal cron header OR `Authorization: Bearer <secret>`.

## AI diagnosis design notes

**Why Claude over cheaper models?**
- Multimodal (image + text + numbers) in one call
- Better at nuanced merchandising advice
- Can reference specific image details ("the dark background in position 2 hides the texture")

**Why cache diagnoses?**
- Product data doesn't change often
- Users can re-run ("재진단") explicitly when they've made changes
- Saves credits + API cost

**Why return structured JSON?**
- Lets the UI render pretty cards per issue/rec
- Enables action buttons that pass `suggested_prompt` straight into Generate
- Future: automated prioritization based on severity + impact

## Privacy considerations

- **Email addresses are hashed** (SHA256) before storage; only display names (like "Catherine S.") are stored raw
- **Raw payloads are stored in JSONB** for debugging but never shown to users
- **RLS** ensures users only see their own external data
- **Cancelled orders** are excluded from analytics aggregation
- **Buyer PII from Faire** (when Phase 4 lands) is heavily restricted — aggregate-only

## Limitations

**Data volume for new brands**
Stores with < ~$5k/mo in sales won't have enough data for statistical significance. The AI diagnosis works regardless (image/copy quality is evaluable without sales data), but the "underperformers" list becomes noisy.

**Rate limits**
Large catalogs (10k+ products) will take multiple cron runs to fully sync initially. The sync engine caps per-run at 40 pages × 250 items = 10k items. Set `MAX_PAGES_PER_SYNC` higher in `sync-engine.js` if needed.

**Shopify views/conversion data**
Native Analytics API exposure varies by plan. If `read_analytics` scope isn't granted or the plan doesn't include it, views/conv_rate columns will be null. Orders/revenue always work.

**Faire read API**
Largely stubbed in Phase 1-2. Full implementation lands in Phase 4, once Faire API docs are received after partnership approval.

## Next: Phase 3 implementation sketch

For when you're ready to build the action loop:

1. Each diagnosis recommendation has `action_type` and `suggested_prompt`
2. Add a "[AI로 개선]" button to each rec that:
   - For `regenerate_image` → opens Generate view with the product's current image as `refImages.main` and `suggested_prompt` pre-filled
   - For `rewrite_title`/`rewrite_description` → calls Claude to generate 3 variants, shows diff view
   - For `update_tags` → shows current vs suggested tags side-by-side
   - For `adjust_price` → shows current vs suggested with price impact preview
3. After user approves, use existing Publish flow to push update back to Shopify (requires adding an "update existing" path to `ShopifyChannel.publish()`)
4. Log every action to `ai_action_history` (new table) for outcome tracking
