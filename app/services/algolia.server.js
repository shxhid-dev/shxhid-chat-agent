/**
 * Algolia Search Service — v3.1 (Production Fix)
 *
 * CHANGES (v3.1 — May 2026):
 *
 * FIX 1: "undefined" string image — some Algolia records have the literal
 *   string "undefined" (not null) as product_image. Added explicit check:
 *   `hit.product_image !== 'undefined'` to reject this invalid value.
 *
 * FIX 2: Result count — changed default `first` from 20 to 10. Sending 20
 *   product cards overwhelms the chat UI. 10 is sufficient for the user to
 *   browse and ask follow-up questions.
 *
 * CONFIRMED field shapes from Algolia dashboard (May 2026):
 *   product_image  → string URL (the image field) — may be "undefined" string for some records
 *   price          → integer in AED (e.g. 4437)
 *   sku            → string at top level
 *   id / objectID  → numeric Shopify product ID
 *   handle         → product handle string
 *   variants       → NOT present in index (product-level index)
 *
 * Since variant IDs are not in the Algolia index, we batch-fetch them
 * from the Storefront API after getting Algolia results.
 */

let _client = null;

// -------- In-process result cache (Improvement 1) ------------------------
// Map preserves insertion order; we evict the oldest key when full.
// Keys are JSON({q, filters}) lowercased. TTL 5 min. Empty-result
// responses are NOT cached.
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
  // refresh LRU order
  _resultCache.delete(key);
  _resultCache.set(key, v);
  return { products: v.products, confidence: v.confidence || 'high' };
}

function _cacheSet(key, products, confidence) {
  if (!products || products.length === 0) return;
  if (_resultCache.size >= RESULT_CACHE_MAX) {
    const oldest = _resultCache.keys().next().value;
    if (oldest) _resultCache.delete(oldest);
  }
  _resultCache.set(key, { products, confidence: confidence || 'high', at: Date.now() });
}

const _DEBUG_SEARCH = process.env.DEBUG_SEARCH === '1';
function _vlog(...args) {
  if (_DEBUG_SEARCH) console.log(...args);
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

// -------- Vendor list cache (Bug 3 — brand-aware routing) -----------------
// Fetched once via Algolia searchForFacetValues on `vendor`, cached 24h.
// https://www.algolia.com/doc/api-reference/api-methods/search-for-facet-values/
//
// Note: `vendor` must be declared as a facetable attribute in the index
// configuration (Configuration → Facets → vendor as filterOnly). If the
// facet call returns nothing, we fall back to letting the vendor name
// remain in the free-text query.
const VENDOR_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// Vendor names are compared in a normalised form so "Carlo-gavazzi",
// "carlo gavazzi" and "CARLO_GAVAZZI" are the same brand.
export function normVendor(v) {
  return String(v || '').toLowerCase().replace(/[-_\/.]+/g, ' ').replace(/\s+/g, ' ').trim();
}

let _vendorCache = null; // { vendors: Set<string lowercase>, vendorMap: Map<string lowercase, string original>, fetchedAt: number }
let _vendorInflight = null;

async function getVendorSet(client, indexName) {
  const now = Date.now();
  if (_vendorCache && now - _vendorCache.fetchedAt < VENDOR_CACHE_TTL_MS) {
    return _vendorCache;
  }
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
        // Keep EVERY original spelling so the filter matches all of them.
        if (!vendorMap.has(key)) vendorMap.set(key, new Set());
        vendorMap.get(key).add(v);
      };

      // PRIMARY: a facet-only search returns up to maxValuesPerFacet (1000)
      // distinct values. searchForFacetValues caps at maxFacetHits=100, which
      // silently truncated the vendor list — any brand outside the top 100 by
      // count could never be routed.
      let gotAll = false;
      try {
        const facetRes = await client.search({
          requests: [{
            indexName,
            query: '',
            hitsPerPage: 0,
            facets: ['vendor'],
            maxValuesPerFacet: 1000,
          }],
        });
        const facetObj = facetRes?.results?.[0]?.facets?.vendor || {};
        for (const v of Object.keys(facetObj)) addVendor(v);
        gotAll = vendors.size > 0;
      } catch (facetErr) {
        console.warn(`[Algolia] facet-based vendor fetch failed: ${facetErr.message}`);
      }

      // FALLBACK: searchForFacetValues, still better than nothing.
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
      // Cache an empty result for 5 minutes so we don't hammer Algolia
      // on every search when the facet isn't configured.
      _vendorCache = { vendors: new Set(), vendorMap: new Map(), fetchedAt: now - VENDOR_CACHE_TTL_MS + 5 * 60 * 1000 };
      return _vendorCache;
    } finally {
      _vendorInflight = null;
    }
  })();
  return _vendorInflight;
}

/**
 * Detect vendor tokens in the query and lift them into a `filters`
 * clause. Removes the vendor word(s) from the free-text query so
 * Algolia ranks on the remaining product-type words.
 *
 * Greedy multi-word match (longest first) so "TE Connectivity" wins
 * over "TE" alone.
 */
async function applyVendorRouting(query, client, indexName) {
  if (!query || typeof query !== 'string') return { algoliaQuery: query, filters: null, matchedVendors: [] };
  const { vendors, vendorMap } = await getVendorSet(client, indexName);
  if (!vendors || vendors.size === 0) return { algoliaQuery: query, filters: null, matchedVendors: [] };

  const lower = normVendor(query);
  // Try to match each vendor (longest first) against the query as a
  // whole-word substring. Multiple vendors can match (OR them).
  const sorted = [...vendors].sort((a, b) => b.length - a.length);
  const matched = [];
  let stripped = ` ${lower} `;
  for (const v of sorted) {
    const re = new RegExp(`\\s${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s`, 'g');
    if (re.test(stripped)) {
      for (const orig of (vendorMap.get(v) || [v])) matched.push(orig);
      stripped = stripped.replace(re, ' ');
    }
  }
  if (matched.length === 0) return { algoliaQuery: query, filters: null, matchedVendors: [] };

  // Escape double quotes inside vendor names for the Algolia filter expr.
  const filters = matched
    .map((v) => `vendor:"${v.replace(/"/g, '\\"')}"`)
    .join(' OR ');

  // Rebuild the query string by mapping the stripped lower-case copy back
  // through the original (preserve user casing for the remainder).
  const remainder = stripped.trim().replace(/\s+/g, ' ');
  // If the user typed brand-only ("ABB"), remainder is empty — pass "" so
  // Algolia returns all vendor-matching products ranked by tiebreakers.
  const algoliaQuery = remainder;
  console.log(
    `[Algolia] vendor routing: matched=[${matched.join(', ')}] query="${query}" → query="${algoliaQuery}" filters=${filters}`
  );
  return { algoliaQuery, filters, matchedVendors: matched };
}

/**
 * Fetch first variant IDs for a list of product handles from Storefront API.
 * Returns a Map of handle → { variantId, variantSku }.
 *
 * Implementation note: the previous batched `products(query: handle:"x" OR handle:"y" ...)`
 * path returned zero results in production — Storefront `search` is full-text
 * and does not OR multiple handle predicates. We now fire one `productByHandle`
 * query per handle in parallel; one HTTP round-trip's worth of wall time, but
 * exact and complete.
 */
async function fetchVariantIdsByHandles(handles, shopDomain) {
  if (!handles || handles.length === 0) return new Map();
  const { shopifyStorefrontQuery } = await import('../shopify-storefront.js');
  const variantMap = new Map();

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

  await Promise.allSettled(
    handles.filter(Boolean).map(async (handle) => {
      try {
        const data = await shopifyStorefrontQuery({
          query: SINGLE_QUERY,
          variables: { handle },
          shopDomain,
        });
        const product = data?.productByHandle;
        const firstVariant = product?.variants?.edges?.[0]?.node;
        if (firstVariant) {
          variantMap.set(handle, {
            variantId: firstVariant.id,
            variantSku: firstVariant.sku || null,
          });
        }
      } catch (err) {
        console.warn(`[Algolia] variant lookup failed for "${handle}": ${err.message}`);
      }
    })
  );

  console.log(`[Algolia] variant IDs resolved: ${variantMap.size}/${handles.length}`);
  return variantMap;
}

/**
 * Helper: determine if a product_image field value is a valid URL.
 *
 * Some Algolia records store the literal string "undefined" instead of null
 * when the image was missing at sync time. We must reject this value.
 */
function isValidImageUrl(value) {
  if (!value) return false;
  if (typeof value !== 'string') return false;
  if (value === 'undefined' || value === 'null') return false; // literal strings
  return value.startsWith('http');
}

/**
 * Extract numeric+unit tokens from a query: "60mm", "60 mm", "24V",
 * "10A", "IP67", "M12". Returns [{ value: 60, unit: "mm", raw: "60mm" }]
 *
 * These are HIGH-SIGNAL tokens. A product whose title/description/SKU
 * matches the EXACT numeric value must rank above a product that
 * only matches the brand/type words.
 */
function extractSpecTokens(query) {
  if (!query || typeof query !== "string") return [];
  const tokens = [];
  // Numeric+unit: 60mm, 60 mm, 5mm, 24V, 24VDC, 100A, 1000Hz
  const re = /(\d+(?:\.\d+)?)\s*(mm|cm|m|inch|in|"|v|vdc|vac|a|w|kw|hz|khz|°c|c)\b/gi;
  let m;
  while ((m = re.exec(query)) !== null) {
    tokens.push({
      value: parseFloat(m[1]),
      unit: m[2].toLowerCase().replace("°c", "c"),
      raw: m[0].toLowerCase(),
    });
  }
  // IP ratings
  const ipRe = /\bIP(\d{2})\b/gi;
  while ((m = ipRe.exec(query)) !== null) {
    tokens.push({ value: parseInt(m[1]), unit: "ip", raw: `ip${m[1]}` });
  }
  // M-thread codes (M8, M12, M18, M30) — treat as a categorical match,
  // not a numeric range, since adjacent sizes (M8 vs M10) are different
  // products entirely, not "close enough".
  const mRe = /\bM(\d{1,2})\b/g;
  while ((m = mRe.exec(query)) !== null) {
    tokens.push({ value: parseInt(m[1]), unit: "m_thread", raw: `m${m[1]}` });
  }
  return tokens;
}

/**
 * Build all the textual surfaces of a product that we can match
 * spec tokens against (lowercased, no html). Used by the re-ranker
 * because metafields aren't in the Algolia hit but the values often
 * leak into title/description/tags.
 */
function _clean(parts) {
  return parts
    .filter(Boolean)
    .join(" ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * STRONG surfaces: structured fields that describe what the product IS.
 * A spec token found here is about the product itself.
 */
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

/**
 * WEAK surface: the marketing description. A spec token found ONLY here is
 * unreliable — "M12" in a description is usually the CONNECTOR on an M18
 * sensor, and "hot" in a TI description means hot-swap, not temperature.
 * Matches here earn partial credit, never a full match.
 */
function flattenWeakText(hit) {
  return _clean([hit.body_html_safe || hit.body_html || ""]);
}

function flattenHitText(hit) {
  return _clean([flattenStrongText(hit), flattenWeakText(hit)]);
}

// Words that carry no product meaning, stripped before term-overlap scoring.
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

/**
 * Fraction of the query's content words that appear in the hit's STRONG
 * surfaces. This is the core relevance signal: a product whose title and
 * type say nothing about what was asked for is not an answer, however
 * enthusiastically Algolia matched a stray word in its description.
 */
function strongTermRatio(hit, terms) {
  if (!terms.length) return 1;
  const strong = flattenStrongText(hit);
  let hitCount = 0;
  for (const t of terms) {
    // Singular/plural tolerance without a stemmer.
    const stem = t.replace(/(ies|es|s)$/, '');
    const pattern = stem.length >= 3 ? stem : t;
    if (strong.includes(pattern)) hitCount++;
  }
  return hitCount / terms.length;
}

/**
 * Score a hit against the query's spec tokens. EXACT numeric
 * matches earn a large positive score. Wrong numeric values earn a
 * large NEGATIVE score (so a 5mm product never outranks a 60mm
 * product when the user asked for 60mm).
 *
 * The unit-aware regex matches BOTH "60mm" and "60 mm" forms in
 * the product text — critical because the catalog uses the spaced
 * form ("60 mm") and QueryIntel emits the unspaced form ("60mm").
 */
/**
 * Inventory + accessory-aware rerank. Applied AFTER scoreHitBySpec so a
 * spec-correct product still beats an in-stock-but-wrong-size one.
 *
 * Magnitudes are tuned smaller than the spec scorer (+1000 / -800)
 * so business signals act as a tiebreaker, not an override.
 */
function scoreHitByBusinessSignal(hit) {
  let s = 0;
  if (hit.inventory_available === true) s += 200;
  if (typeof hit.inventory_quantity === 'number' && hit.inventory_quantity > 0) s += 50;

  const titleLow = (hit.title || '').toLowerCase();
  const ptLow = (hit.product_type || '').toLowerCase();
  if (
    titleLow.includes('accessory') ||
    titleLow.includes('mounting bracket') ||
    ptLow.includes('accessory')
  ) {
    s -= 300;
  }
  return s;
}

function scoreHitBySpec(hit, specTokens) {
  if (!specTokens.length) return 0;
  const strong = flattenStrongText(hit);
  const weak = flattenWeakText(hit);
  let score = 0;

  for (const tok of specTokens) {
    // Build a regex that matches the value+unit with optional whitespace.
    // For unit "m_thread" the pattern is "m12" (no space).
    let pattern;
    if (tok.unit === "m_thread") {
      pattern = new RegExp(`\\bm${tok.value}\\b`, "i");
    } else if (tok.unit === "ip") {
      pattern = new RegExp(`\\bip${tok.value}\\b`, "i");
    } else {
      pattern = new RegExp(
        `\\b${tok.value}\\s*${tok.unit}\\b`,
        "i"
      );
    }

    // Build the mismatch detector once — used for both branches below.
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
      // The product's own title/type/tags/sku carry this spec. Real match.
      score += 1000;
    } else if (pattern.test(weak)) {
      // Only the description mentions it. On an M12 query this is usually
      // an M18 sensor that happens to have an M12 CONNECTOR — partial
      // credit only, and still penalised below if the strong fields
      // advertise a conflicting value.
      score += 250;
      if (hasDifferentValue(strong)) score -= 800;
    } else if (hasDifferentValue(strong) || hasDifferentValue(weak)) {
      // Actively wrong size — user asked 60mm, product is 5mm.
      score -= 800;
    }
  }
  return score;
}

/**
 * Cylinder dimensions are ROLE-sensitive: "32 mm bore x 100 mm stroke" and
 * "100 mm bore x 32 mm stroke" contain the same numbers, and the generic spec
 * scorer above cannot tell them apart. That is how "100 stroke" returned a
 * 100 mm BORE cylinder and "32 dia 100 stroke" returned 32/300 cylinders.
 * Parse bore and stroke explicitly from the query and from the product title.
 */
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

/**
 * If the customer asked for a brand that we could not route to a vendor
 * filter, check whether ANY hit actually carries that brand. If none does,
 * the results are other brands and must not be presented as the answer
 * ("proximity sensor m18 pnp in riko brand only" returned IFM, twice).
 */
function brandAppearsInHits(brand, hits) {
  const b = normVendor(brand);
  if (!b) return true;
  return hits.some((h) => {
    const v = normVendor(h.vendor);
    if (v && (v === b || v.includes(b) || b.includes(v))) return true;
    return normVendor(`${h.title || ''} ${Array.isArray(h.tags) ? h.tags.join(' ') : h.tags || ''}`).includes(b);
  });
}

/**
 * Build the typo-policy fields for a single Algolia request.
 *
 * Per https://www.algolia.com/doc/api-reference/api-parameters/typoTolerance/
 * `typoTolerance` is a SCALAR — boolean | "min" | "strict". The
 * `allowTyposOnNumericTokens`, `minWordSizefor1Typo`, and
 * `minWordSizefor2Typos` parameters are SEPARATE top-level request
 * params. Sending them nested under `typoTolerance` produces the
 * `Invalid value for "typoTolerance" parameter, expected min, strict
 * or boolean value` error that was silently emptying Tier 1 results.
 */
function buildTypoPolicy({ looksLikeSku, hasNumericSpec }) {
  // SKU paths: turn typo tolerance off entirely.
  if (looksLikeSku) {
    return {
      typoTolerance: false,
      allowTyposOnNumericTokens: false,
      // Even when typoTolerance flips to true elsewhere, SKUs and vendor
      // names must never be typo-matched. "PS4607" can't become "PS4608"
      // and "SICK" can't become "SIEMENS" by edit distance.
      disableTypoToleranceOnAttributes: ['sku', 'vendor'],
    };
  }
  // Numeric-spec queries: keep typoTolerance for words but lock numbers.
  if (hasNumericSpec) {
    return {
      typoTolerance: true,
      allowTyposOnNumericTokens: false,
      minWordSizefor1Typo: 5,
      minWordSizefor2Typos: 9,
      disableTypoToleranceOnAttributes: ['sku', 'vendor'],
    };
  }
  // Plain text queries: default typoTolerance, still protect sku/vendor.
  return {
    typoTolerance: true,
    disableTypoToleranceOnAttributes: ['sku', 'vendor'],
  };
}

export async function algoliaSearch(query, { first = 10, shopDomain, requestedBrand = null } = {}) {
  if (!query || typeof query !== 'string') return null;
  const trimmed = query.trim();
  if (!trimmed) return null;

  // Detect if this looks like a SKU/part code — if so, search EXACTLY as-is
  const looksLikeSku = /^[A-Z0-9]{2,}[-\.][A-Z0-9][-A-Z0-9\.\/]{2,}$/i.test(trimmed) ||
    (/^[A-Z]{2,}\d{2,}/.test(trimmed) && trimmed.length >= 5 && trimmed.length <= 20);

  if (looksLikeSku) {
    _vlog(`[Algolia] SKU query detected — searching exact: "${trimmed}"`);
  }

  const indexName = process.env.ALGOLIA_INDEX_NAME || 'shopify_products';
  _vlog(`[Algolia] Searching: "${trimmed}" in "${indexName}"`);

  const _t0 = Date.now();
  const _specTokensForLog = extractSpecTokens(trimmed);
  _vlog(
    `[Algolia] OUTGOING query="${trimmed}" first=${first} typoTolerance=${
      looksLikeSku ? "off (sku)" : _specTokensForLog.length > 0 ? "numeric-locked" : "on"
    }`
  );

  let client;
  try {
    client = await getClient();
  } catch (err) {
    console.error(`[Algolia] Client init failed: ${err.message}`);
    return null;
  }

  // Build the Algolia request. typoTolerance must be a SCALAR — see
  // buildTypoPolicy() for the previous-nested-object bug history.
  const hasNumericSpec = _specTokensForLog.length > 0;
  const typoFields = buildTypoPolicy({ looksLikeSku, hasNumericSpec });

  // Vendor filter routing (Bug 3): if the query contains a known vendor
  // token, lift it out into `filters` and strip from the free-text query.
  const { algoliaQuery: queryForAlgolia, filters, matchedVendors = [] } = await applyVendorRouting(
    trimmed,
    client,
    indexName
  );

  // Result cache lookup keyed on the final outgoing query + filters.
  const cacheKey = JSON.stringify({
    q: queryForAlgolia.toLowerCase().replace(/\s+/g, ' '),
    f: filters || '',
    b: requestedBrand ? normVendor(requestedBrand) : '',
    first,
  });
  const cached = _cacheGet(cacheKey);
  if (cached) {
    console.log(
      `[SearchAudit] q=${JSON.stringify(trimmed)} tier=algolia_cache filters=${JSON.stringify(filters || '')} n=${cached.products.length} latency_ms=${Date.now() - _t0} top_sku=${JSON.stringify(cached.products[0]?.sku || '')} top_vendor=${JSON.stringify(cached.products[0]?.vendor || '')} reranked=false confidence=${cached.confidence}`
    );
    return { products: cached.products, confidence: cached.confidence, requestedBrand };
  }

  // For non-SKU, non-numeric queries, let Algolia broaden by trimming
  // tail words when zero hits — safer than the home-grown plural/main-noun
  // retry loop. https://www.algolia.com/doc/api-reference/api-parameters/removeWordsIfNoResults/
  const removeWordsPolicy =
    !looksLikeSku && !hasNumericSpec ? { removeWordsIfNoResults: 'lastWords' } : {};

  let hits = [];
  try {
    const response = await client.search({
      requests: [{
        indexName,
        query: queryForAlgolia,
        hitsPerPage: first,
        attributesToRetrieve: [
          'objectID', 'id', 'title', 'handle', 'vendor',
          'product_type', 'tags', 'body_html', 'body_html_safe',
          'price', 'variants_min_price', 'variants_max_price', 'currency_code',
          'product_image', 'image', 'featured_image', 'images',
          'variants', 'sku', 'named_tags',
          'inventory_available', 'inventory_quantity',
        ],
        ...(looksLikeSku ? { optionalWords: [] } : {}),
        ...(filters ? { filters } : {}),
        ...typoFields,
        ...removeWordsPolicy,
      }],
    });
    hits = response.results?.[0]?.hits || [];
  } catch (searchErr) {
    const msg = searchErr.message || '';
    if (
      msg.includes('does not exist') ||
      msg.includes('Index not found') ||
      searchErr.status === 404
    ) {
      console.warn(
        `[Algolia] Index "${indexName}" not found. ` +
        `Sync at dashboard.algolia.com → Data Sources → Integrations → Shopify`
      );
      return null;
    }
    console.error(`[Algolia] Search error: ${msg}`);
    return null;
  }

  // Post-Algolia re-rank. Spec score floats EXACT numeric matches and sinks
  // numeric mismatches; business-signal score is a smaller tiebreaker for
  // in-stock products and a penalty for accessory/mounting-bracket records.
  const specTokens = extractSpecTokens(trimmed);
  const cylWant = extractCylinderDims(trimmed);
  const terms = contentTerms(queryForAlgolia || trimmed);
  let _reranked = false;
  let _confidence = 'high';
  let _topRatio = 1;
  if (hits.length > 0) {
    const originalTop3 = hits.slice(0, 3).map((h) => h.sku);
    const scored = hits.map((h, idx) => {
      const spec = specTokens.length ? scoreHitBySpec(h, specTokens) : 0;
      const biz = scoreHitByBusinessSignal(h);
      // Term score rewards products whose STRUCTURED fields actually talk
      // about what was asked for, so a description-only keyword hit can no
      // longer outrank a genuine product-type match.
      const ratio = strongTermRatio(h, terms);
      const term = Math.round(400 * ratio);
      const dim = scoreHitByCylinderDims(h, cylWant);
      return { hit: h, idx, spec, biz, term, dim, ratio, score: spec + biz + term + dim };
    });

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.idx - b.idx; // Algolia's order as tiebreak
    });

    hits = scored.map((s) => s.hit);
    const newTop3 = hits.slice(0, 3).map((h) => h.sku);
    _reranked = JSON.stringify(originalTop3) !== JSON.stringify(newTop3);

    // ---- RELEVANCE FLOOR --------------------------------------------
    // Previously ANY non-empty Algolia response was treated as a
    // high-confidence answer, which is how "hot cylinders" returned
    // Texas Instruments hot-swap controllers AND stripped the catalog
    // tools so Claude could not recover. Now we grade the top hit.
    const top = scored[0];
    _topRatio = top?.ratio ?? 0;
    const reasons = [];

    // A vendor filter is itself strong evidence, so brand-only queries
    // ("Bonfiglioli worm gearbox") are exempt from the term-overlap test.
    if (!filters && terms.length > 0 && _topRatio === 0) {
      reasons.push('no query term appears in any structured field of the top hit');
    }
    if (specTokens.length > 0 && (top?.spec ?? 0) <= 0) {
      reasons.push('no product matched the requested spec');
    }
    if ((cylWant.bore != null || cylWant.stroke != null) && (top?.dim ?? 0) < 0) {
      reasons.push('no cylinder matched the requested bore/stroke');
    }
    // Brand requested but not stocked / not routable → special verdict.
    if (
      requestedBrand &&
      !matchedVendors.some((v) => normVendor(v) === normVendor(requestedBrand) || normVendor(v).includes(normVendor(requestedBrand))) &&
      !brandAppearsInHits(requestedBrand, hits)
    ) {
      _confidence = 'brand_missing';
      console.warn(`[Algolia] BRAND MISSING: "${requestedBrand}" requested but no hit carries it (top_vendor=${top?.hit?.vendor || '?'})`);
    } else if (reasons.length > 0) {
      _confidence = 'low';
      console.warn(
        `[Algolia] LOW CONFIDENCE for "${trimmed}": ${reasons.join('; ')} ` +
        `(top_sku=${top?.hit?.sku || '?'} ratio=${_topRatio.toFixed(2)} spec=${top?.spec ?? 0})`
      );
    }

    if (specTokens.length > 0) {
      console.log(`[Algolia] spec tokens detected: ${JSON.stringify(specTokens)}`);
    }
    if (_reranked) {
      // Track each top-3 movement explicitly so audits can confirm WHY a
      // demoted product is no longer rank 1.
      for (let i = 0; i < newTop3.length; i++) {
        const sku = newTop3[i];
        const prev = originalTop3.indexOf(sku);
        if (prev !== -1 && prev !== i) {
          console.log(
            `[Algolia] Business-signal rerank moved sku=${sku} from pos=${prev + 1} → pos=${i + 1}`
          );
        }
      }
    }
    if (specTokens.length > 0 || _reranked || _confidence !== 'high') {
      console.log(`[Algolia] post-rerank top 5:`);
      scored.slice(0, 5).forEach((s, i) => {
        console.log(
          `  ${i + 1}. score=${s.score} (spec=${s.spec} biz=${s.biz} term=${s.term} dim=${s.dim} ratio=${s.ratio.toFixed(2)}) sku=${s.hit.sku} title="${(s.hit.title || "").slice(0, 80)}"`
        );
      });
    }
  }

  if (hits.length === 0) {
    console.log(
      `[SearchAudit] q=${JSON.stringify(trimmed)} tier=algolia filters=${JSON.stringify(filters || '')} n=0 latency_ms=${Date.now() - _t0} top_sku="" top_vendor="" reranked=false`
    );
    return null;
  }

  _vlog(`[Algolia] ${hits.length} results for "${trimmed}"`);

  // Verbose ranked list is opt-in via DEBUG_SEARCH=1 to keep production logs lean.
  if (_DEBUG_SEARCH && hits.length > 0) {
    console.log(`[AlgoliaDiag] full ranked list (${hits.length} hits) for query="${trimmed}":`);
    hits.forEach((h, i) => {
      const price = h.variants_min_price ?? h.price ?? "?";
      console.log(
        `  ${i + 1}. sku=${h.sku || "?"} price=${price} title="${(h.title || "").slice(0, 90)}"`
      );
    });
    const h = hits[0];
    console.log(`[AlgoliaDiag] hit[0] product_image="${(h.product_image || "").substring(0, 80)}"`);
    console.log(`[AlgoliaDiag] hit[0] objectID=${h.objectID} id=${h.id} has_variants=${Array.isArray(h.variants) ? h.variants.length : "none"}`);
  }

  // Short-circuit: only call Storefront for hits that don't already carry
  // a usable variant id from Algolia. Most hits in this index are
  // product-level (no variants[]), but some have it — skip the round trip
  // when we can. Skipping the lookup entirely also avoids the 10x token
  // mint storm that motivated Bug 2.
  const needsLookup = hits
    .filter((h) => h.handle && !(Array.isArray(h.variants) && h.variants[0]?.id))
    .map((h) => h.handle);
  const variantMap = needsLookup.length > 0
    ? await fetchVariantIdsByHandles(needsLookup, shopDomain)
    : new Map();

  // Was hardcoded to the UAE store, which sent Saudi-store customers to the
  // wrong country's product pages. Prefer an explicit env var, then the shop
  // domain this request was made for.
  // Set STOREFRONT_HOST per deployment (e.g. www.creativeautomation.ae /
  // the Saudi domain). The *.myshopify.com admin domain is never used for
  // customer-facing links.
  const _shopHost = shopDomain ? String(shopDomain).replace(/^https?:\/\//, '').replace(/\/$/, '') : null;
  const STOREFRONT_HOST =
    process.env.STOREFRONT_HOST ||
    (_shopHost && !_shopHost.endsWith('.myshopify.com') ? _shopHost : null) ||
    'www.creativeautomation.ae';

  const products = hits.map((hit) => {
    const rawId = hit.objectID || hit.id || '';
    const productId = String(rawId).startsWith('gid://')
      ? rawId
      : `gid://shopify/Product/${rawId}`;

    // IMAGE (v3.1 FIX): Reject literal string "undefined" or "null" in addition to
    // falsy values. Some Algolia records have product_image = "undefined" (string).
    const imageUrl =
      (isValidImageUrl(hit.product_image) ? hit.product_image : null) ||
      (hit.image && typeof hit.image === 'object' && isValidImageUrl(hit.image.src)
        ? hit.image.src : null) ||
      (isValidImageUrl(hit.image) ? hit.image : null) ||
      (isValidImageUrl(hit.featured_image) ? hit.featured_image : null) ||
      (Array.isArray(hit.images) && isValidImageUrl(hit.images[0]) ? hit.images[0] : null) ||
      null;

    // PRICE: integer in AED (e.g. 4437), NOT cents
    const rawPrice = hit.variants_min_price ?? hit.price ?? null;
    const currency = hit.currency_code || 'AED';
    const price = rawPrice != null
      ? `${parseFloat(String(rawPrice)).toFixed(2)} ${currency}`
      : null;

    // VARIANT ID: prefer Algolia's own variant if present, else Storefront lookup.
    const algoliaVariant = Array.isArray(hit.variants) ? hit.variants[0] : null;
    const algoliaVariantRawId = algoliaVariant?.id;
    const algoliaVariantId = algoliaVariantRawId != null
      ? (String(algoliaVariantRawId).startsWith('gid://')
          ? String(algoliaVariantRawId)
          : `gid://shopify/ProductVariant/${algoliaVariantRawId}`)
      : null;
    const variantInfo = hit.handle ? variantMap.get(hit.handle) : null;
    const variantId = algoliaVariantId || variantInfo?.variantId || null;
    const variantSku =
      algoliaVariant?.sku || variantInfo?.variantSku || hit.sku || null;

    // DESCRIPTION
    const rawDesc = hit.body_html_safe || hit.body_html || '';
    const description = typeof rawDesc === 'string'
      ? rawDesc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500)
      : '';

    const result = {
      id: productId,
      title: hit.title || 'Untitled Product',
      handle: hit.handle || null,
      vendor: hit.vendor || null,
      image_url: imageUrl,
      url: hit.handle
        ? `https://${STOREFRONT_HOST}/products/${hit.handle}`
        : null,
      price,
      description,
      variant_id: variantId,
      merchandise_id: variantId,
      sku: variantSku,
    };

    if (!imageUrl) {
      console.warn(`[Algolia] No image for "${hit.title}" — product_image=${hit.product_image}`);
    }
    if (!variantId) {
      console.warn(`[Algolia] No variant_id for "${hit.title}" handle="${hit.handle}"`);
    }

    return result;
  });

  _cacheSet(cacheKey, products, _confidence);

  console.log(
    `[SearchAudit] q=${JSON.stringify(trimmed)} tier=algolia filters=${JSON.stringify(filters || '')} n=${products.length} latency_ms=${Date.now() - _t0} top_sku=${JSON.stringify(products[0]?.sku || '')} top_vendor=${JSON.stringify(products[0]?.vendor || '')} reranked=${_reranked} confidence=${_confidence}`
  );

  return { products, confidence: _confidence, topTermRatio: _topRatio, requestedBrand };
}

// Exported for unit tests only — not part of the public search surface.
export const __internals = {
  extractSpecTokens,
  flattenStrongText,
  flattenWeakText,
  scoreHitBySpec,
  scoreHitByBusinessSignal,
  contentTerms,
  strongTermRatio,
  extractCylinderDims,
  scoreHitByCylinderDims,
  brandAppearsInHits,
  normVendor,
};
