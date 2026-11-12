// app/services/query-terms.server.js — v1.0 (12 Nov 2026)
//
// Picks the product noun of a search query, shared by search-router.server.js and
// algolia.server.js. Both used "the last word", so a trailing qualifier became the product:
//   "photoelectric sensor long range" → "range"   (Tier 1b then searched "range" on its own)
//   "push button green"               → "green"
//   "contactor 3 pole"                → "pole"
//   "solenoid valve 5/2 single acting"→ "acting"
// The rule is still "last word", but trailing qualifiers are skipped. When the last word is a
// real noun nothing changes ("cable tie" → tie, "light curtain" → curtain).
// Pure functions, no imports.

const QUALIFIERS = new Set([
  // ranges, counts and sizes
  'range', 'ranges', 'distance', 'sensing', 'pole', 'poles', 'pin', 'pins', 'way', 'ways', 'wire',
  'wires', 'core', 'cores', 'phase', 'phases', 'channel', 'channels', 'step', 'steps', 'inch',
  'inches', 'length', 'size', 'stroke', 'bore', 'dia', 'diameter', 'thread', 'threaded', 'speed',
  // contact state and wiring
  'normally', 'open', 'closed', 'output', 'outputs', 'input', 'inputs', 'voltage', 'current',
  'rated', 'rating', 'shielded', 'unshielded', 'non-flush', 'flush', 'acting',
  // mounting, finish and actuator shape
  'mount', 'mounted', 'mounting', 'plated', 'nickel', 'zinc', 'coated', 'lever', 'roller',
  'version', 'style', 'pack', 'set',
  // colours and size words
  'green', 'red', 'blue', 'black', 'white', 'yellow', 'grey', 'gray', 'orange', 'amber', 'clear',
  'long', 'short', 'small', 'large', 'big', 'mini', 'compact', 'standard', 'heavy', 'duty',
  'single', 'double', 'dual', 'triple',
]);

// "coil" is a qualifier after a contactor or relay ("contactor 24V coil"), a product otherwise.
const COIL_OWNER = /\b(contactors?|relays?)\b/i;

/**
 * Choose the product noun from content words (in query order, already lower-case and filtered).
 * Returns the chosen word as given (the caller singularises), or null.
 */
export function pickHeadNoun(words, rawText = '') {
  const list = (Array.isArray(words) ? words : []).filter(Boolean);
  if (!list.length) return null;
  // "power supply" loses "supply" to the callers' stop lists; it is the product.
  if (/\bpower\s+suppl(?:y|ies)\b/i.test(rawText) && !list.some((w) => w !== 'power' && !QUALIFIERS.has(w) && list.indexOf(w) > list.indexOf('power'))) {
    return 'supply';
  }
  for (let i = list.length - 1; i >= 0; i--) {
    const w = String(list[i]).toLowerCase();
    if (w === 'coil' || w === 'coils') {
      if (COIL_OWNER.test(rawText)) continue;
      return list[i];
    }
    if (!QUALIFIERS.has(w)) return list[i];
  }
  return list[list.length - 1];
}

export function isQualifierWord(word) {
  return QUALIFIERS.has(String(word || '').toLowerCase());
}

export default { pickHeadNoun, isQualifierWord };
