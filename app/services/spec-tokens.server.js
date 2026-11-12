// app/services/spec-tokens.server.js — v1.0 (12 Nov 2026)
//
// One definition of "this token is a spec, not a part number", shared by the router's SKU
// detector (search-router.server.js) and chat.jsx's detectSkuTokens. Before this, only chat.jsx
// skipped specs, so the router sent "0.75kW motor" to Admin as sku:0.75kW, then as a wildcard
// sku:0.7*, and showed whatever matched as a HIGH-confidence part-number hit. "motor" was never
// searched.
//
// Tokens are compared after stripping surrounding punctuation. Pure functions, no imports.

// Number + unit: 24V, 24VDC, 0.75kW, 750W, 4mA, 2.5mm2, 10A, 50Hz, 10bar, 1500rpm, 5m, 70C
const NUMBER_UNIT =
  /^\d+(?:[.,]\d+)?(?:k?w|ma|a|mm2?|cm|m|kv|v|vdc|vac|hz|khz|bar|psi|mpa|kpa|nm|rpm|hp|kva|va|ah|mah|°?c|inch|inches|in|ft|feet|foot|mtr|mtrs|meter|meters|metre|metres|sec|ms|s)$/i;
// Ranges: 4-20mA, 0-10V, 12-24VDC, 100-240VAC, 10-30V
const RANGE = /^\d+(?:[.,]\d+)?[-/]\d+(?:[.,]\d+)?(?:v|vdc|vac|ma|a|w|kw|mm|bar|hz|°?c)?$/i;
// Supply with the type before or after: 24V-DC, 24V/AC, DC24V, AC-230V
const SUPPLY = /^(?:\d+(?:[.,]\d+)?v[-/]?(?:dc|ac)|(?:dc|ac)[-/]?\d+(?:[.,]\d+)?v?)$/i;
// Ratings and standards: IP67, IP69K, IP67/IP69K, Cat6a, NEMA17
const RATING = /^(?:ip\d{2}k?(?:[-/]ip\d{2}k?)*|cat\d+[a-z]?|nema\d+)$/i;
// Dimensions and counts: 32x100, 3x2.5, 4x1.5mm, 3-phase, 2-pole, 5-way, 4-pin, 3-core
const DIMENSION = /^\d+(?:[.,]\d+)?x\d+(?:[.,]\d+)?(?:x\d+(?:[.,]\d+)?)?(?:mm2?)?$/i;
const COUNT = /^\d+-(?:phase|pole|poles|way|wire|pin|core|channel|ch|gang|step)$/i;
// Pipe-standard sizes used as dimensions: 38NPT, 12BSP
const PIPE = /^\d+(?:npt|bsp|bspp|bspt)$/i;

// Thread and body sizes. These name a size, but a customer may also type one alone to search
// for it, so they only count as a part number when they are the whole message.
const THREAD = /^(?:m\d{1,2}(?:[x-]\d+(?:[.,]\d+)?)?|g\d+\/\d+[a-z]?|r\d+\/\d+|\d+\/\d+(?:npt|bsp|bspp|bspt|unf|unc))$/i;

function clean(token) {
  return String(token ?? "").replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9°]+$/g, "");
}

/** True for spec tokens that are never part numbers (units, ranges, ratings, dimensions). */
export function isSpecToken(token) {
  const t = clean(token);
  if (!t) return false;
  return NUMBER_UNIT.test(t) || RANGE.test(t) || SUPPLY.test(t) || RATING.test(t) || DIMENSION.test(t) || COUNT.test(t) || PIPE.test(t);
}

/** True for thread/body sizes (M12, M12x1, M18-1.5, G1/4, 1/2NPT). */
export function isThreadToken(token) {
  return THREAD.test(clean(token));
}

export default { isSpecToken, isThreadToken };
