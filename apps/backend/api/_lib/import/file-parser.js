// File parsing + smart header detection for product imports.
// Handles: .csv, .tsv, .xlsx, .xls
//
// Real-world files don't always have headers on row 1. Common patterns:
//   - Row 0: column widths / internal codes (e.g. "20, 30, 200, ...")
//   - Row 1: actual field names (e.g. "style, color, Descript, ...")
//   - Row 2+: data
//
// We detect the header row by looking for the one with the most string-like,
// non-numeric, non-date values.

import * as XLSX from 'xlsx';

const MAX_PREVIEW_ROWS = 10;
const MAX_HEADER_CANDIDATE_ROWS = 5;  // try first 5 rows for header
const MAX_SAMPLE_VALUES = 5;          // samples per column

/**
 * Parse a file buffer (CSV or XLSX) and return structured data.
 *
 * @param {Buffer} buffer
 * @param {string} filename
 * @returns {{
 *   fileType: 'csv' | 'xlsx',
 *   sheetName?: string,
 *   sheetNames?: string[],
 *   headerRowIndex: number,
 *   columns: Array<{ index, name, sample_values: string[] }>,
 *   rows: Array<Record<string, any>>,
 *   rowCount: number,
 *   preview: Array<Record<string, any>>,
 * }}
 */
export function parseFile(buffer, filename = '') {
  const lower = filename.toLowerCase();
  const isXlsx = lower.endsWith('.xlsx') || lower.endsWith('.xls') || lower.endsWith('.xlsm');
  const fileType = isXlsx ? 'xlsx' : 'csv';

  let rawRows;        // Array<Array<any>> — raw 2D grid
  let sheetName;
  let sheetNames;

  if (isXlsx) {
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    sheetNames = wb.SheetNames;
    sheetName = wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    rawRows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: null });
  } else {
    // CSV/TSV: handle BOM, various delimiters
    let text = buffer.toString('utf8');
    // Strip UTF-8 BOM if present (Excel CSV exports add this)
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

    // Auto-detect delimiter (comma, tab, or semicolon)
    const firstLine = text.split(/\r?\n/).find(l => l.trim()) || '';
    const delims = [
      { ch: ',', count: (firstLine.match(/,/g) || []).length },
      { ch: '\t', count: (firstLine.match(/\t/g) || []).length },
      { ch: ';', count: (firstLine.match(/;/g) || []).length },
    ];
    delims.sort((a, b) => b.count - a.count);
    const FS = delims[0].count > 0 ? delims[0].ch : ',';

    const wb = XLSX.read(text, { type: 'string', cellDates: true, FS, raw: false });
    sheetName = wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    rawRows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: null });
  }

  if (!rawRows || rawRows.length === 0) {
    throw new Error('File appears to be empty');
  }

  // Detect header row
  const headerRowIndex = detectHeaderRow(rawRows);
  const headerRow = rawRows[headerRowIndex].map(cleanHeader);
  const dataRows = rawRows.slice(headerRowIndex + 1);

  // Build columns: detect which columns are actually used
  const columns = headerRow.map((name, index) => {
    const samples = [];
    for (const row of dataRows) {
      const v = row[index];
      if (v != null && String(v).trim() !== '') {
        samples.push(normalizeValue(v));
        if (samples.length >= MAX_SAMPLE_VALUES) break;
      }
    }
    return {
      index,
      name: name || `col_${index}`,
      sample_values: samples,
      populated_count: countNonEmpty(dataRows, index),
    };
  }).filter(col => col.name && col.populated_count > 0); // drop empty columns

  // Build row records keyed by column name
  const rows = dataRows
    .map(row => {
      const obj = {};
      for (const col of columns) {
        const v = row[col.index];
        if (v != null && String(v).trim() !== '') {
          obj[col.name] = normalizeValue(v);
        }
      }
      return obj;
    })
    .filter(r => Object.keys(r).length > 0); // drop fully empty rows

  return {
    fileType,
    sheetName,
    sheetNames,
    headerRowIndex,
    columns,
    rows,
    rowCount: rows.length,
    preview: rows.slice(0, MAX_PREVIEW_ROWS),
  };
}

/**
 * Detect the most likely header row.
 * Heuristic: the row with the highest "string-label density" —
 * short string values, few numbers, few dates.
 */
function detectHeaderRow(rows) {
  const limit = Math.min(rows.length, MAX_HEADER_CANDIDATE_ROWS);
  let bestRow = 0;
  let bestScore = -Infinity;

  for (let i = 0; i < limit; i++) {
    const row = rows[i];
    if (!row || !row.length) continue;
    const score = scoreAsHeader(row);
    if (score > bestScore) {
      bestScore = score;
      bestRow = i;
    }
  }
  return bestRow;
}

function scoreAsHeader(row) {
  let stringLabels = 0;
  let numbers = 0;
  let empties = 0;
  let totalLen = 0;
  let nonEmpty = 0;

  for (const v of row) {
    if (v == null || String(v).trim() === '') { empties++; continue; }
    nonEmpty++;
    const s = String(v).trim();
    totalLen += s.length;
    if (/^-?\d+(\.\d+)?$/.test(s)) { numbers++; continue; }
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) { numbers++; continue; }
    // Good header: short (< 30 chars), no spaces at start/end, mostly letters
    if (s.length <= 30 && /[a-zA-Z]/.test(s)) stringLabels++;
  }

  if (nonEmpty === 0) return -Infinity;

  // Penalize rows that are mostly numbers (= looks like data row)
  // Reward rows that are mostly short string labels
  const avgLen = totalLen / nonEmpty;
  const stringRatio = stringLabels / nonEmpty;
  const numberRatio = numbers / nonEmpty;

  return stringRatio * 10 - numberRatio * 8 - (avgLen > 40 ? 5 : 0);
}

function cleanHeader(v) {
  if (v == null) return '';
  return String(v).trim();
}

function normalizeValue(v) {
  if (v == null) return null;
  // Dates from xlsx come as Date objects when cellDates:true
  if (v instanceof Date) {
    return v.toISOString().slice(0, 10);
  }
  return v;
}

function countNonEmpty(rows, colIdx) {
  let count = 0;
  for (const row of rows) {
    const v = row[colIdx];
    if (v != null && String(v).trim() !== '') count++;
  }
  return count;
}

/**
 * Detect granularity of a row set:
 * - 'master'                : each (style, color) appears once  → single row per product master
 * - 'master_with_variants'  : (style, color) has multiple rows distinguished by size → variants
 *
 * Expects normalized rows after mapping (keys = target field names).
 */
export function detectGranularity(rows, mapping) {
  const styleKey = findTargetKey(mapping, 'style_number');
  const colorKey = findTargetKey(mapping, 'color');
  const sizeKey  = findTargetKey(mapping, 'size');

  if (!styleKey || !colorKey) return 'master'; // fallback

  // If we don't have a size column at all, it's master-level
  if (!sizeKey) return 'master';

  // Count how many rows per (style, color) combo have distinct sizes
  const keyMap = {};
  for (const row of rows) {
    const s = row[styleKey];
    const c = row[colorKey];
    const sz = row[sizeKey];
    if (!s) continue;
    const k = `${s}::${c || ''}`;
    if (!keyMap[k]) keyMap[k] = new Set();
    if (sz) keyMap[k].add(sz);
  }

  let multiSizeCount = 0;
  for (const sizes of Object.values(keyMap)) {
    if (sizes.size > 1) multiSizeCount++;
  }

  // If > 20% of masters have multiple sizes, treat file as variant-level
  const total = Object.keys(keyMap).length;
  if (total === 0) return 'master';
  return (multiSizeCount / total > 0.2) ? 'master_with_variants' : 'master';
}

function findTargetKey(mapping, targetField) {
  for (const [src, target] of Object.entries(mapping || {})) {
    if (target === targetField) return src;
  }
  return null;
}
