// Import engine — takes parsed rows + mapping + granularity, writes to product_masters.

import { getSupabaseAdmin } from '../utils.js';
import { detectGranularity } from './file-parser.js';

const SIZE_ORDER = { 'XS':0,'XXS':-1,'S':1,'M':2,'L':3,'XL':4,'XXL':5,'XXXL':6,
                     '0':0,'2':2,'4':4,'6':6,'8':8,'10':10,'12':12,'14':14,
                     '24':24,'25':25,'26':26,'27':27,'28':28,'29':29,'30':30,'31':31,'32':32,'34':34 };

/**
 * Apply mapping to source rows — produce normalized rows keyed by target field names.
 */
export function applyMapping(sourceRows, mapping) {
  return sourceRows.map(srcRow => {
    const out = {};
    for (const [srcCol, targetField] of Object.entries(mapping)) {
      if (targetField && srcRow[srcCol] != null && String(srcRow[srcCol]).trim() !== '') {
        out[targetField] = srcRow[srcCol];
      }
    }
    return out;
  });
}

/**
 * Parse a price value (may be "$44.00", "44", 44, "44.50", "44,000" KRW style, etc.)
 * Returns cents (int) or null.
 */
export function parsePrice(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Math.round(value * 100);
  const s = String(value).trim().replace(/[$£€¥₩,\s]/g, '');
  if (!s) return null;
  const n = parseFloat(s);
  if (isNaN(n)) return null;
  return Math.round(n * 100);
}

function parseInt10(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = parseInt(s, 10);
  return isNaN(n) ? null : n;
}

function parseDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  // Try ISO first
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function sizeOrderFor(size) {
  if (!size) return 999;
  const up = String(size).toUpperCase().trim();
  if (SIZE_ORDER[up] != null) return SIZE_ORDER[up];
  const n = parseInt(up, 10);
  if (!isNaN(n)) return n;
  return 500; // unknown, sort toward end
}

/**
 * Main import function. Takes already-parsed + mapped rows and inserts into DB.
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.importJobId
 * @param {Array<Record<string,any>>} opts.normalizedRows  — rows keyed by target field names
 * @param {'master'|'master_with_variants'} opts.granularity
 * @param {boolean} opts.dryRun  — if true, validate + return counts without writing
 */
export async function runImport({ userId, orgId, importJobId, normalizedRows, granularity, dryRun = false }) {
  const admin = await getSupabaseAdmin();
  if (!admin) throw new Error('Database not configured');

  const results = {
    masters_created: 0,
    masters_updated: 0,
    variants_created: 0,
    rows_skipped: 0,
    errors: [],
  };

  // Group rows by (style, color). This handles both granularities:
  //  - master: each group has 1 row, no size info
  //  - master_with_variants: each group has 1+ rows, each with distinct size
  const groups = {};
  for (let i = 0; i < normalizedRows.length; i++) {
    const row = normalizedRows[i];
    const style = (row.style_number || '').toString().trim();
    if (!style) {
      results.rows_skipped++;
      results.errors.push({ row_index: i, error_message: 'Missing style_number' });
      continue;
    }
    const color = (row.color || '').toString().trim();
    const key = `${style}::${color}`;
    if (!groups[key]) groups[key] = { style, color, masterRow: null, variantRows: [] };

    if (granularity === 'master_with_variants' && row.size) {
      groups[key].variantRows.push({ ...row, _sourceIndex: i });
      // First row with a size also provides master-level fields
      if (!groups[key].masterRow) groups[key].masterRow = row;
    } else {
      // For master-level, or rows without size even in variant-level files
      if (groups[key].masterRow) {
        // Same (style, color) already seen — skip as duplicate master
        results.rows_skipped++;
        results.errors.push({ row_index: i, error_message: `Duplicate master for ${style}/${color}` });
      } else {
        groups[key].masterRow = row;
      }
    }
  }

  // Upsert each master
  for (const group of Object.values(groups)) {
    const r = group.masterRow || group.variantRows[0];
    if (!r) continue;

    const masterRow = {
      user_id: userId,
      org_id: orgId,
      style_number: String(r.style_number || group.style).trim(),
      color: group.color || null,
      name: r.name || null,
      description: r.description || null,

      category:     r.category || null,
      subcategory:  r.subcategory || null,
      division:     r.division || null,
      subdivision:  r.subdivision || null,
      season:       r.season || null,

      wholesale_price_cents: parsePrice(r.wholesale_price),
      retail_price_cents:    parsePrice(r.retail_price),
      cost_cents:            parsePrice(r.cost),
      currency:              (r.currency || 'usd').toString().toLowerCase().slice(0, 3),

      available_date:   parseDate(r.available_date),
      start_sell_date:  parseDate(r.start_sell_date),
      vendor:           r.vendor || null,
      country_of_origin: r.country_of_origin || null,
      hs_tariff_no:     r.hs_tariff_no || null,
      fabric_content:   r.fabric_content || null,
      fabric_type:      r.fabric_type || null,
      weight_grams:     parseInt10(r.weight_grams),

      prepack:          r.prepack || null,
      size_category:    r.size_category || null,
      pack_quantity:    parseInt10(r.pack_quantity),
      min_order_qty:    parseInt10(r.min_order_qty),

      source_import_id: importJobId,
      source_row_index: r._sourceIndex ?? null,
      status: 'active',
    };

    if (dryRun) {
      results.masters_created++; // rough estimate
      continue;
    }

    try {
      const { data: upserted, error } = await admin
        .from('product_masters')
        .upsert(masterRow, { onConflict: 'user_id,style_number,color' })
        .select('id, created_at, updated_at')
        .single();

      if (error) {
        results.errors.push({ row_index: r._sourceIndex ?? -1, error_message: error.message });
        continue;
      }

      // Track create vs update
      if (upserted.created_at === upserted.updated_at) results.masters_created++;
      else results.masters_updated++;

      // Variants
      if (group.variantRows.length > 0) {
        // Delete old variants for clean re-import
        await admin.from('product_master_variants')
          .delete()
          .eq('master_id', upserted.id);

        const variantInserts = group.variantRows.map(vr => ({
          user_id: userId,
          org_id: orgId,
          master_id: upserted.id,
          sku: vr.sku || buildSku(masterRow.style_number, masterRow.color, vr.size),
          size: vr.size ? String(vr.size).trim() : null,
          size_order: sizeOrderFor(vr.size),
          prepack_qty: parseInt10(vr.prepack) || 0,
          inventory_qty: parseInt10(vr.inventory_qty) || 0,
          wholesale_price_cents: parsePrice(vr.wholesale_price),
          retail_price_cents: parsePrice(vr.retail_price),
        }));

        // Deduplicate by size (keep first)
        const seen = new Set();
        const unique = variantInserts.filter(v => {
          if (!v.size) return true; // allow size-less
          if (seen.has(v.size)) return false;
          seen.add(v.size);
          return true;
        });

        if (unique.length > 0) {
          const { error: vErr, count: vCount } = await admin
            .from('product_master_variants')
            .insert(unique);
          if (vErr) {
            results.errors.push({ row_index: -1, error_message: `Variant insert failed: ${vErr.message}` });
          } else {
            results.variants_created += unique.length;
          }
        }
      }
    } catch (err) {
      results.errors.push({ row_index: r._sourceIndex ?? -1, error_message: err.message });
    }
  }

  return results;
}

function buildSku(style, color, size) {
  const parts = [style];
  if (color) parts.push(String(color).toUpperCase().replace(/\s+/g, ''));
  if (size)  parts.push(String(size).toUpperCase().replace(/\s+/g, ''));
  return parts.join('-');
}
