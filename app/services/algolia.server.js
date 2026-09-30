/**
 * Algolia Search Service — v4.0 (30 Sep 2026)
 *
 * PUBLIC API (backwards compatible with v3.1):
 *   algoliaSearch(query, opts)         → null | { products, confidence, topTermRatio, requestedBrand }
 *   algoliaSearchDetailed(query, opts) → { status: 'ok'|'empty'|'error'|'invalid', products,
 *                                          confidence, topTermRatio, requestedBrand, nbHits }
 *   isAlgoliaConfigured(), normVendor(), __internals (tests)
 *
 *   opts: { first = 10, shopDomain, requestedBrand = null,
 *           requireHeadNoun = false,      // top hit must show the product noun in title/type/tags
 *           variantsOnlyIfHigh = false }  // skip Storefront variant lookups for non-high results
 *
 * v4.0 CHANGES (30 Sep 2026 logs + live catalogue check):
 *  1. Category-aware rerank. Tags follow "<Vendor> <Leaf category>" ("Siemens Contactors",
 *     "Siemens Contactor Accessories"). Leaf = the product asked for → +500; a sub-part of it
 *     (accessories, overload relays, cylinder switches) → -900, unless that was asked for.
 *  2. Fetch 40, rerank, show 10 (ALGOLIA_RERANK_POOL). v3 reranked only 10 hits, so
 *     "Siemens contactor" showed 10 accessories.
 *  3. Category rescue: if the whole pool is sub-parts, one light scan (≤500 hits, no
 *     descriptions) finds the real products. Recommended index fix: unordered(title).
 *  4. Accessory penalty tested "accessory" and never matched "Accessories".
 *  5. Common-word vendors (Delta, Block, Finder, Vega …) become a vendor filter only when
 *     QueryIntel named them as the brand ("star delta timer", "terminal block").
 *  6. Vendor stripping keeps the rest of the query intact. v3 lower-cased it and turned
 *     - . / into spaces ("Siemens 3RT2015-1AB01" → "3rt2015 1ab01", "1.5 mm" → "1 5 mm").
 *  7. removeWordsIfNoResults 'lastWords' removed the product noun ("polyester enclosure" →
 *     "polyester" → limit switches). Now 'none'; the router relaxes without losing the noun.
 *     Override: ALGOLIA_REMOVE_WORDS_IF_NO_RESULTS=lastWords|firstWords|allOptional.
 *  8. A requested brand that is not a vendor (brand only in titles) gets +300.
 *  9. Results that are only accessories of what was asked are graded 'low'.
 * 10. Variant lookups: 6 s timeout + one retry on network errors; only for the shown hits.
 * 11. Never throws. Any failure → status 'error' (algoliaSearch → null, as before).
 *
 * UNCHANGED from v3.1: record field shapes, "undefined" image guard, AED price (not cents),
 * spec / cylinder / term scoring, relevance floor, brand_missing verdict, typo policy,
 * 5-minute LRU cache, [SearchAudit] line (pool/rescued appended).
 */

let _client = null;

// ---------------------------------------------------------------------------
// Tunables (all optional)
// ---------------------------------------------------------------------------
function _intEnv(name, def, min, max) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
const RERANK_POOL = _intEnv('ALGOLIA_RERANK_POOL', 40, 10, 100);
const RESCUE_POOL = _intEnv('ALGOLIA_RESCUE_POOL', 500, 100, 1000);
const RESCUE_TIMEOUT_MS = 3000;
const VARIANT_LOOKUP_TIMEOUT_MS = 6000;
const REMOVE_WORDS_POLICY = (() => {
  const v = String(process.env.ALGOLIA_REMOVE_WORDS_IF_NO_RESULTS || 'none').trim();
  return ['none', 'lastWords', 'firstWords', 'allOptional'].includes(v) ? v : 'none';
})();
const CATEGORY_MATCH_BONUS = 500;
const CATEGORY_SUBPART_PENALTY = 900;
const BRAND_TEXT_BOOST = 300;
const CACHE_VERSION = 4;

// ---------------------------------------------------------------------------
// In-process result cache (LRU, 5 min, empty results never cached)
// ---------------------------------------------------------------------------
const RESULT_CACHE_MAX = 200;
const RESULT_CACHE_TTL_MS = 5 * 60 * 1000;
const _resultCache = new Map();

function _cacheGet(key) {
  const v = _resultCache.get(key);
  if (!v) return null;
  if (Date.now() - v.at > RESULT_CACHE_TTL_MS) {
    _resultCache.delete(key);
    return null;
  }
  _resultCache.delete(key);
  _resultCache.set(key, v);
  return {
    products: v.products,
    confidence: v.confidence || 'high',
    topTermRatio: v.topTermRatio ?? null,
    nbHits: v.nbHits ?? 0,
  };
}

function _cacheSet(key, entry) {
  if (!entry || !Array.isArray(entry.products) || entry.products.length === 0) return;
  if (_resultCache.size >= RESULT_CACHE_MAX) {
    const oldest = _resultCache.keys().next().value;
    if (oldest !== undefined) _resultCache.delete(oldest);
  }
  _resultCache.set(key, { ...entry, at: Date.now() });
}

const _DEBUG_SEARCH = process.env.DEBUG_SEARCH === '1';
function _vlog(...args) {
  if (_DEBUG_SEARCH) console.log(...args);
}

function _withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getClient() {
  if (_client) return _client;

  const appId = process.env.ALGOLIA_APP_ID;
  const apiKey = process.env.ALGOLIA_SEARCH_KEY;
  if (!appId || !apiKey) {
    throw new Error('[Algolia] ALGOLIA_APP_ID and ALGOLIA_SEARCH_KEY must be set');
  }

  const mod = await import('algoliasearch');
  const algoliasearch = mod.algoliasearch || mod.default;
  if (typeof algoliasearch !== 'function') {
    throw new Error(
      `[Algolia] Cannot find constructor. Keys: [${Object.keys(mod).join(', ')}]. Run: npm install algoliasearch`
    );
  }

  _client = algoliasearch(appId, apiKey);
  console.log('[Algolia] Client initialized');
  return _client;
}

export function isAlgoliaConfigured() {
  return !!(process.env.ALGOLIA_APP_ID && process.env.ALGOLIA_SEARCH_KEY);
}

// ---------------------------------------------------------------------------
// Vendor list cache (24 h) and routing
// ---------------------------------------------------------------------------
const VENDOR_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// "Carlo-gavazzi", "carlo gavazzi" and "CARLO_GAVAZZI" compare equal.
export function normVendor(v) {
  return String(v || '').toLowerCase().replace(/[-_\/.]+/g, ' ').replace(/\s+/g, ' ').trim();
}

let _vendorCache = null; // { vendors: Set<key>, vendorMap: Map<key, Set<original>>, fetchedAt }
let _vendorInflight = null;

async function getVendorSet(client, indexName) {
  const now = Date.now();
  if (_vendorCache && now - _vendorCache.fetchedAt < VENDOR_CACHE_TTL_MS) return _vendorCache;
  if (_vendorInflight) return _vendorInflight;

  _vendorInflight = (async () => {
    try {
      const vendors = new Set();
      const vendorMap = new Map();
      const addVendor = (v) => {
        if (typeof v !== 'string' || !v.trim()) return;
        const key = normVendor(v);
        if (!key) return;
        vendors.add(key);
        if (!vendorMap.has(key)) vendorMap.set(key, new Set());
        vendorMap.get(key).add(v);
      };

      // PRIMARY: facet-only search returns up to 1000 distinct vendors.
      let gotAll = false;
      try {
        const facetRes = await client.search({
          requests: [{ indexName, query: '', hitsPerPage: 0, facets: ['vendor'], maxValuesPerFacet: 1000 }],
        });
        const facetObj = facetRes?.results?.[0]?.facets?.vendor || {};
        for (const v of Object.keys(facetObj)) addVendor(v);
        gotAll = vendors.size > 0;
      } catch (facetErr) {
        console.warn(`[Algolia] facet-based vendor fetch failed: ${facetErr.message}`);
      }

      // FALLBACK: searchForFacetValues (capped at 100).
      if (!gotAll) {
        const res = await client.searchForFacetValues({
          indexName,
          facetName: 'vendor',
          searchForFacetValuesRequest: { facetQuery: '', maxFacetHits: 100 },
        });
        const facetHits = res?.facetHits || res?.results?.[0]?.facetHits || [];
        for (const f of facetHits) addVendor(f.value);
      }
      _vendorCache = { vendors, vendorMap, fetchedAt: now };
      console.log(`[Algolia] vendor cache populated: ${vendors.size} vendors`);
      return _vendorCache;
    } catch (err) {
      console.warn(`[Algolia] vendor facet fetch failed: ${err.message} — vendor routing disabled this request`);
      _vendorCache = { vendors: new Set(), vendorMap: new Map(), fetchedAt: now - VENDOR_CACHE_TTL_MS + 5 * 60 * 1000 };
      return _vendorCache;
    } finally {
      _vendorInflight = null;
    }
  })();
  return _vendorInflight;
}

// Vendor names that are also ordinary words in industrial queries.
// "star delta timer" (Delta: 1,201 products) and "terminal block" (Block: 1 product) were
// being filtered to the wrong vendor. These route only when QueryIntel named the brand.
const AMBIGUOUS_VENDOR_KEYS = new Set([
  'delta', 'block', 'finder', 'vega', 'telco', 'eta', 'br', 'sip', 'gic', 'hms', 'msa', 'nsf', 'nsk', 'eao',
]);

function brandConfirms(vendorKey, requestedBrand) {
  const b = normVendor(requestedBrand);
  if (!b) return false;
  if (b === vendorKey) return true;
  return b.split(' ').includes(vendorKey) || vendorKey.split(' ').includes(b);
}

function _escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Matches the vendor as whole word(s) in the ORIGINAL text; separators between vendor words
// may be space - _ / . + & ("Pepperl-Fuchs", "Carlo Gavazzi", "Schmersal GmbH & Co. KG").
const _vendorPatternCache = new Map();
function vendorPatterns(key) {
  let p = _vendorPatternCache.get(key);
  if (!p) {
    const body = String(key).split(' ').filter(Boolean).map(_escapeRe).join('[\\s\\-_/.+&]+');
    const src = `(^|[\\s,;:()"'])${body}(?=$|[\\s,;:()"'?!.])`;
    p = { test: new RegExp(src, 'i'), replace: new RegExp(src, 'gi') };
    if (_vendorPatternCache.size > 2000) _vendorPatternCache.clear();
    _vendorPatternCache.set(key, p);
  }
  return p;
}

// Pure: returns { remainder, matched: [original vendor spellings], skipped: [ambiguous keys] }.
function routeVendorsInText(query, vendors, vendorMap, requestedBrand) {
  const sorted = [...vendors].sort((a, b) => b.length - a.length); // "abb jokab" before "abb"
  const matched = [];
  const skipped = [];
  let rem = ` ${String(query ?? '')} `;
  for (const v of sorted) {
    if (!v) continue;
    const { test, replace } = vendorPatterns(v);
    if (!test.test(rem)) continue;
    if (AMBIGUOUS_VENDOR_KEYS.has(v) && !brandConfirms(v, requestedBrand)) {
      skipped.push(v);
      continue;
    }
    for (const orig of (vendorMap.get(v) || [v])) matched.push(orig);
    rem = rem.replace(replace, '$1 ');
  }
  const remainder = rem.replace(/\s+/g, ' ').replace(/^[\s,;:]+|[\s,;:]+$/g, '').trim();
  return { remainder, matched, skipped };
}

async function applyVendorRouting(query, client, indexName, requestedBrand = null) {
  const none = { algoliaQuery: query, filters: null, matchedVendors: [] };
  if (!query || typeof query !== 'string') return none;
  try {
    const { vendors, vendorMap } = await getVendorSet(client, indexName);
    if (!vendors || vendors.size === 0) return none;
    const { remainder, matched, skipped } = routeVendorsInText(query, vendors, vendorMap, requestedBrand);
    if (skipped.length) {
      console.log(`[Algolia] vendor routing: kept common-word vendor(s) [${skipped.join(', ')}] as text (not named as the brand)`);
    }
    if (matched.length === 0) return none;
    const filters = matched.map((v) => `vendor:"${String(v).replace(/"/g, '\\"')}"`).join(' OR ');
    console.log(`[Algolia] vendor routing: matched=[${matched.join(', ')}] query="${query}" → query="${remainder}" filters=${filters}`);
    return { algoliaQuery: remainder, filters, matchedVendors: matched };
  } catch (err) {
    console.warn(`[Algolia] vendor routing failed (${err.message}) — searching without a vendor filter`);
    return none;
  }
}

// ---------------------------------------------------------------------------
// Variant IDs (not in the index) — one productByHandle per shown hit, in parallel
// ---------------------------------------------------------------------------
async function fetchVariantIdsByHandles(handles, shopDomain) {
  const variantMap = new Map();
  if (!handles || handles.length === 0) return variantMap;

  let shopifyStorefrontQuery;
  try {
    ({ shopifyStorefrontQuery } = await import('../shopify-storefront.js'));
  } catch (err) {
    console.warn(`[Algolia] Storefront client unavailable: ${err.message}`);
    return variantMap;
  }

  const SINGLE_QUERY = `
    query GetVariantByHandle($handle: String!) {
      productByHandle(handle: $handle) {
        handle
        variants(first: 1) {
          edges { node { id sku availableForSale price { amount currencyCode } } }
        }
      }
    }
  `;
  const lookupOnce = (handle) =>
    _withTimeout(
      shopifyStorefrontQuery({ query: SINGLE_QUERY, variables: { handle }, shopDomain }),
      VARIANT_LOOKUP_TIMEOUT_MS,
      'variant lookup'
    );

  await Promise.allSettled(
    handles.filter(Boolean).map(async (handle) => {
      try {
        let data;
        try {
          data = await lookupOnce(handle);
        } catch (err) {
          if (/timed out/i.test(err?.message || '')) throw err; // slow → don't double the wait
          await _sleep(150); // transient "fetch failed" → one retry
          data = await lookupOnce(handle);
        }
        const firstVariant = data?.productByHandle?.variants?.edges?.[0]?.node;
        if (firstVariant) {
          variantMap.set(handle, { variantId: firstVariant.id, variantSku: firstVariant.sku || null });
        }
      } catch (err) {
        console.warn(`[Algolia] variant lookup failed for "${handle}": ${err.message}`);
      }
    })
  );

  console.log(`[Algolia] variant IDs resolved: ${variantMap.size}/${handles.length}`);
  return variantMap;
}

// Some records store the literal string "undefined" as product_image.
function isValidImageUrl(value) {
  if (!value) return false;
  if (typeof value !== 'string') return false;
  if (value === 'undefined' || value === 'null') return false;
  return value.startsWith('http');
}

// ---------------------------------------------------------------------------
// Spec / term / business / cylinder scoring (unchanged from v3.1 except accessory regex)
// ---------------------------------------------------------------------------

// Numeric+unit tokens: "60mm", "60 mm", "24V", "IP67", "M12".
function extractSpecTokens(query) {
  if (!query || typeof query !== "string") return [];
  const tokens = [];
  const re = /(\d+(?:\.\d+)?)\s*(mm|cm|m|inch|in|"|v|vdc|vac|a|w|kw|hz|khz|°c|c)\b/gi;
  let m;
  while ((m = re.exec(query)) !== null) {
    tokens.push({
      value: parseFloat(m[1]),
      unit: m[2].toLowerCase().replace("°c", "c"),
      raw: m[0].toLowerCase(),
    });
  }
  const ipRe = /\bIP(\d{2})\b/gi;
  while ((m = ipRe.exec(query)) !== null) {
    tokens.push({ value: parseInt(m[1]), unit: "ip", raw: `ip${m[1]}` });
  }
  // M-thread codes are categorical (M8 vs M10 are different products).
  const mRe = /\bM(\d{1,2})\b/g;
  while ((m = mRe.exec(query)) !== null) {
    tokens.push({ value: parseInt(m[1]), unit: "m_thread", raw: `m${m[1]}` });
  }
  return tokens;
}

function _clean(parts) {
  return parts
    .filter(Boolean)
    .join(" ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

// STRONG surfaces: what the product IS.
function flattenStrongText(hit) {
  return _clean([
    hit.title,
    hit.handle,
    hit.product_type,
    hit.vendor,
    Array.isArray(hit.tags) ? hit.tags.join(" ") : hit.tags,
    Array.isArray(hit.named_tags) ? hit.named_tags.join(" ") : "",
    hit.sku,
  ]);
}

// WEAK surface: marketing description (partial credit only).
function flattenWeakText(hit) {
  return _clean([hit.body_html_safe || hit.body_html || ""]);
}

function flattenHitText(hit) {
  return _clean([flattenStrongText(hit), flattenWeakText(hit)]);
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'for', 'of', 'and', 'or', 'with', 'to', 'in', 'on', 'at',
  'me', 'my', 'we', 'our', 'i', 'you', 'your', 'find', 'need', 'want', 'get',
  'show', 'search', 'looking', 'look', 'some', 'any', 'please', 'give', 'is',
  'are', 'do', 'does', 'have', 'has', 'can', 'best', 'good', 'hot', 'new',
  'cheap', 'top', 'nice', 'cool', 'great',
]);

function contentTerms(query) {
  if (!query || typeof query !== 'string') return [];
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s.\-\/]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

// Fraction of the query's content words found in the hit's STRONG surfaces.
function strongTermRatio(hit, terms) {
  if (!terms.length) return 1;
  const strong = flattenStrongText(hit);
  let hitCount = 0;
  for (const t of terms) {
    const stem = t.replace(/(ies|es|s)$/, '');
    const pattern = stem.length >= 3 ? stem : t;
    if (strong.includes(pattern)) hitCount++;
  }
  return hitCount / terms.length;
}

// v4: matches "Accessory" AND "Accessories" (v3 only matched the singular).
const ACCESSORY_TITLE_RE = /\baccessor(?:y|ies)\b|\bmounting brackets?\b/;
const ACCESSORY_TYPE_RE = /\baccessor(?:y|ies)\b/;

function scoreHitByBusinessSignal(hit) {
  let s = 0;
  if (hit.inventory_available === true) s += 200;
  if (typeof hit.inventory_quantity === 'number' && hit.inventory_quantity > 0) s += 50;
  const titleLow = String(hit.title || '').toLowerCase();
  const ptLow = String(hit.product_type || '').toLowerCase();
  if (ACCESSORY_TITLE_RE.test(titleLow) || ACCESSORY_TYPE_RE.test(ptLow)) s -= 300;
  return s;
}

function scoreHitBySpec(hit, specTokens) {
  if (!specTokens.length) return 0;
  const strong = flattenStrongText(hit);
  const weak = flattenWeakText(hit);
  let score = 0;

  for (const tok of specTokens) {
    let pattern;
    if (tok.unit === "m_thread") {
      pattern = new RegExp(`\\bm${tok.value}\\b`, "i");
    } else if (tok.unit === "ip") {
      pattern = new RegExp(`\\bip${tok.value}\\b`, "i");
    } else {
      pattern = new RegExp(`\\b${tok.value}\\s*${tok.unit}\\b`, "i");
    }

    function buildMismatchRe() {
      if (tok.unit === "m_thread") return /\bm(\d{1,2})\b/gi;
      if (tok.unit === "ip") return /\bip(\d{2})\b/gi;
      return new RegExp(`\\b(\\d+(?:\\.\\d+)?)\\s*${tok.unit}\\b`, "gi");
    }

    function hasDifferentValue(text) {
      const re = buildMismatchRe();
      let mm;
      while ((mm = re.exec(text)) !== null) {
        if (parseFloat(mm[1]) !== tok.value) return true;
      }
      return false;
    }

    if (pattern.test(strong)) {
      score += 1000;
    } else if (pattern.test(weak)) {
      score += 250;
      if (hasDifferentValue(strong)) score -= 800;
    } else if (hasDifferentValue(strong) || hasDifferentValue(weak)) {
      score -= 800;
    }
  }
  return score;
}

// Bore and stroke are role-sensitive ("32 bore x 100 stroke" ≠ "100 bore x 32 stroke").
function extractCylinderDims(text) {
  if (!text || typeof text !== 'string') return { bore: null, stroke: null };
  const t = text.toLowerCase();
  const num = (m) => (m ? parseFloat(m[1]) : null);
  const bore =
    num(t.match(/(\d+(?:\.\d+)?)\s*mm\s*(?:barrel\s*)?bore/)) ??
    num(t.match(/\bbore\s*(?:dia(?:meter)?\s*)?[:=]?\s*(\d+(?:\.\d+)?)/)) ??
    num(t.match(/(?:ø|\bdia(?:meter)?\s*)(\d+(?:\.\d+)?)/));
  const stroke =
    num(t.match(/(\d+(?:\.\d+)?)\s*mm\s*stroke/)) ??
    num(t.match(/\bstroke\s*(?:length\s*)?[:=]?\s*(\d+(?:\.\d+)?)/));
  return { bore, stroke };
}

function scoreHitByCylinderDims(hit, want) {
  if (!want || (want.bore == null && want.stroke == null)) return 0;
  const have = extractCylinderDims(`${hit.title || ''} ${hit.product_type || ''}`);
  let s = 0;
  for (const role of ['bore', 'stroke']) {
    if (want[role] == null || have[role] == null) continue;
    s += want[role] === have[role] ? 700 : -1200;
  }
  return s;
}

function brandAppearsInHits(brand, hits) {
  const b = normVendor(brand);
  if (!b) return true;
  return hits.some((h) => {
    const v = normVendor(h.vendor);
    if (v && (v === b || v.includes(b) || b.includes(v))) return true;
    return normVendor(`${h.title || ''} ${Array.isArray(h.tags) ? h.tags.join(' ') : h.tags || ''}`).includes(b);
  });
}

// ---------------------------------------------------------------------------
// v4: category-aware scoring
// ---------------------------------------------------------------------------
const HEAD_STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'your', 'our', 'you', 'any', 'some', 'all',
  'please', 'pls', 'need', 'want', 'have', 'has', 'supply', 'sell', 'stock', 'carry', 'provide',
  'offer', 'get', 'show', 'find', 'search', 'looking', 'look', 'price', 'prices', 'quote',
  'quotation', 'available', 'availability', 'also', 'plus', 'etc', 'such', 'very', 'only', 'just',
  'mm', 'cm', 'mtr', 'kw', 'hp', 'vac', 'vdc', 'volt', 'volts', 'amp', 'amps', 'hz', 'khz', 'bar',
  'psi', 'mpa', 'kpa', 'rpm', 'pnp', 'npn', 'nos', 'pcs', 'piece', 'pieces', 'unit', 'units',
  'qty', 'quantity', 'type', 'series', 'model', 'brand', 'make',
]);
const PREP_SPLIT = /\s(?:for|with|to|on|in|from|by|of|at|under|without)\s/i;
// Leaf-category endings that mean "an accessory of", used for the 'low' verdict.
const ACCESSORY_LEAF_WORDS = new Set([
  'accessory', 'bracket', 'cable', 'holder', 'cover', 'kit', 'spare', 'part', 'seal', 'mounting',
  'label', 'cap', 'adapter', 'connector', 'socket', 'base', 'clip', 'plate', 'frame', 'lock',
  'reflector', 'screw', 'nut', 'washer', 'gasket', 'fitting',
]);

function singular(word) {
  const w = String(word ?? '').toLowerCase();
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (/(?:ss|us|is)$/.test(w)) return w;
  if (/(?:ch|sh|x|z)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s')) return w.slice(0, -1);
  return w;
}

// Product noun = last content word before any preposition.
function headNounOf(query) {
  const firstPart = ` ${String(query ?? '').toLowerCase()} `.split(PREP_SPLIT)[0];
  const toks = firstPart
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => /^[a-z][a-z-]*[a-z]$/.test(t) && t.length >= 3 && !HEAD_STOP.has(t));
  return toks.length ? singular(toks[toks.length - 1]) : null;
}

function queryWordSet(query) {
  return new Set(String(query ?? '').toLowerCase().split(/[^a-z-]+/).filter(Boolean).map(singular));
}

// Fallback for "<Vendor> <Category> <SKU>" titles without a vendor tag.
function titleCategoryAfterVendor(title, vKey) {
  const words = String(title ?? '').trim().split(/\s+/).filter(Boolean);
  let acc = '';
  let start = -1;
  for (let k = 0; k < words.length && k < 6; k++) {
    acc = normVendor(`${acc} ${words[k]}`);
    if (acc === vKey) { start = k + 1; break; }
    if (!vKey.startsWith(acc)) break;
  }
  if (start < 0) return null;
  const cat = [];
  for (const w of words.slice(start)) {
    if (/\d/.test(w)) break;
    const clean = w.toLowerCase().replace(/[^a-z&-]/g, '');
    if (!clean) break;
    cat.push(clean);
  }
  return cat.length ? cat.join(' ') : null;
}

// "Siemens Contactor Accessories" (vendor Siemens) → "contactor accessories".
function leafCategory(hit) {
  const vKey = normVendor(hit?.vendor);
  if (!vKey) return null;
  const tags = Array.isArray(hit?.tags) ? hit.tags : typeof hit?.tags === 'string' ? hit.tags.split(',') : [];
  for (const raw of tags) {
    const t = normVendor(raw);
    if (t.startsWith(`${vKey} `) && t.length > vKey.length + 3) return t.slice(vKey.length + 1);
  }
  return titleCategoryAfterVendor(hit?.title, vKey);
}

function leafWords(hit) {
  const leaf = leafCategory(hit);
  return leaf ? leaf.split(/[\s&,/]+/).filter(Boolean).map(singular) : [];
}

function scoreHitByCategory(hit, head, qWords) {
  if (!head) return 0;
  if (head === normVendor(hit?.vendor)) return 0;
  const words = leafWords(hit);
  if (!words.length) return 0;
  const last = words[words.length - 1];
  if (last === head) return CATEGORY_MATCH_BONUS;
  if (words.includes(head) && !(qWords && qWords.has(last))) return -CATEGORY_SUBPART_PENALTY;
  return 0;
}

function categoryScoreForQuery(hit, query) {
  return scoreHitByCategory(hit, headNounOf(query), queryWordSet(query));
}

function strongHasHead(hit, head) {
  if (!head) return true;
  const stem = head.length > 4 && head.endsWith('y') ? head.slice(0, -1) : head;
  return flattenStrongText(hit).includes(stem);
}

// Brand the customer named that is not a vendor filter (e.g. only in house-vendor titles).
function scoreHitByBrandText(hit, requestedBrand, brandRouted) {
  if (!requestedBrand || brandRouted) return 0;
  return brandAppearsInHits(requestedBrand, [hit]) ? BRAND_TEXT_BOOST : 0;
}

// typoTolerance must be a SCALAR; the other typo options are top-level params.
function buildTypoPolicy({ looksLikeSku, hasNumericSpec }) {
  if (looksLikeSku) {
    return {
      typoTolerance: false,
      allowTyposOnNumericTokens: false,
      disableTypoToleranceOnAttributes: ['sku', 'vendor'],
    };
  }
  if (hasNumericSpec) {
    return {
      typoTolerance: true,
      allowTyposOnNumericTokens: false,
      minWordSizefor1Typo: 5,
      minWordSizefor2Typos: 9,
      disableTypoToleranceOnAttributes: ['sku', 'vendor'],
    };
  }
  return {
    typoTolerance: true,
    disableTypoToleranceOnAttributes: ['sku', 'vendor'],
  };
}

// ---------------------------------------------------------------------------
// Hit → card
// ---------------------------------------------------------------------------
const FULL_ATTRS = [
  'objectID', 'id', 'title', 'handle', 'vendor',
  'product_type', 'tags', 'body_html', 'body_html_safe',
  'price', 'variants_min_price', 'variants_max_price', 'currency_code',
  'product_image', 'image', 'featured_image', 'images',
  'variants', 'sku', 'named_tags',
  'inventory_available', 'inventory_quantity',
];
const LIGHT_ATTRS = FULL_ATTRS.filter((a) => a !== 'body_html' && a !== 'body_html_safe');

function resolveStorefrontHost(shopDomain) {
  const envHost = process.env.STOREFRONT_HOST
    ? String(process.env.STOREFRONT_HOST).replace(/^https?:\/\//, '').replace(/\/+$/, '')
    : null;
  const shopHost = shopDomain ? String(shopDomain).replace(/^https?:\/\//, '').replace(/\/+$/, '') : null;
  return envHost || (shopHost && !shopHost.endsWith('.myshopify.com') ? shopHost : null) || 'www.creativeautomation.ae';
}

function hitToProduct(hit, variantMap, host, quiet = false) {
  const rawId = hit.objectID || hit.id || '';
  const productId = String(rawId).startsWith('gid://') ? rawId : `gid://shopify/Product/${rawId}`;

  const imageUrl =
    (isValidImageUrl(hit.product_image) ? hit.product_image : null) ||
    (hit.image && typeof hit.image === 'object' && isValidImageUrl(hit.image.src) ? hit.image.src : null) ||
    (isValidImageUrl(hit.image) ? hit.image : null) ||
    (isValidImageUrl(hit.featured_image) ? hit.featured_image : null) ||
    (Array.isArray(hit.images) && isValidImageUrl(hit.images[0]) ? hit.images[0] : null) ||
    null;

  // PRICE: plain AED amount (e.g. 4437), NOT cents
  const rawPrice = hit.variants_min_price ?? hit.price ?? null;
  const currency = hit.currency_code || 'AED';
  const parsed = rawPrice != null ? parseFloat(String(rawPrice)) : NaN;
  const price = Number.isFinite(parsed) ? `${parsed.toFixed(2)} ${currency}` : null;

  const algoliaVariant = Array.isArray(hit.variants) ? hit.variants[0] : null;
  const algoliaVariantRawId = algoliaVariant?.id;
  const algoliaVariantId =
    algoliaVariantRawId != null
      ? String(algoliaVariantRawId).startsWith('gid://')
        ? String(algoliaVariantRawId)
        : `gid://shopify/ProductVariant/${algoliaVariantRawId}`
      : null;
  const variantInfo = hit.handle ? variantMap.get(hit.handle) : null;
  const variantId = algoliaVariantId || variantInfo?.variantId || null;
  const variantSku = algoliaVariant?.sku || variantInfo?.variantSku || hit.sku || null;

  const rawDesc = hit.body_html_safe || hit.body_html || '';
  const description =
    typeof rawDesc === 'string' ? rawDesc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500) : '';

  if (!quiet) {
    if (!imageUrl) console.warn(`[Algolia] No image for "${hit.title}" — product_image=${hit.product_image}`);
    if (!variantId) console.warn(`[Algolia] No variant_id for "${hit.title}" handle="${hit.handle}"`);
  }

  return {
    id: productId,
    title: hit.title || 'Untitled Product',
    handle: hit.handle || null,
    vendor: hit.vendor || null,
    image_url: imageUrl,
    url: hit.handle ? `https://${host}/products/${hit.handle}` : null,
    price,
    description,
    variant_id: variantId,
    merchandise_id: variantId,
    sku: variantSku,
  };
}

// ---------------------------------------------------------------------------
// Main search
// ---------------------------------------------------------------------------
export async function algoliaSearchDetailed(query, options = {}) {
  const t0 = Date.now();
  const opts = options && typeof options === 'object' ? options : {};
  const requestedBrand = opts.requestedBrand || null;
  const base = { status: 'invalid', products: [], confidence: 'none', topTermRatio: 0, requestedBrand, nbHits: 0 };

  try {
    if (!query || typeof query !== 'string') return base;
    const trimmed = query.trim();
    if (!trimmed) return base;

    const firstRaw = Number(opts.first);
    const firstN = Number.isFinite(firstRaw) && firstRaw >= 1 ? Math.min(50, Math.floor(firstRaw)) : 10;
    const shopDomain = opts.shopDomain;
    const requireHeadNoun = opts.requireHeadNoun === true;
    const variantsOnlyIfHigh = opts.variantsOnlyIfHigh === true;

    const looksLikeSku =
      /^[A-Z0-9]{2,}[-\.][A-Z0-9][-A-Z0-9\.\/]{2,}$/i.test(trimmed) ||
      (/^[A-Z]{2,}\d{2,}/.test(trimmed) && trimmed.length >= 5 && trimmed.length <= 20);
    if (looksLikeSku) _vlog(`[Algolia] SKU query detected — searching exact: "${trimmed}"`);

    const indexName = process.env.ALGOLIA_INDEX_NAME || 'shopify_products';
    const specTokens = extractSpecTokens(trimmed);
    const hasNumericSpec = specTokens.length > 0;
    _vlog(
      `[Algolia] OUTGOING query="${trimmed}" first=${firstN} typoTolerance=${
        looksLikeSku ? 'off (sku)' : hasNumericSpec ? 'numeric-locked' : 'on'
      }`
    );

    let client;
    try {
      client = await getClient();
    } catch (err) {
      console.error(`[Algolia] Client init failed: ${err.message}`);
      return { ...base, status: 'error', confidence: 'error' };
    }

    const typoFields = buildTypoPolicy({ looksLikeSku, hasNumericSpec });
    const routing = await applyVendorRouting(trimmed, client, indexName, requestedBrand);
    const outgoingQuery = typeof routing.algoliaQuery === 'string' ? routing.algoliaQuery : trimmed;
    const filters = routing.filters || null;
    const matchedVendors = Array.isArray(routing.matchedVendors) ? routing.matchedVendors : [];
    const brandRouted =
      !!requestedBrand &&
      matchedVendors.some(
        (v) => normVendor(v) === normVendor(requestedBrand) || normVendor(v).includes(normVendor(requestedBrand))
      );

    const cacheKey = JSON.stringify({
      v: CACHE_VERSION,
      q: outgoingQuery.toLowerCase().replace(/\s+/g, ' '),
      f: filters || '',
      b: requestedBrand ? normVendor(requestedBrand) : '',
      first: firstN,
      h: requireHeadNoun ? 1 : 0,
    });
    const cached = _cacheGet(cacheKey);
    if (cached) {
      console.log(
        `[SearchAudit] q=${JSON.stringify(trimmed)} tier=algolia_cache filters=${JSON.stringify(filters || '')} n=${cached.products.length} latency_ms=${Date.now() - t0} top_sku=${JSON.stringify(cached.products[0]?.sku || '')} top_vendor=${JSON.stringify(cached.products[0]?.vendor || '')} reranked=false confidence=${cached.confidence}`
      );
      return {
        status: 'ok',
        products: cached.products,
        confidence: cached.confidence,
        topTermRatio: cached.topTermRatio,
        requestedBrand,
        nbHits: cached.nbHits,
      };
    }

    const pool = looksLikeSku ? firstN : Math.max(firstN, RERANK_POOL);
    const baseParams = {
      indexName,
      query: outgoingQuery,
      attributesToHighlight: [],
      attributesToSnippet: [],
      removeWordsIfNoResults: !looksLikeSku && !hasNumericSpec ? REMOVE_WORDS_POLICY : 'none',
      ...(looksLikeSku ? { optionalWords: [] } : {}),
      ...(filters ? { filters } : {}),
      ...typoFields,
    };

    let hits = [];
    let nbHits = 0;
    try {
      const response = await client.search({
        requests: [{ ...baseParams, hitsPerPage: pool, attributesToRetrieve: FULL_ATTRS }],
      });
      const r0 = response?.results?.[0] || {};
      hits = Array.isArray(r0.hits) ? r0.hits : [];
      nbHits = Number(r0.nbHits) || hits.length;
    } catch (searchErr) {
      const msg = searchErr?.message || '';
      if (msg.includes('does not exist') || msg.includes('Index not found') || searchErr?.status === 404) {
        console.warn(
          `[Algolia] Index "${indexName}" not found. Sync at dashboard.algolia.com → Data Sources → Integrations → Shopify`
        );
      } else {
        console.error(`[Algolia] Search error: ${msg}`);
      }
      return { ...base, status: 'error', confidence: 'error' };
    }

    if (hits.length === 0) {
      console.log(
        `[SearchAudit] q=${JSON.stringify(trimmed)} tier=algolia filters=${JSON.stringify(filters || '')} n=0 latency_ms=${Date.now() - t0} top_sku="" top_vendor="" reranked=false`
      );
      return { ...base, status: 'empty', confidence: 'none', nbHits: 0 };
    }

    // ---- Rerank ----------------------------------------------------------
    const cylWant = extractCylinderDims(trimmed);
    const terms = contentTerms(outgoingQuery || trimmed);
    const head = looksLikeSku ? null : headNounOf(outgoingQuery);
    const qWords = queryWordSet(outgoingQuery);

    const scoreOne = (h, idx) => {
      try {
        const spec = specTokens.length ? scoreHitBySpec(h, specTokens) : 0;
        const biz = scoreHitByBusinessSignal(h);
        const ratio = strongTermRatio(h, terms);
        const term = Math.round(400 * ratio);
        const dim = scoreHitByCylinderDims(h, cylWant);
        const cat = scoreHitByCategory(h, head, qWords);
        const brand = scoreHitByBrandText(h, requestedBrand, brandRouted);
        const lw = cat < 0 ? leafWords(h) : [];
        return {
          hit: h, idx, spec, biz, term, dim, cat, brand, ratio,
          leafLast: lw.length ? lw[lw.length - 1] : null,
          score: spec + biz + term + dim + cat + brand,
        };
      } catch (err) {
        _vlog(`[Algolia] scoring failed for sku=${h?.sku}: ${err.message}`);
        return { hit: h, idx, spec: 0, biz: 0, term: 0, dim: 0, cat: 0, brand: 0, ratio: 0, leafLast: null, score: -1e6 };
      }
    };
    const scored = hits.map(scoreOne);

    // ---- Category rescue: the pool holds only sub-parts of what was asked ----
    let rescued = 0;
    if (head && nbHits > hits.length && !scored.some((s) => s.cat > 0) && scored.some((s) => s.cat < 0)) {
      try {
        const res = await _withTimeout(
          client.search({ requests: [{ ...baseParams, hitsPerPage: RESCUE_POOL, attributesToRetrieve: LIGHT_ATTRS }] }),
          RESCUE_TIMEOUT_MS,
          'category rescue'
        );
        const scanned = Array.isArray(res?.results?.[0]?.hits) ? res.results[0].hits : [];
        const seen = new Set(hits.map((h) => String(h.objectID ?? h.id)));
        const extra = scanned
          .filter((h) => !seen.has(String(h.objectID ?? h.id)) && scoreHitByCategory(h, head, qWords) > 0)
          .slice(0, pool);
        extra.forEach((h, i) => scored.push(scoreOne(h, hits.length + i)));
        rescued = extra.length;
        console.log(
          `[Algolia] category rescue for "${head}": top ${hits.length} were all sub-parts; scanned ${scanned.length}, added ${rescued}`
        );
      } catch (err) {
        console.warn(`[Algolia] category rescue skipped: ${err.message}`);
      }
    }

    const originalTop3 = hits.slice(0, 3).map((h) => h.sku);
    scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.idx - b.idx));
    const finalScored = scored.slice(0, firstN);
    const finalHits = finalScored.map((s) => s.hit);
    const newTop3 = finalHits.slice(0, 3).map((h) => h.sku);
    const reranked = JSON.stringify(originalTop3) !== JSON.stringify(newTop3);

    // ---- Relevance floor ---------------------------------------------------
    const top = finalScored[0];
    const topTermRatio = top?.ratio ?? 0;
    const reasons = [];
    // A vendor filter is itself strong evidence, so vendor-filtered queries keep v3's exemption.
    if (!filters && terms.length > 0 && topTermRatio === 0) {
      reasons.push('no query term appears in any structured field of the top hit');
    }
    if (specTokens.length > 0 && (top?.spec ?? 0) <= 0) {
      reasons.push('no product matched the requested spec');
    }
    if ((cylWant.bore != null || cylWant.stroke != null) && (top?.dim ?? 0) < 0) {
      reasons.push('no cylinder matched the requested bore/stroke');
    }
    if (head && top && top.cat < 0 && top.leafLast && ACCESSORY_LEAF_WORDS.has(top.leafLast)) {
      reasons.push(`only accessories of "${head}" found`);
    }
    if (requireHeadNoun && head && top && !strongHasHead(top.hit, head)) {
      reasons.push(`product noun "${head}" is not in the top hit's title/type/tags`);
    }

    let confidence = 'high';
    if (requestedBrand && !brandRouted && !brandAppearsInHits(requestedBrand, finalHits)) {
      confidence = 'brand_missing';
      console.warn(
        `[Algolia] BRAND MISSING: "${requestedBrand}" requested but no hit carries it (top_vendor=${top?.hit?.vendor || '?'})`
      );
    } else if (reasons.length > 0) {
      confidence = 'low';
      console.warn(
        `[Algolia] LOW CONFIDENCE for "${trimmed}": ${reasons.join('; ')} ` +
          `(top_sku=${top?.hit?.sku || '?'} ratio=${Number(topTermRatio).toFixed(2)} spec=${top?.spec ?? 0})`
      );
    }

    if (specTokens.length > 0) {
      console.log(`[Algolia] spec tokens detected: ${JSON.stringify(specTokens)}`);
    }
    if (reranked) {
      for (let i = 0; i < newTop3.length; i++) {
        const sku = newTop3[i];
        const prev = originalTop3.indexOf(sku);
        if (prev !== -1 && prev !== i) {
          console.log(`[Algolia] Business-signal rerank moved sku=${sku} from pos=${prev + 1} → pos=${i + 1}`);
        }
      }
    }
    if (specTokens.length > 0 || reranked || confidence !== 'high' || rescued > 0) {
      console.log(`[Algolia] post-rerank top 5:`);
      finalScored.slice(0, 5).forEach((s, i) => {
        console.log(
          `  ${i + 1}. score=${s.score} (spec=${s.spec} biz=${s.biz} term=${s.term} dim=${s.dim} cat=${s.cat} brand=${s.brand} ratio=${Number(s.ratio).toFixed(2)}) sku=${s.hit.sku} title="${String(s.hit.title || '').slice(0, 80)}"`
        );
      });
    }

    if (_DEBUG_SEARCH) {
      console.log(`[AlgoliaDiag] ranked list (${finalHits.length} of ${scored.length} scored) for query="${trimmed}":`);
      finalHits.forEach((h, i) => {
        const price = h.variants_min_price ?? h.price ?? '?';
        console.log(`  ${i + 1}. sku=${h.sku || '?'} price=${price} title="${String(h.title || '').slice(0, 90)}"`);
      });
      const h0 = finalHits[0];
      console.log(`[AlgoliaDiag] hit[0] product_image="${String(h0?.product_image || '').substring(0, 80)}"`);
      console.log(`[AlgoliaDiag] hit[0] objectID=${h0?.objectID} id=${h0?.id} has_variants=${Array.isArray(h0?.variants) ? h0.variants.length : 'none'}`);
    }

    // ---- Variant IDs (only for the shown hits) ------------------------------
    const skipVariants = variantsOnlyIfHigh && confidence !== 'high';
    const needsLookup = skipVariants
      ? []
      : finalHits.filter((h) => h.handle && !(Array.isArray(h.variants) && h.variants[0]?.id)).map((h) => h.handle);
    const variantMap = needsLookup.length > 0 ? await fetchVariantIdsByHandles(needsLookup, shopDomain) : new Map();

    const host = resolveStorefrontHost(shopDomain);
    const products = finalHits.map((hit) => hitToProduct(hit, variantMap, host, skipVariants));

    if (!skipVariants) _cacheSet(cacheKey, { products, confidence, topTermRatio, nbHits });

    console.log(
      `[SearchAudit] q=${JSON.stringify(trimmed)} tier=algolia filters=${JSON.stringify(filters || '')} n=${products.length} latency_ms=${Date.now() - t0} top_sku=${JSON.stringify(products[0]?.sku || '')} top_vendor=${JSON.stringify(products[0]?.vendor || '')} reranked=${reranked} confidence=${confidence} pool=${hits.length} rescued=${rescued}`
    );

    return { status: 'ok', products, confidence, topTermRatio, requestedBrand, nbHits };
  } catch (err) {
    console.error(`[Algolia] unexpected error for "${query}": ${err?.stack || err}`);
    return { ...base, status: 'error', confidence: 'error' };
  }
}

// v3-compatible wrapper: null when nothing usable.
export async function algoliaSearch(query, options = {}) {
  const r = await algoliaSearchDetailed(query, options);
  if (!r || r.status !== 'ok' || !Array.isArray(r.products) || r.products.length === 0) return null;
  return {
    products: r.products,
    confidence: r.confidence,
    topTermRatio: r.topTermRatio,
    requestedBrand: r.requestedBrand,
  };
}

// Exported for unit tests only — not part of the public search surface.
export const __internals = {
  extractSpecTokens,
  flattenStrongText,
  flattenWeakText,
  flattenHitText,
  scoreHitBySpec,
  scoreHitByBusinessSignal,
  contentTerms,
  strongTermRatio,
  extractCylinderDims,
  scoreHitByCylinderDims,
  brandAppearsInHits,
  normVendor,
  // v4
  singular,
  headNounOf,
  leafCategory,
  scoreHitByCategory,
  categoryScoreForQuery,
  routeVendorsInText,
  AMBIGUOUS_VENDOR_KEYS,
};

// ---------------------------------------------------------------------------
// Boot self-test with real catalogue records (logs only, never throws)
// ---------------------------------------------------------------------------
(function selfTestRerank() {
  try {
    const main = {
      title: '3RT2015-1AB01-1AA0 - Siemens 3-Pole Contactor, 24 V Coil (7A)', vendor: 'Siemens',
      tags: ['Automation & Control Gear', 'Contactors', 'Contactors & Auxiliary Contacts', 'Electrical Automation & Cables', 'Siemens Contactors'],
    };
    const acc = {
      title: 'Siemens Contactor Accessories 3RT2934-5NB31', vendor: 'Siemens',
      tags: ['Automation & Control Gear', 'Contactor Accessories', 'Contactors & Auxiliary Contacts', 'Electrical Automation & Cables', 'Siemens Contactor Accessories'],
    };
    const olr = {
      title: '3RT2035-1AC20 - Siemens 3RT2 Contactor Overload Relay, 60000 mA 41000 mA (3P)', vendor: 'Siemens',
      tags: ['Automation & Control Gear', 'Contactor Overload Relays', 'Contactors & Auxiliary Contacts', 'Electrical Automation & Cables', 'Siemens Contactor Overload Relays'],
    };
    const etaCb = {
      title: 'Eta Electronic Circuit Breakers ESX10-TB-101-DC24V-12A-E', vendor: 'Eta',
      tags: ['Circuit Breakers', 'Electrical Automation & Cables', 'Electronic Circuit Breakers', 'Eta Electronic Circuit Breakers', 'Fuses & Circuit Breakers'],
    };
    const eatonAcc = {
      title: 'Eaton Circuit Breaker Accessories 29364', vendor: 'Eaton',
      tags: ['Circuit Breaker Accessories', 'Circuit Breakers', 'Eaton Circuit Breaker Accessories', 'Electrical Automation & Cables', 'Fuses & Circuit Breakers'],
    };
    const smcNoTags = { title: 'Smc Pneumatic Cylinder Switches D-Z73', vendor: 'SMC' };
    const vendors = new Set(['siemens', 'delta', 'block', 'abb']);
    const vmap = new Map([
      ['siemens', new Set(['Siemens'])],
      ['delta', new Set(['Delta'])],
      ['block', new Set(['Block'])],
      ['abb', new Set(['ABB', 'Abb'])],
    ]);

    const cases = [
      ['main contactor ranks up', () => categoryScoreForQuery(main, 'contactor'), CATEGORY_MATCH_BONUS],
      ['contactor accessories sink', () => categoryScoreForQuery(acc, 'contactor'), -CATEGORY_SUBPART_PENALTY],
      ['overload relays sink for "contactor"', () => categoryScoreForQuery(olr, 'contactor'), -CATEGORY_SUBPART_PENALTY],
      ['breaker ranks up', () => categoryScoreForQuery(etaCb, 'circuit breaker'), CATEGORY_MATCH_BONUS],
      ['breaker accessories sink', () => categoryScoreForQuery(eatonAcc, 'circuit breaker'), -CATEGORY_SUBPART_PENALTY],
      ['cylinder switches sink (title fallback)', () => categoryScoreForQuery(smcNoTags, 'pneumatic cylinder'), -CATEGORY_SUBPART_PENALTY],
      ['asking for accessories flips it', () => categoryScoreForQuery(acc, 'contactor accessories'), CATEGORY_MATCH_BONUS],
      ['accessory penalty covers the plural', () => scoreHitByBusinessSignal({ title: 'Siemens Contactor Accessories 3RT2934-5NB31' }), -300],
      ['head noun before a preposition', () => headNounOf('variable frequency drive for pump'), 'drive'],
      ['"star delta timer" keeps Delta as text', () => routeVendorsInText('star delta timer', vendors, vmap, null).matched.length, 0],
      ['"terminal block" keeps Block as text', () => routeVendorsInText('terminal block', vendors, vmap, null).matched.length, 0],
      ['Delta routes when named as the brand', () => routeVendorsInText('delta vfd', vendors, vmap, 'Delta').remainder, 'vfd'],
      ['vendor strip keeps SKU punctuation', () => routeVendorsInText('Siemens 3RT2015-1AB01 contactor', vendors, vmap, 'Siemens').remainder, '3RT2015-1AB01 contactor'],
      ['brand-only query', () => routeVendorsInText('ABB', vendors, vmap, 'ABB').remainder, ''],
    ];

    const failures = [];
    for (const [name, fn, expected] of cases) {
      try {
        const got = fn();
        if (JSON.stringify(got) !== JSON.stringify(expected)) {
          failures.push(`  FAIL ${name}: got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
        }
      } catch (err) {
        failures.push(`  FAIL ${name}: threw ${err.message}`);
      }
    }
    if (failures.length) {
      console.error(`[Algolia] v4.0 rerank self-test FAILED:\n${failures.join('\n')}`);
    } else {
      console.log(`[Algolia] v4.0 rerank self-test passed (${cases.length} cases)`);
    }
  } catch (err) {
    console.error(`[Algolia] v4.0 rerank self-test crashed: ${err.message}`);
  }
})();
