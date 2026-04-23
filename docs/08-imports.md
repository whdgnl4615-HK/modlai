# Product Import (CSV / XLSX)

Bulk import your product catalog from existing ERP/WMS exports (like N41, Cloud, Fashiongo templates) into MODLai's internal product masters — then keep everything linked: import history, AI-generated images, publish status per channel, diagnoses, and error logs.

## The master is the source of truth

Once a product is in `product_masters`, it stays there **forever** (soft-deletable only). Everything else links TO the master, not the other way around. That means:

- Delete a generation? Master is untouched.
- Channel publish fails? Master keeps its data, error is logged.
- Un-sync Shopify? Master stays.
- Re-import the same file? Masters update in place (idempotent).

```
           product_masters (永久 보존)
                    │
    ┌───────────────┼───────────────┬──────────────┬──────────────┐
    │               │               │              │              │
product_master_    publishings     external_      ai_diagnoses   product_master_
  generations      (per channel)    products                        errors
  (N:M w/ role)
    │               │               │              │              │
generations      channel +        Shopify/       Claude          Auto-logged
 (AI images)    status + URL     Faire link     analysis         from failures
                + error
```

## Three-step import wizard

```
┌─────────────────────────────────────────────────────────┐
│  STEP 1: UPLOAD                                         │
│  .csv / .xlsx (up to 20MB)                              │
│  Robust CSV parsing: BOM strip + auto delimiter         │
│  (comma, tab, or semicolon)                             │
│  Backend parses + detects header row automatically      │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│  STEP 2: AI-ASSISTED MAPPING                            │
│  • Heuristic matching via aliases                       │
│  • Claude refines based on sample values                │
│  • Confidence badges per column (100% / 70% / manual)   │
│  • User can edit any mapping via dropdown               │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│  STEP 3: REVIEW + IMPORT                                │
│  • 10-row preview with final column names               │
│  • Validates required fields (style_number)             │
│  • [✓ Import 실행] writes to product_masters            │
└─────────────────────────────────────────────────────────┘
```

## Smart features

**Auto header detection**: Real-world files often have metadata rows (column widths, codes) before the actual header. The parser scores each of the first 5 rows by "header-ness" (short string labels, few numbers) and picks the best.

**Auto delimiter detection** (CSV): Tries comma, tab, and semicolon on the first non-empty line; picks whichever has the most hits.

**UTF-8 BOM stripping**: Excel's "Save as CSV" adds a BOM. We strip it silently.

**Granularity detection**: If the file has `size` mapped AND multiple rows per (style, color) with different sizes, it's treated as variant-level. Otherwise master-level. Happens automatically.

**Fashion-industry aware mapping**: Knows that:
- `price1` usually = wholesale, `sgtRetailPrice` = retail MSRP
- `Descript` = short name
- `sizecat` / `sizeCat` → size variant
- `bundle` → prepack
- `coo` = country of origin, `hsTariffNo` = HS code

Claude handles ambiguous cases by looking at sample values.

## Target schema

All imports land in `product_masters` (+ optional `product_master_variants`). Key fields:

**Core identity**
- `style_number` (required) — e.g. MC181T
- `color`, `name`, `description`

**Categorization**
- `category`, `subcategory`, `division`, `subdivision`, `season`

**Pricing** (stored in cents)
- `wholesale_price`, `retail_price`, `cost`, `currency`

**Supply chain**
- `available_date`, `start_sell_date`
- `vendor`, `country_of_origin`, `hs_tariff_no`
- `fabric_content`, `fabric_type`, `weight_grams`

**Variants (per size)**
- `size`, `sku`, `prepack`, `size_category`
- `inventory_qty`, `pack_quantity`, `min_order_qty`

Full list in `_lib/import/target-schema.js` → `TARGET_FIELDS`.

## The Catalog view

The **Catalog** tab shows all masters as cards. Each card surfaces everything at a glance:

- Primary image (from linked generation, or placeholder)
- Style # · Color · Name
- Category, season, price, variant count
- Number of AI-generated images
- **Channel badges**: 🟢 Shopify · 🟠 Faire — with colors for published / failed
- **Error indicator** if unresolved issues exist
- **AI diagnosis score** if recently diagnosed (color-coded 🟢🟠🔴)

Click any card → **Master Detail modal** showing:

- Overview (image, prices, dates, prepack, variants)
- Publish status per channel with external URLs + error messages
- Gallery of all AI-generated images (PRIMARY badge on the linked one)
- Latest AI diagnosis with top recommendations
- Unresolved errors with type / channel / message

From the detail modal:
- **[🔍 AI 진단]** — runs Claude diagnosis on the master (works even before publishing, since we have image + copy + category)
- **[✨ AI 이미지 생성]** — jumps to Generate view with fields pre-filled; generated image auto-links back as `primary`

## Master-generation linkage

The `product_master_generations` table is N:M:
- One master can have many generated images (original, "improved v2", before/after, etc)
- Role is tracked: `primary | alternative | before | after | variant`
- Setting role to `primary` automatically:
  - Updates `product_masters.primary_generation_id`
  - Updates `product_masters.primary_image_url` (via DB trigger)
  - Demotes any previous primary to `alternative`

Automatic linking happens when:
1. User clicks [Generate] from master detail → `state.pendingMasterId` is set
2. Generation completes → frontend calls `/imports/masters/:id/link-generation` with `role: 'primary'`
3. Master card now shows the generated image

## Publish status tracking

Every publish attempt (success or failure) is recorded:
- `publishings.master_id` — which master
- `publishings.status` — `pending | publishing | published | failed`
- `publishings.external_url` — the live product URL on Shopify/Faire
- `publishings.error_message` — any failure reason

A DB trigger automatically logs failed publishes into `product_master_errors` so the Catalog card can show an error badge without extra queries.

The `product_masters_with_status` view aggregates everything into a JSONB array:

```json
{
  "publish_status": [
    { "channel": "shopify", "status": "published", "external_url": "https://...", "published_at": "2025-..." },
    { "channel": "faire", "status": "failed", "error_message": "Wholesale price required" }
  ]
}
```

## AI diagnosis works on masters too

Originally `ai_diagnoses` was tied to `external_products`. Now it accepts either:

```json
// Diagnose a synced Shopify product
POST /api/insights/diagnose { "productId": "..." }

// Diagnose an internal master (even before publishing!)
POST /api/insights/diagnose { "masterId": "..." }
```

This lets brand owners get AI feedback **before** launching, not only after.

## API endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/imports/upload` | Parse file + auto-map columns |
| POST | `/api/imports/execute` | Run actual import with final mapping |
| GET  | `/api/imports/history` | Past import jobs |
| GET  | `/api/imports/masters` | List product masters with status |
| GET  | `/api/imports/masters/:id` | Single master + generations + diagnoses + errors |
| PATCH | `/api/imports/masters/:id` | Update master fields |
| DELETE | `/api/imports/masters/:id` | Soft-archive (keeps data) |
| POST | `/api/imports/masters/:id/link-generation` | Link generated image to master |
| DELETE | `/api/imports/masters/:id/link-generation` | Unlink |

## Data preservation guarantees

Every FK to a master uses `ON DELETE SET NULL` (not CASCADE), so:
- Deleting an `import_job` → master's `source_import_id` becomes null, master stays
- Deleting a `generation` → master's `primary_generation_id` becomes null, master stays, other linked generations stay
- Archiving a master → soft delete only (`is_archived = true`), hard delete not supported in UI

The `sync_master_primary_generation_trig` trigger ensures that when you promote a generation to `primary`, the master's `primary_image_url` is immediately updated with the best-rated result image, so cards refresh correctly without a re-query.

## Filters on the Catalog list

Query params supported by `GET /api/imports/masters`:
- `q` — style# / name / color search
- `category`, `season` — exact match
- `channel_status`:
  - `has_shopify` — published to Shopify
  - `has_faire` — published to Faire
  - `needs_publish` — in no channel yet
  - `has_errors` — unresolved errors exist
  - `no_generation` — no AI image yet

## Handling duplicate imports

On re-import:
- **Same (user, style, color)** → UPDATE (keeps `id`, generations, publishings, diagnoses — all linked data preserved)
- Variants are cleaned and re-inserted (idempotent)
- `import_jobs` row logs every attempt

Re-uploading the same file after fixing errors is safe and encouraged.

## File format support

- **.csv** — comma / tab / semicolon delimited, UTF-8 with or without BOM
- **.xlsx** / **.xls** / **.xlsm** — first sheet only
- **.tsv** — works via XLSX parser

## Limits

- Max file size: **20MB**
- Max rows: no hard cap, but files with 10k+ rows may hit Vercel's 120s function timeout
- Header must be in first 5 rows

## Tested with

- **N41 "Template_Style_Desktop"** — 108 rows, 42 columns, 9 actually populated. Auto-maps `style`, `color`, `Descript`, `Category`, `Season`, `Price1`, `sgtRetailPrice`, `availabledate`, `SubCategory` correctly.
- **Style_cloud.csv** — full 200+ column ERP export. Most internal ops columns remain unmapped (expected). Core product fields detected.

## Troubleshooting

**"You must map a source column to style_number"**
→ Check Step 2 — map your ID column (often "style" or "item") to Style Number.

**"Parse failed: File appears to be empty"**
→ CSV may be empty, or XLSX may have data in a non-first sheet.

**"Duplicate master for X/Y"**
→ Same style+color appeared in the same file twice without different sizes. First wins.

**CSV with tabs or semicolons not parsing**
→ Should work automatically. If not, confirm file isn't actually a broken Excel export — open in Notepad to verify it's plain text.

## Future work

- **Bulk AI image generation** — after import, "generate images for all masters with no image yet"
- **Pivot wizard** — handle size-as-columns files (size1_qty, size2_qty as columns)
- **Image column** — if file has image URLs, auto-fetch + link
- **CSV export** — roundtrip: export current catalog back to CSV
- **Cross-session diff** — "these 8 styles weren't in today's upload — archive them?"
