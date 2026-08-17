/** Number, currency and date formatting. One place, so every panel agrees. */

const DASH = '—';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

const cache = new Map();
function nf(options) {
  const key = JSON.stringify(options);
  let f = cache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(undefined, options);
    cache.set(key, f);
  }
  return f;
}

/** 1,284 · 12.9K · 4.2M · 394.3B · 1.8T */
export function compact(value, { digits = 2 } = {}) {
  if (!isNum(value)) return DASH;
  const abs = Math.abs(value);
  if (abs < 1000) return nf({ maximumFractionDigits: abs < 10 ? digits : 0 }).format(value);
  const units = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [size, suffix] of units) {
    if (abs >= size) {
      const scaled = value / size;
      return nf({ maximumFractionDigits: Math.abs(scaled) >= 100 ? 0 : digits }).format(scaled) + suffix;
    }
  }
  return String(value);
}

export function currency(value, code = 'USD', { digits } = {}) {
  if (!isNum(value)) return DASH;
  const abs = Math.abs(value);
  // Sub-dollar names (penny stocks, FX) need more precision than blue chips.
  const decimals = digits ?? (abs >= 1000 ? 2 : abs >= 1 ? 2 : 4);
  try {
    // narrowSymbol keeps it "$12.40" rather than "US$12.40" outside en-US.
    return nf({
      style: 'currency',
      currency: code,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(value);
  } catch {
    return nf({ minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value);
  }
}

/** $394.3B — big money, where the exact cents are noise. */
export function compactCurrency(value, code = 'USD') {
  if (!isNum(value)) return DASH;
  const symbol = currencySymbol(code);
  const sign = value < 0 ? '-' : '';
  return `${sign}${symbol}${compact(Math.abs(value))}`;
}

export function currencySymbol(code = 'USD') {
  try {
    return (
      nf({ style: 'currency', currency: code, currencyDisplay: 'narrowSymbol', maximumFractionDigits: 0 })
        .formatToParts(0)
        .find((p) => p.type === 'currency')?.value ?? ''
    );
  } catch {
    return '';
  }
}

export function percent(value, { digits = 2, signed = false } = {}) {
  if (!isNum(value)) return DASH;
  const body = nf({ minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
  return `${signed && value > 0 ? '+' : ''}${body}%`;
}

export function ratio(value, { digits = 2 } = {}) {
  if (!isNum(value)) return DASH;
  return nf({ minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

export function integer(value) {
  if (!isNum(value)) return DASH;
  return Math.abs(value) >= 1e6 ? compact(value) : nf({ maximumFractionDigits: 0 }).format(value);
}

export function signedNumber(value, code = 'USD') {
  if (!isNum(value)) return DASH;
  return (value > 0 ? '+' : '') + currency(value, code);
}

export function shortDate(ms) {
  if (!isNum(ms)) return DASH;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function isoDate(value) {
  if (!value) return DASH;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? DASH : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function dateTime(ms) {
  if (!isNum(ms)) return DASH;
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function clockTime(ms) {
  if (!isNum(ms)) return DASH;
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Axis tick label appropriate to the span the chart covers. */
export function axisDate(ms, spanDays) {
  const d = new Date(ms);
  if (spanDays <= 2) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (spanDays <= 14) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (spanDays <= 400) return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
  return String(d.getFullYear());
}

/** Format a `{ value, kind }` metric from the API. */
export function metricValue({ value, kind }, code = 'USD') {
  if (value == null) return DASH;
  switch (kind) {
    case 'currency':
      return Math.abs(value) >= 1e6 ? compactCurrency(value, code) : currency(value, code);
    case 'percent':
      return percent(value);
    case 'ratio':
      return ratio(value);
    case 'integer':
      return integer(value);
    case 'date':
      return isoDate(value);
    default:
      return String(value);
  }
}

/** Direction of a change, for status color + arrow glyph. */
export function direction(value) {
  if (!isNum(value) || value === 0) return 'flat';
  return value > 0 ? 'up' : 'down';
}

export const ARROW = { up: '▲', down: '▼', flat: '•' };

export { DASH };
