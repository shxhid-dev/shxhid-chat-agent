/**
 * Search Router -- v5.0 (Simplified)
 *
 * Two paths only:
 *   SKU → Admin productVariants exact lookup (then Storefront fallback)
 *   Everything else → Storefront `search` (plain text, no filters)
 *
 * No brand gates. No vendor filters. No query classification beyond SKU
 * detection. Trust Shopify's search relevance ranking.
 *
 * Shopify docs:
 *   Storefront search:        https://shopify.dev/docs/api/storefront/latest/queries/search
 *   Admin productVariants:    https://shopify.dev/docs/api/admin-graphql/latest/queries/productVariants
 */

import { isAlgoliaConfigured, algoliaSearch } from './algolia.server.js';
import { rewriteQueryForSearch } from './query-intelligence.server.js';
import { adminTextSearch } from './admin-products.server.js';

const STOREFRONT_HOST = (process.env.STOREFRONT_HOST || "www.creativeautomation.ae").replace(/^https?:\/\//, "").replace(/^www\./, ""); // public storefront for product URLs

function plainTextFromHtml(html) {
  if (!html || typeof html !== "string") return "";
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function formatPrice(priceRangeV2) {
  if (!priceRangeV2) return null;
  const min = priceRangeV2.minVariantPrice;
  const max = priceRangeV2.maxVariantPrice;
  if (!min) return null;
  const fmt = (p) => `${parseFloat(p.amount).toFixed(2)} ${p.currencyCode || "AED"}`;
  if (max && parseFloat(max.amount) !== parseFloat(min.amount)) {
    return `${fmt(min)} - ${fmt(max)}`;
  }
  return fmt(min);
}

function pickImageUrl(product) {
  const featured = product?.featuredMedia?.preview?.image?.url;
  if (featured) return featured;
  const first = product?.images?.nodes?.[0]?.url;
  return first || null;
}

function productUrlFor(handle) {
  return `https://www.${STOREFRONT_HOST}/products/${handle}`;
}

function skuVariantToCardShape(variant) {
  const product = variant.product || {};
  return {
    id: product.id,
    title: product.title || "Untitled Product",
    handle: product.handle || null,
    vendor: product.vendor || null,
    image_url: pickImageUrl(product),
    url: product.handle ? productUrlFor(product.handle) : null,
    price: formatPrice(product.priceRangeV2),
    description: plainTextFromHtml(product.descriptionHtml).slice(0, 500),
    variant_id: variant.id,
    merchandise_id: variant.id,
    sku: variant.sku || null,
    _matchedSku: variant.sku || null,
  };
}

function storefrontProductToCardShape(p) {
  const firstVariant = (p.variants && p.variants[0]) || null;
  return {
    id: p.id,
    title: p.title || "Untitled Product",
    handle: p.handle || null,
    vendor: p.vendor || null,
    image_url: p.image_url || p.featuredImage?.url || null,
    url: p.handle ? productUrlFor(p.handle) : null,
    price: p.priceRange ? formatPrice(p.priceRange) : null,
    description: typeof p.description === "string" ? p.description.slice(0, 500) : "",
    variant_id: firstVariant?.id || null,
    merchandise_id: firstVariant?.id || null,
    sku: firstVariant?.sku || p.sku || null,
  };
}

function dedupeById(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (!it || !it.id || seen.has(it.id)) continue;
    seen.add(it.id);
    out.push(it);
  }
  return out;
}

/**
 * SKU detection -- scans every whitespace-separated token in the message.
 * Returns the first SKU-like string found, or null.
 *
 * Pattern coverage (single token):
 *   1. Standard alphanumeric SKU (>=6 chars):     ABC123, SKU-456-789, PROD_001
 *   2. Thread/metric standards:                  M12-1.5, G1/2, 3/4NPT, M8x1.25
 *   3. Explicit SKU/Part prefix:                 "SKU: ABC123", "part# 12345"
 *   4. Fraction-based parts:                     1/2BSP, 3/4NPT
 *   5. Mixed alphanumeric short codes (>=5 chars, has letter+digit)
 *
 * Multi-word inputs are supported: each token is checked independently so
 * messages like "do you have the BA25SS-STT3-A AODD pump" still find the
 * SKU "BA25SS-STT3-A".
 */
function detectSku(message) {
  const normalized = message.trim();
  if (!normalized) return null;

  // Pattern 3 first: explicit "SKU: X" / "part# X" wins regardless of word count
  // Word-bounded, and "part" only counts as a prefix when followed by
  // no/number/#/code. The old pattern matched "the part reaches near a
  // sensor" and sent "reaches" to the Admin SKU lookup. The captured code
  // must also contain a digit - real part numbers always do.
  const explicitPrefix = normalized.match(
    /\b(?:sku|p\/n|part\s*(?:no\.?|number|#|code)|model\s*(?:no\.?|number|#))\s*[:#]?\s*([A-Z0-9][A-Z0-9\-_\.\/]{2,})/i
  );
  if (explicitPrefix && /\d/.test(explicitPrefix[1])) return explicitPrefix[1];

  // Strip leading/trailing punctuation off each token, then test in order.
  const tokens = normalized
    .split(/\s+/)
    .map((w) => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ""))
    .filter(Boolean);

  for (const token of tokens) {
    const candidate = matchSkuToken(token);
    if (candidate) return candidate;
  }

  return null;
}

function matchSkuToken(token) {
  if (!token) return null;

  // Skip pure measurement tokens. Expanded list now includes pressure
  // (BAR/PSI/MPA/KPA), rotational (RPM), and frequency units that were
  // slipping into Pattern 5.
  if (/^\d+(?:BAR|PSI|MPA|KPA|MM|CM|VDC|VAC|V|A|W|KW|HP|INCH|IN|FT|FEET|FOOT|HZ|KHZ|RPM)$/i.test(token)) return null;
  if (/^IP\d{2}$/i.test(token)) return null;

  // Skip cable category tokens: Cat5, Cat5e, Cat6, Cat6a.
  if (/^CAT\d+[A-Z]?$/i.test(token)) return null;

  // Pattern 1: Standard alphanumeric SKUs (>=6 chars, contains digit+letter)
  if (/^[A-Z0-9][A-Z0-9\-_]{5,}$/i.test(token) && /[A-Za-z]/.test(token) && /\d/.test(token)) {
    return token;
  }

  // Pattern 2 (FIXED): Thread/metric codes -- REQUIRE leading letter(s).
  // Matches: M12-1.5, G1/2, M8x1.25, R1/4
  // Rejects: 1/2, 3/4, 5/2, 1.5, 2.5 (no leading letter)
  // Bare-fraction + thread suffix (3/4NPT, 1/2BSP) is handled by Pattern 4.
  if (/^[A-Z]+\d+[xX\-\/\.]\d+(?:[\.\d]*)?[A-Z]*$/i.test(token)) {
    return token;
  }

  // Pattern 4: Fraction-based part codes WITH a thread suffix (3/4NPT, 1/2BSP).
  // The trailing letters are required -- a bare "1/2" / "3/4" is a dimension.
  if (/^\d+\/\d+[A-Z]+$/i.test(token)) {
    return token;
  }

  // Pattern 5: Short mixed alphanumeric codes (>=5 chars, has letter+digit).
  // 5-6 char tokens with no separator must contain >=2 letter-digit
  // transitions to qualify — "100bar" already rejected above, this rule
  // also rejects "ABC12" (one transition) while accepting "DFS60S" (3).
  if (token.length >= 5 && /[A-Za-z]/.test(token) && /\d/.test(token) && /^[A-Z0-9\-\.\/]+$/i.test(token)) {
    const hasSeparator = /[\-\.\/]/.test(token);
    if (!hasSeparator && token.length <= 6) {
      // Count letter→digit and digit→letter transitions.
      let transitions = 0;
      for (let i = 1; i < token.length; i++) {
        const a = token[i - 1];
        const b = token[i];
        const aIsAlpha = /[A-Za-z]/.test(a);
        const bIsAlpha = /[A-Za-z]/.test(b);
        if (aIsAlpha !== bIsAlpha) transitions++;
      }
      if (transitions < 2) return null;
    }
    return token;
  }

  return null;
}

// Self-test (runs once on import; fails loudly in dev/prod logs).
(function selfTestSkuDetector() {
  const cases = [
    // Should NOT match (bare fractions, decimals, valve configs):
    { input: "1/2",   expect: null,    note: "bare fraction" },
    { input: "1/4",   expect: null,    note: "bare fraction" },
    { input: "3/4",   expect: null,    note: "bare fraction" },
    { input: "5/2",   expect: null,    note: "valve config" },
    { input: "1.5",   expect: null,    note: "bare decimal" },
    { input: "2.5",   expect: null,    note: "bare decimal" },
    { input: "inch",  expect: null,    note: "dimension word" },
    // Bug 6 additions:
    { input: "100bar", expect: null,   note: "pressure unit" },
    { input: "Cat5e",  expect: null,   note: "cable category" },
    { input: "Cat6a",  expect: null,   note: "cable category" },
    // Should match (real SKUs / thread specs):
    { input: "M12-1.5",     expect: "M12-1.5",     note: "metric thread" },
    { input: "M8x1.25",     expect: "M8x1.25",     note: "metric thread" },
    { input: "G1/2",        expect: "G1/2",        note: "BSP thread" },
    { input: "3/4NPT",      expect: "3/4NPT",      note: "thread suffix" },
    { input: "BA25SS-STT3-A", expect: "BA25SS-STT3-A", note: "AODD pump SKU" },
    { input: "BP06PP-PTT4-B", expect: "BP06PP-PTT4-B", note: "AODD pump SKU" },
    { input: "ACS580",      expect: "ACS580",      note: "short SKU" },
    { input: "DFS60S",      expect: "DFS60S",      note: "SICK encoder family" },
  ];
  // Whole-message cases for detectSku (prefix handling).
  const messageCases = [
    { input: "when the part reaches near a proximity sensor its not showing output", expect: null, note: "'part' as a normal word" },
    { input: "part# 12345", expect: "12345", note: "explicit part#" },
    { input: "SKU: ABC123", expect: "ABC123", note: "explicit SKU" },
    { input: "part no MCJI-12-32-100", expect: "MCJI-12-32-100", note: "part no" },
  ];
  const failures = [];
  for (const c of cases) {
    const got = matchSkuToken(c.input);
    if (got !== c.expect) failures.push(`  FAIL ${c.input} (${c.note}): got ${JSON.stringify(got)}, expected ${JSON.stringify(c.expect)}`);
  }
  for (const c of messageCases) {
    const got = detectSku(c.input);
    if (got !== c.expect) failures.push(`  FAIL "${c.input}" (${c.note}): got ${JSON.stringify(got)}, expected ${JSON.stringify(c.expect)}`);
  }
  if (failures.length) {
    console.error(`[SearchRouter] SKU self-test FAILED:\n${failures.join("\n")}`);
  } else {
    console.log(`[SearchRouter] SKU self-test passed (${cases.length + messageCases.length} cases)`);
  }
})();

function isConversationalMessage(msg) {
  if (!msg || typeof msg !== 'string') return true;
  const lower = msg.toLowerCase().trim();
  if (lower.length < 3) return true;

  // Pure greetings/acks with no product substance
  const pureChat = /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|sure|got it|great|perfect|sounds good|appreciate it|noted|understood|alright|cool|nice|good|fine)[\s!?.]*$/i;
  if (pureChat.test(lower)) return true;

  // A follow-up that carries a number ("what about 50 stroke", "how about
  // 24V?") is a refined search, not chit-chat -- let QueryIntel merge it
  // with the previous request.
  if (/\d/.test(lower)) return false;

  // Follow-up questions about previous results -- NOT new searches
  const followUp = /\b(other brand|another brand|different brand|any other|something else|other option|alternative|instead|other model|another model|similar to|like that|like this|show more|more like|anything else|what else|can you show|tell me more|what about|how about)\b/i;
  if (followUp.test(lower)) return true;

  // Clarifications referencing "the" / "that" / "these" --
  // they refer to already-shown results, not new queries
  const clarification = /^(the (first|second|third|last|one|product|item)|that (one|product|item)|these|those|this one|all of them|both|which one)\b/i;
  if (clarification.test(lower)) return true;

  return false;
}

function simplifyQuery(query) {
  // Drop common chat fillers AND generic industrial modifiers
  const fillers = /\b(show|me|find|search|for|looking|do|you|have|some|any|the|a|an|please|can|i|need|want|industrial|commercial|heavy|duty|professional|grade)\b/gi;
  const simplified = query.replace(fillers, "").replace(/\s+/g, " ").trim();
  return simplified.length >= 3 ? simplified : null;
}

function pluralSingularVariant(query) {
  const words = query.split(/\s+/);
  if (words.length === 0) return null;
  const last = words[words.length - 1];
  if (last.length < 4) return null;
  const variant = last.endsWith("s") ? last.slice(0, -1) : last + "s";
  if (variant === last) return null;
  return [...words.slice(0, -1), variant].join(" ");
}

function mainNoun(query) {
  const words = query.split(/\s+/).filter((w) => w.length >= 3);
  if (words.length <= 1) return null;
  // Heuristic: the last token is usually the noun ("ABB relay" → "relay")
  return words[words.length - 1];
}

function formatStorefrontResult(products, searchType, query) {
  return {
    products,
    searchType,
    systemHint: `Found ${products.length} product(s) for "${query}". Acknowledge briefly -- cards are already displayed.`,
  };
}

async function handleSkuSearch(sku, originalMessage, shopDomain) {
  console.log(`[SearchRouter] SKU detected: "${sku}" → admin lookup`);

  // Step 1: Admin API exact SKU lookup
  try {
    const { searchBySku } = await import("./admin-products.server.js");
    const result = await searchBySku(shopDomain, sku);
    if (result && result.type !== "none" && result.variants.length > 0) {
      const products = dedupeById(result.variants.map(skuVariantToCardShape));
      if (products.length > 0) {
        return {
          products,
          searchType: result.type === "exact" ? "sku_exact" : "sku_partial",
          systemHint:
            result.type === "exact"
              ? `Found exact SKU match for "${sku}". Acknowledge briefly -- the product card is already shown.`
              : `Found similar products for "${sku}". Tell the user no exact match was found and these are alternatives.`,
        };
      }
    }
  } catch (err) {
    console.warn(`[SearchRouter] Admin SKU search failed: ${err.message}`);
  }

  // Guard against short numeric tokens reaching the broad-match Storefront
  // search. A 3-char fraction matches tens of thousands of products and
  // returns garbage. Real SKUs always have letters + digits and >=5 chars.
  const tokenIsRichEnough = sku.length >= 5
    && /[A-Za-z]/.test(sku)
    && /\d/.test(sku);

  if (!tokenIsRichEnough) {
    console.log(`[SearchRouter] SKU "${sku}" too short/numeric for Storefront fallback -- returning null so caller can try text search`);
    return null;
  }

  // Step 2: Storefront search fallback (indexes variant.sku too)
  try {
    const { searchWithStorefront } = await import("../storefront-service.js");
    const result = await searchWithStorefront(sku, { first: 10, shopDomain });
    if (result?.products?.length > 0) {
      return {
        products: result.products.map(storefrontProductToCardShape),
        searchType: "sku_storefront_fallback",
        systemHint: `No exact SKU match for "${sku}" in our system. Showing related products that may be alternatives.`,
      };
    }

    // Step 3: Try without separators
    const noSep = sku.replace(/[-\.\/]/g, "");
    if (noSep !== sku && noSep.length >= 3) {
      const retry = await searchWithStorefront(noSep, { first: 10, shopDomain });
      if (retry?.products?.length > 0) {
        return {
          products: retry.products.map(storefrontProductToCardShape),
          searchType: "sku_nosep_fallback",
          systemHint: `No exact match for "${sku}". Showing products matching "${noSep}".`,
        };
      }
    }
  } catch (err) {
    console.warn(`[SearchRouter] Storefront SKU fallback failed: ${err.message}`);
  }

  return null;
}

/**
 * Three-tier search hierarchy, explicit and auditable:
 *   TIER 1 -- Algolia (primary)        single request, hitsPerPage=10
 *   TIER 2 -- Admin productByQuery     same data, tighter index, max 10
 *   TIER 3 -- Storefront search        last resort, max 10, rejects if
 *                                     totalCount > 1000 (too broad → noise)
 *
 * Algolia wins outright when it returns >=1 product -- tiers 2 and 3 are
 * never consulted in that case. QueryIntel.skip → early null (no search).
 */
async function handleTextSearch(query, shopDomain, conversationHistory = []) {
  console.log(`[SearchRouter] --- text search start: "${query}" ---`);

  // Run QueryIntel for the rewritten query that Algolia performs best on.
  let algoliaQuery = query;
  let skipSearch = false;
  let requestedBrand = null;

  if (isAlgoliaConfigured()) {
    try {
      const intel = await rewriteQueryForSearch(query, conversationHistory);
      skipSearch = intel.skip;
      algoliaQuery = intel.query || query;
      requestedBrand = intel.brand || null;
      console.log(`[SearchRouter] QueryIntel: "${query}" → "${algoliaQuery}" (skip=${skipSearch}, reason=${intel.reason})`);
    } catch (err) {
      console.warn(`[SearchRouter] QueryIntel error: ${err.message} -- using original query`);
    }
  }

  // --- EARLY EXIT: conversational input, NO product search at all ----
  // This fixes Bug B: previously Storefront ran on "hi how are you" etc.
  if (skipSearch) {
    console.log(`[SearchRouter] Conversational input detected -- skipping ALL search tiers`);
    return null;
  }

  // Holds off-target Tier 1 hits so they can be used as a last resort if
  // tiers 2 and 3 find nothing better.
  let weakAlgoliaResults = null;
  let weakAlgoliaQuery = null;

  // --- TIER 1: ALGOLIA (PRIMARY) -------------------------------------
  // Single request, max 10 results, no pagination.
  if (isAlgoliaConfigured() && algoliaQuery) {
    console.log(`[SearchRouter] TIER 1 (Algolia): querying "${algoliaQuery}"`);
    try {
      const result = await algoliaSearch(algoliaQuery, { first: 10, shopDomain, requestedBrand });
      const count = result?.products?.length || 0;
      const confidence = result?.confidence || 'high';
      console.log(`[SearchRouter] TIER 1 (Algolia): ${count} results (confidence=${confidence})`);
      if (count > 0 && confidence === 'high') {
        console.log(`[SearchRouter] OK Returning Algolia results -- tiers 2/3 NOT consulted`);
        return formatStorefrontResult(result.products, 'algolia_search', algoliaQuery);
      }
      if (count > 0 && confidence === 'brand_missing') {
        // Customer named a brand we don't carry (or that isn't indexed).
        // Show same-spec alternatives but say so explicitly, and keep the
        // catalog tools available (chat.jsx treats this path as low-confidence).
        const altVendors = [...new Set(result.products.map((p) => p.vendor).filter(Boolean))].slice(0, 3);
        console.warn(`[SearchRouter] Brand "${requestedBrand}" not found -- returning ${count} alternatives (${altVendors.join(', ')})`);
        const out = formatStorefrontResult(result.products, 'algolia_brand_missing', algoliaQuery);
        out.systemHint =
          `The customer asked for ${requestedBrand} but we have NO ${requestedBrand} products in the catalog. ` +
          `The cards show alternatives from ${altVendors.join(', ') || 'other brands'} with matching specs. ` +
          `Say clearly that ${requestedBrand} is not currently listed, present these as alternatives (never as ${requestedBrand}), ` +
          `and offer websales@creativeautomation.ae if they need ${requestedBrand} specifically.`;
        return out;
      }
      if (count > 0) {
        // Algolia matched something, but nothing in the top hit's structured
        // fields relates to the query (the "hot cylinders" → TI hot-swap
        // controllers case). Try the other tiers first; if they also come up
        // empty we still return these, flagged weak so the chat layer keeps
        // the catalog tools and Claude can re-search or say it found nothing.
        console.warn(`[SearchRouter] TIER 1 (Algolia): results look off-target -- trying tiers 2/3`);
        weakAlgoliaResults = result.products;
        weakAlgoliaQuery = algoliaQuery;
      }
    } catch (err) {
      console.warn(`[SearchRouter] TIER 1 (Algolia) ERROR: ${err.message}`);
    }
  } else {
    console.warn(`[SearchRouter] TIER 1 (Algolia) SKIPPED -- not configured. Set ALGOLIA_APP_ID, ALGOLIA_SEARCH_KEY, ALGOLIA_INDEX_NAME.`);
  }

  // --- TIER 2: SHOPIFY ADMIN (first fallback for stale Algolia index) -
  // Use Admin productVariants search rather than Storefront -- same data,
  // but indexed fields are tighter (vendor, sku, title), so noise is lower.
  console.log(`[SearchRouter] TIER 2 (Admin): falling back for "${algoliaQuery}"`);
  try {
    const adminResult = await adminTextSearch(algoliaQuery, shopDomain);
    if (adminResult?.products?.length > 0) {
      console.log(`[SearchRouter] TIER 2 (Admin): ${adminResult.products.length} results`);
      console.log(`[SearchRouter] OK Returning Admin results -- tier 3 NOT consulted`);
      const products = adminResult.products.map(storefrontProductToCardShape);
      return formatStorefrontResult(products, 'admin_text_search', algoliaQuery);
    }
    console.log(`[SearchRouter] TIER 2 (Admin): 0 results`);
  } catch (err) {
    console.warn(`[SearchRouter] TIER 2 (Admin) ERROR: ${err.message}`);
  }

  // --- TIER 3: STOREFRONT search_catalog (ABSOLUTE LAST RESORT) ------
  // Only reached when Algolia AND Admin both returned nothing.
  console.log(`[SearchRouter] TIER 3 (Storefront): last-resort fallback`);
  const { searchWithStorefront } = await import('../storefront-service.js');
  try {
    const r = await searchWithStorefront(algoliaQuery, { first: 10, shopDomain });
    const count = r?.products?.length || 0;
    console.log(`[SearchRouter] TIER 3 (Storefront): ${count} results`);
    if (count > 0) {
      // Accuracy guard: reject Storefront result if total match count is
      // suspiciously high (likely irrelevant -- common substring match).
      if (r.totalCount && r.totalCount > 1000) {
        console.warn(`[SearchRouter] TIER 3 REJECTED: totalCount=${r.totalCount} (>1000) -- query too broad, results would be irrelevant`);
        return null;
      }
      return formatStorefrontResult(
        r.products.map(storefrontProductToCardShape),
        'storefront_search_last_resort',
        algoliaQuery
      );
    }
  } catch (err) {
    console.warn(`[SearchRouter] TIER 3 (Storefront) ERROR: ${err.message}`);
  }

  // Nothing better turned up. Return the off-target Tier 1 hits rather than
  // nothing, but flagged weak: chat.jsx keeps the catalog tools available so
  // Claude can re-search or tell the customer it found no good match, instead
  // of presenting these as the answer.
  if (weakAlgoliaResults && weakAlgoliaResults.length > 0) {
    console.warn(
      `[SearchRouter] Falling back to WEAK Algolia results (${weakAlgoliaResults.length}) for "${query}"`
    );
    const weak = formatStorefrontResult(
      weakAlgoliaResults,
      'algolia_search_weak',
      weakAlgoliaQuery || query
    );
    weak.systemHint =
      `Search returned ${weakAlgoliaResults.length} product(s) for "${weakAlgoliaQuery || query}", but they may NOT match what ` +
      `the customer asked for. Check the titles against the request. If they are unrelated, say you could not find a ` +
      `match and ask a clarifying question instead of presenting them as answers.`;
    return weak;
  }

  console.log(`[SearchRouter] --- all tiers exhausted: 0 results for "${query}" ---`);
  return null;
}

export async function smartSearch(userMessage, shopDomain, conversationHistory = []) {
  if (!userMessage || !shopDomain) return null;
  const trimmed = userMessage.trim();
  if (!trimmed) return null;

  // SKU check FIRST -- an embedded part code overrides conversational phrasing.
  // "do you have the BA25SS-STT3-A AODD pump" still resolves the SKU lookup.
  const skuToken = detectSku(trimmed);
  if (skuToken) {
    const skuResult = await handleSkuSearch(skuToken, trimmed, shopDomain);
    if (skuResult) return skuResult;
    // SKU not found anywhere -- fall through to plain text search using the
    // original message, so the user gets *something* rather than a dead end.
    console.log(`[SearchRouter] SKU "${skuToken}" not found -- falling back to text search`);
  }

  if (isConversationalMessage(trimmed)) {
    return null;
  }

  return await handleTextSearch(trimmed, shopDomain, conversationHistory);
}
