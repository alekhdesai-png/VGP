'use strict';

const MAX_AMOUNT = 1e9;

/**
 * Parse a dollar amount typed by a human. Ignores "$", commas and spaces.
 * Returns a positive number rounded to cents, or null if invalid.
 */
function parseMoney(input) {
  if (typeof input === 'number') input = String(input);
  if (typeof input !== 'string') return null;
  const s = input.trim().replace(/[\s$,]/g, '');
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_AMOUNT) return null;
  const cents = Math.round(n * 100);
  if (cents <= 0) return null;
  return cents / 100;
}

/** Trim, collapse whitespace, strip control chars, cap length. */
function cleanText(input, max = 80) {
  if (input === undefined || input === null) return '';
  return String(input)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanName(input) {
  return cleanText(input, 20);
}

/** Population is free text ("1,234", "Pop 12", "N/A"); numbers get thousands separators. */
function cleanPopulation(input) {
  const s = cleanText(input, 40);
  if (/^[\d,\s]+$/.test(s) && /\d/.test(s)) {
    return Number(s.replace(/[,\s]/g, '')).toLocaleString('en-US');
  }
  return s;
}

const PRICE_RE = '\\$?\\s*(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?|\\.\\d+)';

/**
 * Bulk add parser. One item per line. Two formats:
 *   name, price                         e.g. "Mickey Mantle 1952 Topps, $1,200"
 *   name | set | population | price     (set/population optional: "name | set | price")
 * Tabs work like "|" (paste straight from a spreadsheet).
 * Blank lines and lines starting with # are skipped.
 */
function parseBulk(text) {
  const items = [];
  const errors = [];
  const lines = String(text || '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    let fields;
    if (line.includes('|') || line.includes('\t')) {
      fields = line.split(/[|\t]/).map((f) => f.trim());
      const priceRaw = fields.pop();
      const price = parseMoney(priceRaw);
      const [name, set = '', population = ''] = fields;
      if (!cleanText(name)) return errors.push({ line: i + 1, text: line, error: 'Missing name' });
      if (price === null) return errors.push({ line: i + 1, text: line, error: `Bad price "${priceRaw}"` });
      if (fields.length > 3) return errors.push({ line: i + 1, text: line, error: 'Too many fields (max: name | set | population | price)' });
      items.push({ name: cleanText(name), set: cleanText(set), population: cleanPopulation(population), price });
      return;
    }
    const m = line.match(new RegExp('^(.+?)\\s*,\\s*' + PRICE_RE + '\\s*$'));
    if (!m) return errors.push({ line: i + 1, text: line, error: 'Expected "name, price"' });
    const price = parseMoney(m[2]);
    if (price === null) return errors.push({ line: i + 1, text: line, error: 'Price must be positive' });
    items.push({ name: cleanText(m[1]), set: '', population: '', price });
  });
  return { items, errors };
}

module.exports = { parseMoney, cleanText, cleanName, cleanPopulation, parseBulk, MAX_AMOUNT };
