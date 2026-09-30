/**
 * Search Router — v6.0 (30 Sep 2026)
 *
 *   1. SKU in message  → Admin productVariants (exact → partial) → Storefront fallback
 *   2. Greeting / ack / "the first one" → no search
 *   3. Text → QueryIntel → enquiry plan →
 *        a. category or multi-item enquiry → one Algolia lane per sub-query, merged
 *        b. single item → T1 Algolia → T1b relaxed Algolia → T2 Admin → T3 Storefront
 *                         → weak T1 hits → null
 *
 * Contract (unchanged): smartSearch(message, shopDomain, history)
 *   → null | { products, searchType, systemHint, query, effectiveQuery, itemReport? }
 * New searchTypes algolia_category / algolia_multi / algolia_relaxed are deliberately NOT in
 * chat.jsx LOW_CONFIDENCE_PATHS: the cards are right and systemHint says what they are.
 *
 * v6.0 fixes (30 Sep 2026 logs):
 *  - QueryIntel can no longer decide what we stock ("product_category_out_of_scope" skip on
 *    "do you supply frp cable tray, frp enclosure?" is overridden).
 *  - Umbrella terms expand to catalogue categories (switchgear → circuit breaker / contactor /
 *    switch disconnector). FRP/GRP/fibreglass → "polyester" (the catalogue's word).
 *  - List enquiries are split when QueryIntel kept only one item.
 *  - Zero-hit queries are relaxed without dropping the product noun or specs; the hint says
 *    exactly which words were not matched.
 *  - Admin/Storefront results must contain the product noun in the title.
 *  - Storefront guard was totalCount > 1000, but the API caps totalCount at 1000 → now >= 1000.
 *  - "yes thank you" / "ok thanks great" are chit-chat.
 *  - Every external call has a timeout. smartSearch never throws.
 */

import * as Algolia from './algolia.server.js';
import { rewriteQueryForSearch } from './query-intelligence.server.js';
import { adminTextSearch } from './admin-products.server.js';

const ROUTER_VERSION = '6.0';
const SALES_EMAIL = 'websales@creativeautomation.ae';
const MAX_CARDS = 10;
const STOREFRONT_BROAD_TOTAL = 1000; // Storefront caps totalCount at 1000

function envMs(name, def, min) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : def;
}
const QUERY_INTEL_TIMEOUT_MS = envMs('QUERY_INTEL_TIMEOUT_MS', 6000, 1000);
const STAGE_TIMEOUT_MS = envMs('SEARCH_STAGE_TIMEOUT_MS', 12000, 2000);

const STOREFRONT_HOST = (process.env.STOREFRONT_HOST || "www.creativeautomation.ae")
  .replace(/^https?:\/\//, "")
  .replace(/\/+$/, "")
  .replace(/^www\./, ""); // public storefront for product URLs

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

// ===========================================================================
// Card shaping (unchanged)
// ===========================================================================

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

function buildResult(products, searchType, query, extra = {}) {
  const q = String(query ?? "");
  return {
    products,
    searchType,
    systemHint:
      extra.systemHint ||
      `Found ${products.length} product(s) for "${q}". Acknowledge briefly -- cards are already displayed.`,
    query: q,
    effectiveQuery: extra.effectiveQuery || q,
    ...(Array.isArray(extra.itemReport) ? { itemReport: extra.itemReport } : {}),
  };
}

// ===========================================================================
// SKU detection (unchanged from v5)
// ===========================================================================

function detectSku(message) {
  const normalized = message.trim();
  if (!normalized) return null;

  // Explicit "SKU: X" / "part# X" wins. The captured code must contain a digit.
  const explicitPrefix = normalized.match(
    /\b(?:sku|p\/n|part\s*(?:no\.?|number|#|code)|model\s*(?:no\.?|number|#))\s*[:#]?\s*([A-Z0-9][A-Z0-9\-_\.\/]{2,})/i
  );
  if (explicitPrefix && /\d/.test(explicitPrefix[1])) return explicitPrefix[1];

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

  if (/^\d+(?:BAR|PSI|MPA|KPA|MM|CM|VDC|VAC|V|A|W|KW|HP|INCH|IN|FT|FEET|FOOT|HZ|KHZ|RPM)$/i.test(token)) return null;
  if (/^IP\d{2}$/i.test(token)) return null;
  if (/^CAT\d+[A-Z]?$/i.test(token)) return null;

  // Pattern 1: standard alphanumeric SKUs (>=6 chars, digit+letter)
  if (/^[A-Z0-9][A-Z0-9\-_]{5,}$/i.test(token) && /[A-Za-z]/.test(token) && /\d/.test(token)) {
    return token;
  }
  // Pattern 2: thread/metric codes with a leading letter (M12-1.5, G1/2, M8x1.25)
  if (/^[A-Z]+\d+[xX\-\/\.]\d+(?:[\.\d]*)?[A-Z]*$/i.test(token)) {
    return token;
  }
  // Pattern 4: fraction + thread suffix (3/4NPT, 1/2BSP)
  if (/^\d+\/\d+[A-Z]+$/i.test(token)) {
    return token;
  }
  // Pattern 5: short mixed codes (>=5 chars); 5-6 chars without separator need >=2 transitions
  if (token.length >= 5 && /[A-Za-z]/.test(token) && /\d/.test(token) && /^[A-Z0-9\-\.\/]+$/i.test(token)) {
    const hasSeparator = /[\-\.\/]/.test(token);
    if (!hasSeparator && token.length <= 6) {
      let transitions = 0;
      for (let i = 1; i < token.length; i++) {
        const aIsAlpha = /[A-Za-z]/.test(token[i - 1]);
        const bIsAlpha = /[A-Za-z]/.test(token[i]);
        if (aIsAlpha !== bIsAlpha) transitions++;
      }
      if (transitions < 2) return null;
    }
    return token;
  }
  return null;
}

(function selfTestSkuDetector() {
  const cases = [
    { input: "1/2", expect: null, note: "bare fraction" },
    { input: "1/4", expect: null, note: "bare fraction" },
    { input: "3/4", expect: null, note: "bare fraction" },
    { input: "5/2", expect: null, note: "valve config" },
    { input: "1.5", expect: null, note: "bare decimal" },
    { input: "2.5", expect: null, note: "bare decimal" },
    { input: "inch", expect: null, note: "dimension word" },
    { input: "100bar", expect: null, note: "pressure unit" },
    { input: "Cat5e", expect: null, note: "cable category" },
    { input: "Cat6a", expect: null, note: "cable category" },
    { input: "M12-1.5", expect: "M12-1.5", note: "metric thread" },
    { input: "M8x1.25", expect: "M8x1.25", note: "metric thread" },
    { input: "G1/2", expect: "G1/2", note: "BSP thread" },
    { input: "3/4NPT", expect: "3/4NPT", note: "thread suffix" },
    { input: "BA25SS-STT3-A", expect: "BA25SS-STT3-A", note: "AODD pump SKU" },
    { input: "BP06PP-PTT4-B", expect: "BP06PP-PTT4-B", note: "AODD pump SKU" },
    { input: "ACS580", expect: "ACS580", note: "short SKU" },
    { input: "DFS60S", expect: "DFS60S", note: "SICK encoder family" },
  ];
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

// ===========================================================================
// General-enquiry vocabulary
// ===========================================================================

const HEAD_STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'your', 'our', 'you', 'any', 'some', 'all',
  'please', 'pls', 'need', 'want', 'have', 'has', 'supply', 'sell', 'stock', 'carry', 'provide',
  'offer', 'get', 'show', 'find', 'search', 'looking', 'look', 'price', 'prices', 'quote',
  'quotation', 'available', 'availability', 'also', 'plus', 'etc', 'such', 'very', 'only', 'just',
  'mm', 'cm', 'mtr', 'kw', 'hp', 'vac', 'vdc', 'volt', 'volts', 'amp', 'amps', 'hz', 'khz', 'bar',
  'psi', 'mpa', 'kpa', 'rpm', 'pnp', 'npn', 'nos', 'pcs', 'piece', 'pieces', 'unit', 'units',
  'qty', 'quantity', 'type', 'series', 'model', 'brand', 'make',
]);
const MATERIAL_WORDS = new Set([
  'polyester', 'stainless', 'steel', 'ss', 'ss304', 'ss316', 'aluminium', 'aluminum', 'plastic',
  'polycarbonate', 'abs', 'brass', 'nylon', 'pvc', 'galvanised', 'galvanized', 'copper',
  'ceramic', 'rubber', 'silicone', 'ptfe', 'teflon',
]);
const MARKETING_WORDS = new Set([
  'high-performance', 'performance', 'heavy-duty', 'heavy', 'duty', 'industrial', 'commercial',
  'professional', 'grade', 'premium', 'quality', 'original', 'genuine', 'best', 'good', 'new',
  'cheap', 'cheapest', 'top',
]);
// Materials we are willing to tell the customer "we don't list that version" about.
const CHECKABLE_MATERIALS = new Set([
  'polyester', 'stainless', 'aluminium', 'aluminum', 'brass', 'pvc', 'polycarbonate', 'nylon',
  'ptfe', 'ss304', 'ss316', 'galvanised', 'galvanized',
]);
const ADJECTIVE_WORDS = new Set([
  'wide', 'long', 'short', 'high', 'low', 'small', 'large', 'big', 'mini', 'open', 'closed',
  'flush', 'green', 'red', 'blue', 'black', 'white', 'yellow', 'grey', 'gray', 'orange', 'round',
  'square', 'single', 'double', 'dual', 'triple', 'normal', 'standard', 'light', 'fast', 'slow',
  'hot', 'cold', 'dry', 'wet', 'outdoor', 'indoor', 'adjustable', 'flexible', 'portable',
  'variable', 'suitable', 'compatible', 'programmable',
]);
const FOLLOWUP_WORDS = new Set([
  'other', 'another', 'different', 'alternative', 'alternatives', 'instead', 'similar', 'something',
  'anything', 'else', 'option', 'options', 'models', 'more', 'brands', 'like', 'that', 'this',
  'these', 'those', 'what', 'about', 'how', 'tell', 'can', 'could', 'one', 'ones', 'same',
  'cheaper', 'bigger', 'smaller', 'larger', 'version', 'versions',
]);
const UNIT_WORDS = new Set([
  'mm', 'cm', 'm', 'v', 'vac', 'vdc', 'dc', 'ac', 'a', 'ma', 'w', 'kw', 'hp', 'hz', 'khz', 'bar',
  'psi', 'mpa', 'kpa', 'rpm', 'inch', 'in', 'nm', 'kg',
]);
const PREP_SPLIT = /\s(?:for|with|to|on|in|from|by|of|at|under|without)\s/i;

function isModifier(w) {
  const l = String(w || '').toLowerCase();
  return MATERIAL_WORDS.has(l) || MARKETING_WORDS.has(l);
}

function singular(word) {
  const w = String(word ?? '').toLowerCase();
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (/(?:ss|us|is)$/.test(w)) return w;
  if (/(?:ch|sh|x|z)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s')) return w.slice(0, -1);
  return w;
}

// "accessory" → "accessor" so it matches both "Accessory" and "Accessories".
function stemOf(word) {
  const s = singular(word);
  return s.length > 4 && s.endsWith('y') ? s.slice(0, -1) : s;
}

function alphaWords(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((t) => /^[a-z][a-z-]*[a-z]$/.test(t) && t.length >= 3 && !HEAD_STOP.has(t));
}

// Product noun = last non-modifier word before any preposition.
// "variable frequency drive for pump" → "drive"; "polyester enclosure" → "enclosure".
function headNounOf(query) {
  const firstPart = ` ${String(query ?? '').toLowerCase()} `.split(PREP_SPLIT)[0];
  const words = alphaWords(firstPart).filter((w) => !isModifier(w));
  return words.length ? singular(words[words.length - 1]) : null;
}

function isNounLike(w) {
  const l = String(w || '').toLowerCase();
  if (l.length < 3 || ADJECTIVE_WORDS.has(l) || isModifier(l)) return false;
  return !/(?:ed|proof|ous|ful|less)$/.test(l);
}

function titleHasStem(title, stem) {
  return !!stem && String(title ?? '').toLowerCase().includes(stem);
}

function hasOwn(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

// ---- "Do you supply …" framing ----------------------------------------------
const LEADING_FRAMING = [
  /^\s*(hi|hello|hey|dear\s+\w+|good\s+(morning|afternoon|evening))\b[\s,!.:-]*/i,
  /^\s*(please|pls|kindly)\s+/i,
  /^\s*(can|could|do|does|will|would)\s+(you|u|your\s+(company|team|store|shop))\s+(please\s+)?(have|supply|sell|stock|carry|provide|offer|deal\s+(in|with)|get|source|quote(\s+for)?)\s+/i,
  /^\s*((i|we)(\s*'m|\s*'re|\s+am|\s+are)?\s+)?(looking|searching)\s+for\s+/i,
  /^\s*(i|we)\s+(need|want|require|would\s+like)\s+(to\s+(buy|order|purchase)\s+)?/i,
  /^\s*(is|are)\s+(there\s+)?/i,
  /^\s*(any|some)\s+/i,
  /^\s*(price|prices|pricing|quote|quotation|rate)\s+(of|for)\s+/i,
];
const TRAILING_FRAMING = [
  /\s+(available|in\s+stock|in\s+your\s+(store|shop|catalog|catalogue))\s*[?.!]*\s*$/i,
  /[\s,]+(please|pls|thanks|thank\s+you)\s*[?.!]*\s*$/i,
  /\s+(from\s+you|with\s+you)\s*[?.!]*\s*$/i,
];

function stripFraming(text) {
  let s = String(text ?? '').trim();
  for (let pass = 0; pass < 3; pass++) {
    const before = s;
    for (const re of LEADING_FRAMING) s = s.replace(re, '');
    for (const re of TRAILING_FRAMING) s = s.replace(re, '');
    if (s === before) break;
  }
  return s.replace(/[?!.]+\s*$/g, '').replace(/\s+/g, ' ').trim();
}

const AVAILABILITY_RE =
  /\b(do|does|can|could|will)\s+(you|u|your\s+(company|team|store|shop))\s+(have|supply|sell|stock|carry|provide|offer|deal\s+(in|with)|get|source|quote)\b|\b(looking|searching)\s+for\b|\b(available|availability|in\s+stock)\b|\b(price|prices|quote|quotation)\s+(of|for)\b/i;

function isAvailabilityQuestion(text) {
  return AVAILABILITY_RE.test(String(text ?? ''));
}

// "frp cable tray, frp enclosure" → 2 items. "and"/"&" only splits when both sides have 2+ words.
function splitItems(phrase) {
  const out = [];
  for (const chunk of String(phrase ?? '').split(/\s*[,;]\s*/)) {
    const andParts = chunk.split(/\s+(?:and|&)\s+/i);
    if (andParts.length > 1 && andParts.every((p) => p.trim().split(/\s+/).length >= 2)) out.push(...andParts);
    else out.push(chunk);
  }
  return out.map((s) => s.trim()).filter((s) => /[a-z]{3,}/i.test(s)).slice(0, 3);
}

// ---- Catalogue vocabulary (verified against the live catalogue 30 Sep 2026) ----
const TERM_REWRITES = [
  // FRP = GRP = fibreglass = glass-fibre reinforced polyester. Titles say "polyester".
  { re: /\b(?:frp|grp|fib(?:re|er)\s?glass|glass[\s-]?fib(?:re|er)[\s-]?reinforced(?:[\s-]polyester)?)\b/gi, to: 'polyester' },
  // switchgear typos and spacing: switchgare, switchgaer, switch gear, switchgears
  { re: /\bswitch\s*g[ae]{1,2}re?s?\b/gi, to: 'switchgear' },
];
// Only for list items that bypassed QueryIntel (it already maps these for single queries).
const ABBREVIATIONS = [
  { re: /\bmcbs?\b/gi, to: 'circuit breaker' },
  { re: /\bvfds?\b/gi, to: 'variable frequency drive' },
  { re: /\bssrs?\b/gi, to: 'solid state relay' },
  { re: /\b(?:smps|psus?)\b/gi, to: 'power supply' },
];

function displayTerm(m) {
  const s = String(m).trim();
  return s.length <= 5 ? s.toUpperCase() : s;
}

function normalizeQuery(query, { abbreviations = false } = {}) {
  let q = String(query ?? '');
  const aliases = Object.create(null);
  const rules = abbreviations ? [...TERM_REWRITES, ...ABBREVIATIONS] : TERM_REWRITES;
  for (const { re, to } of rules) {
    q = q.replace(re, (m) => {
      if (m.toLowerCase() !== to) {
        for (const w of to.split(' ')) if (!hasOwn(aliases, w)) aliases[w] = displayTerm(m);
      }
      return to;
    });
  }
  const words = q.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const deduped = words.filter((w, i) => i === 0 || w.toLowerCase() !== words[i - 1].toLowerCase());
  return { query: deduped.join(' '), aliases };
}

// Umbrella terms that appear in no title → catalogue categories. Verify before adding more.
const CATEGORY_EXPANSIONS = [
  {
    label: 'switchgear',
    re: /\b(?:lv\s+|low[\s-]voltage\s+)?switchgear\b/i,
    queries: ['circuit breaker', 'contactor', 'switch disconnector'],
  },
];

function expandCategory(query) {
  const q = String(query ?? '');
  for (const c of CATEGORY_EXPANSIONS) {
    if (!c.re.test(q)) continue;
    const rest = q.replace(c.re, ' ').replace(/\s+/g, ' ').trim(); // keeps a brand: "Siemens switchgear"
    return { label: c.label, queries: c.queries.map((x) => `${rest} ${x}`.trim()) };
  }
  return null;
}

// ---- QueryIntel skip guard: the catalogue decides availability, not Haiku ----
const SCOPE_REASON = /scope|not_stocked|not_sold|not_carried|unrelated_category|not_in_catalog|unsupported_category|not_our_category/i;
const HARD_SKIP_REASON = /career|job|vacanc|order|account|login|refund|invoice|greet|thank|acknowledg|small_?talk|troubleshoot|company_info|contact_info|polic|shipping|delivery|return/i;

function applySkipGuard(message, intel) {
  const base = intel && typeof intel === 'object' ? intel : {};
  if (!base.skip) return { ...base, skip: false, overridden: false };
  const reason = String(base.reason ?? '');
  const force = SCOPE_REASON.test(reason) || (isAvailabilityQuestion(message) && !HARD_SKIP_REASON.test(reason));
  if (!force) return { ...base, skip: true, overridden: false };
  const phrase = stripFraming(message);
  if (!/[a-z]{3,}/i.test(phrase)) return { ...base, skip: true, overridden: false };
  return { ...base, skip: false, query: phrase, reason: `${reason}|guard_override`, overridden: true };
}

// ---- Plan -------------------------------------------------------------------
function planEnquiry(message, intel) {
  const skipPlan = (reason) => ({ skip: true, reason, overridden: false, splitReason: null, items: [] });
  try {
    const g = applySkipGuard(message, intel);
    if (g.skip) return skipPlan(String(g.reason ?? ''));

    const stripped = stripFraming(message);
    const base = String((typeof g.query === 'string' && g.query.trim()) || stripped || message || '').trim();
    if (!base) return skipPlan('empty_query');

    let rawItems = [base];
    let splitReason = null;
    const listItems = splitItems(g.overridden ? base : stripped);
    if (listItems.length >= 2) {
      if (g.overridden) {
        rawItems = listItems;
        splitReason = 'guard_override';
      } else if (!intel) {
        rawItems = listItems;
        splitReason = 'no_queryintel';
      } else if (listItems.every((it) => alphaWords(it).length >= 2)) {
        const baseLower = base.toLowerCase();
        const uncovered = listItems.some((it) => {
          const h = headNounOf(it);
          return !!h && isNounLike(h) && !baseLower.includes(stemOf(h));
        });
        if (uncovered) {
          rawItems = listItems;
          splitReason = 'queryintel_dropped_item';
        }
      }
    }

    const expandAbbreviations = rawItems.length > 1 || !!g.overridden || !intel;
    const items = rawItems
      .slice(0, 3)
      .map((original) => {
        const n = normalizeQuery(original, { abbreviations: expandAbbreviations });
        const query = n.query || original;
        return { original, query, aliases: n.aliases, category: expandCategory(query) };
      })
      .filter((i) => i.query);
    if (!items.length) return skipPlan('empty_query');

    return { skip: false, reason: String(g.reason ?? ''), overridden: !!g.overridden, splitReason, items };
  } catch (err) {
    console.warn(`[SearchRouter] planEnquiry failed (${err.message}) -- searching the raw text`);
    const q = String((intel && !intel.skip && intel.query) || message || '').trim();
    if (!q) return skipPlan('plan_error');
    return {
      skip: false, reason: 'plan_error', overridden: false, splitReason: null,
      items: [{ original: q, query: q, aliases: Object.create(null), category: null }],
    };
  }
}

// ---- Relaxation: never drops the product noun or numeric specs ----------------
function relaxCandidates(query, brand = null) {
  const tokens = String(query ?? '').replace(/[,;]+/g, ' ').split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const lower = tokens.map((t) => t.toLowerCase());
  const isSpec = (i) => /\d/.test(lower[i]) || (UNIT_WORDS.has(lower[i]) && i > 0 && /^\d+(?:\.\d+)?$/.test(lower[i - 1]));
  const isWord = (i) => /^[a-z][a-z-]*[a-z]$/.test(lower[i]) && lower[i].length >= 3 && !HEAD_STOP.has(lower[i]);

  let headIdx = -1;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (!isSpec(i) && isWord(i) && !isModifier(lower[i])) { headIdx = i; break; }
  }
  if (headIdx < 0) return [];

  const specs = tokens.filter((_, i) => isSpec(i));
  const original = tokens.join(' ').toLowerCase();
  const out = [];
  const push = (words) => {
    let q = words.join(' ').replace(/\s+/g, ' ').trim();
    if (!q) return;
    if (brand && !q.toLowerCase().includes(String(brand).toLowerCase())) q = `${brand} ${q}`;
    const lq = q.toLowerCase();
    if (lq === original || out.some((o) => o.toLowerCase() === lq)) return;
    out.push(q);
  };

  // A: drop material / marketing modifiers
  const noMods = tokens.filter((t) => !isModifier(t));
  if (noMods.length && noMods.length < tokens.length) push(noMods);
  // B: the word before the noun + the noun (+ specs): "proximity sensor 7 mm", "cable tray"
  let prevIdx = -1;
  for (let i = headIdx - 1; i >= 0; i--) {
    if (isSpec(i)) continue;
    if (isWord(i) && !isModifier(lower[i])) prevIdx = i;
    break;
  }
  if (prevIdx >= 0) push([tokens[prevIdx], tokens[headIdx], ...specs]);
  // C: the noun alone (+ specs)
  if (lower[headIdx].length >= 4) push([tokens[headIdx], ...specs]);
  return out.slice(0, 3);
}

function droppedWords(original, used, aliases = null) {
  const usedSet = new Set(String(used ?? '').toLowerCase().split(/\s+/).filter(Boolean));
  const out = [];
  for (const w of String(original ?? '').replace(/[,;]+/g, ' ').split(/\s+/)) {
    const lw = w.toLowerCase();
    if (!lw || usedSet.has(lw) || HEAD_STOP.has(lw) || MARKETING_WORDS.has(lw)) continue;
    const shown = hasOwn(aliases, lw) ? aliases[lw] : w;
    if (!out.includes(shown)) out.push(shown);
  }
  return out;
}

// A material the customer asked for that no shown card mentions → report it honestly.
function unmetMaterials(item, products) {
  try {
    const mats = [...new Set(String(item?.query ?? '').toLowerCase().split(/\s+/).filter((w) => CHECKABLE_MATERIALS.has(w)))];
    if (!mats.length || !Array.isArray(products) || !products.length) return [];
    const text = products.slice(0, 5).map((p) => `${p?.title ?? ''} ${p?.description ?? ''}`.toLowerCase()).join(' \n ');
    const out = [];
    for (const m of mats) {
      if (text.includes(m)) continue;
      const shown = hasOwn(item?.aliases, m) ? item.aliases[m] : m;
      if (!out.includes(shown)) out.push(shown);
    }
    return out;
  } catch {
    return [];
  }
}

function relaxedLine(asked, shownAs, dropped) {
  const d = (dropped || []).filter(Boolean).join(' ');
  if (!d) {
    return `No listed product matches "${asked}" exactly. The cards are the closest "${shownAs}" products -- present them as the closest alternatives, not an exact match, and offer sourcing via ${SALES_EMAIL} for the exact item.`;
  }
  return `No listed product matches "${asked}" exactly. The cards are the closest "${shownAs}" products. Say clearly that we don't list the ${d} version online, present these as alternatives (never as ${d}), and offer sourcing via ${SALES_EMAIL}.`;
}

function planHint(report) {
  const lines = [];
  for (const r of report) {
    if (r.status === 'category') {
      lines.push(`"${r.asked}" is a broad category; the cards show a mix of ${r.shownAs.join(', ')}. Confirm we supply it, name these types in one sentence, and ask which type, brand or rating they need.`);
    } else if (r.status === 'relaxed') {
      lines.push(relaxedLine(r.asked, r.shownAs, r.dropped));
    } else if (r.status === 'found') {
      lines.push(`The cards include products for "${r.asked}".`);
    } else {
      lines.push(`Nothing is listed online for "${r.asked}" -- say it isn't listed in our online catalogue (never that we don't supply it) and offer sourcing via ${SALES_EMAIL} with brand, specification and quantity.`);
    }
  }
  lines.push('Acknowledge briefly -- cards are already displayed.');
  return lines.join(' ');
}

// ===========================================================================
// Chit-chat detection
// ===========================================================================

const ACK_ONLY_RE = /^(?:(?:hi|hello|hey|thanks|thank you|thx|ty|ok|okay|yes|yeah|yep|yup|no|nope|sure|got it|great|perfect|sounds good|appreciate it|noted|understood|alright|all right|cool|nice|good|fine|bye|goodbye|welcome|awesome|excellent)[\s,!?.]*)+$/i;

function hasOwnProductPhrase(msg) {
  return alphaWords(stripFraming(msg)).filter((w) => !FOLLOWUP_WORDS.has(w)).length >= 2;
}

function isConversationalMessage(msg) {
  if (!msg || typeof msg !== 'string') return true;
  const lower = msg.toLowerCase().trim();
  if (lower.length < 3) return true;

  // Greetings/acks, including combinations: "yes thank you", "ok thanks great"
  if (lower.length <= 60 && ACK_ONLY_RE.test(lower)) return true;

  // A follow-up carrying a number ("what about 50 stroke") is a refined search.
  if (/\d/.test(lower)) return false;

  // Follow-ups about previous results -- unless they name a product of their own
  // ("any alternative for frp enclosure" is a new search, "any other brand?" is not).
  const followUp = /\b(other brand|another brand|different brand|any other|something else|other option|alternative|instead|other model|another model|similar to|like that|like this|show more|more like|anything else|what else|can you show|tell me more|what about|how about)\b/i;
  if (followUp.test(lower)) return !hasOwnProductPhrase(lower);

  const clarification = /^(the (first|second|third|last|one|product|item)|that (one|product|item)|these|those|this one|all of them|both|which one)\b/i;
  if (clarification.test(lower)) return true;

  return false;
}

// ===========================================================================
// Search backends (each isolated, time-limited, never throws)
// ===========================================================================

function algoliaConfigured() {
  try {
    return typeof Algolia.isAlgoliaConfigured === 'function' && !!Algolia.isAlgoliaConfigured();
  } catch {
    return false;
  }
}

// Works with algolia.server.js v4 (algoliaSearchDetailed) and v3 (algoliaSearch only).
async function algoliaDetailed(query, opts) {
  const fail = (status) => ({ status, products: [], confidence: status === 'error' ? 'error' : 'none' });
  if (!algoliaConfigured()) return fail('unconfigured');
  try {
    if (typeof Algolia.algoliaSearchDetailed === 'function') {
      const r = await withTimeout(Algolia.algoliaSearchDetailed(query, opts), STAGE_TIMEOUT_MS, 'Algolia search');
      if (!r || typeof r !== 'object') return fail('error');
      return {
        status: r.status || 'ok',
        products: Array.isArray(r.products) ? r.products : [],
        confidence: r.confidence || 'high',
      };
    }
    const r = await withTimeout(Algolia.algoliaSearch(query, opts), STAGE_TIMEOUT_MS, 'Algolia search');
    if (!r) return fail('empty');
    return { status: 'ok', products: Array.isArray(r.products) ? r.products : [], confidence: r.confidence || 'high' };
  } catch (err) {
    console.warn(`[SearchRouter] Algolia call failed for "${query}": ${err.message}`);
    return fail('error');
  }
}

// Keeps only products whose TITLE contains the product noun. strict: every query word.
function relevanceGuard(products, query, { strict = false } = {}) {
  if (!Array.isArray(products) || !products.length) return [];
  const head = headNounOf(query);
  if (!head) return products;
  const headStem = stemOf(head);
  let kept = products.filter((p) => titleHasStem(p?.title, headStem));
  if (strict) {
    const stems = alphaWords(query).filter((w) => !MARKETING_WORDS.has(w)).map(stemOf);
    kept = kept.filter((p) => stems.every((s) => titleHasStem(p?.title, s)));
  }
  return kept;
}

function anyTitleHasHead(products, query) {
  const head = headNounOf(query);
  if (!head) return true;
  const stem = stemOf(head);
  return products.some((p) => titleHasStem(p?.title, stem));
}

async function guardedAdminSearch(query, shopDomain) {
  try {
    const r = await withTimeout(adminTextSearch(query, shopDomain), STAGE_TIMEOUT_MS, 'Admin text search');
    const raw = Array.isArray(r?.products) ? r.products : [];
    if (!raw.length) return [];
    const kept = relevanceGuard(dedupeById(raw.map(storefrontProductToCardShape)), query);
    if (kept.length < raw.length) {
      console.log(`[SearchRouter] Admin relevance guard kept ${kept.length}/${raw.length} for "${query}"`);
    }
    return kept;
  } catch (err) {
    console.warn(`[SearchRouter] TIER 2 (Admin) ERROR: ${err.message}`);
    return [];
  }
}

async function guardedStorefrontSearch(query, shopDomain) {
  try {
    const { searchWithStorefront } = await import('../storefront-service.js');
    const r = await withTimeout(searchWithStorefront(query, { first: MAX_CARDS, shopDomain }), STAGE_TIMEOUT_MS, 'Storefront search');
    const raw = Array.isArray(r?.products) ? r.products : [];
    console.log(`[SearchRouter] TIER 3 (Storefront): ${raw.length} results (total=${r?.totalCount ?? '?'})`);
    if (!raw.length) return [];
    const broad = Number(r?.totalCount) >= STOREFRONT_BROAD_TOTAL;
    const kept = relevanceGuard(dedupeById(raw.map(storefrontProductToCardShape)), query, { strict: broad });
    if (!kept.length) {
      console.warn(`[SearchRouter] TIER 3 REJECTED: no title contains the product noun${broad ? ' and every query word (broad query)' : ''}`);
    }
    return kept;
  } catch (err) {
    console.warn(`[SearchRouter] TIER 3 (Storefront) ERROR: ${err.message}`);
    return [];
  }
}

function brandFor(query, brand) {
  if (!brand) return null;
  return String(query ?? '').toLowerCase().includes(String(brand).toLowerCase()) ? brand : null;
}

// One precise search: Algolia (head noun required, high confidence only), Admin if Algolia is down.
async function laneQuery(query, per, ctx) {
  if (ctx.algoliaOn) {
    const r = await algoliaDetailed(query, {
      first: per,
      shopDomain: ctx.shopDomain,
      requestedBrand: brandFor(query, ctx.requestedBrand),
      requireHeadNoun: true,
      variantsOnlyIfHigh: true,
    });
    if (r.status === 'ok' || r.status === 'empty') {
      const ok = r.status === 'ok' && r.products.length > 0 && r.confidence === 'high' && anyTitleHasHead(r.products, query);
      return ok ? r.products.slice(0, per) : [];
    }
  }
  const admin = await guardedAdminSearch(query, ctx.shopDomain);
  return admin.slice(0, per);
}

// ===========================================================================
// Planned search: category / multi-item enquiries
// ===========================================================================

async function searchLane(lane, per, ctx) {
  try {
    const exact = await laneQuery(lane.query, per, ctx);
    if (exact.length) {
      const unmet = lane.kind === 'item' ? unmetMaterials(lane.item, exact) : [];
      if (unmet.length) return { ...lane, products: exact, status: 'relaxed', used: lane.query, dropped: unmet };
      return { ...lane, products: exact, status: 'found', used: lane.query, dropped: [] };
    }
    if (lane.kind === 'item') {
      for (const cand of relaxCandidates(lane.query, brandFor(lane.query, ctx.requestedBrand))) {
        const r = await laneQuery(cand, per, ctx);
        if (r.length) {
          return { ...lane, products: r, status: 'relaxed', used: cand, dropped: droppedWords(lane.query, cand, lane.item.aliases) };
        }
      }
    }
  } catch (err) {
    console.warn(`[SearchRouter] lane "${lane.query}" failed: ${err.message}`);
  }
  return { ...lane, products: [], status: 'none', used: lane.query, dropped: [] };
}

function interleave(lists, max) {
  const out = [];
  const seen = new Set();
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest && out.length < max; i++) {
    for (const l of lists) {
      const p = l[i];
      if (!p) continue;
      const key = p.id ?? p.handle ?? p.title;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
      if (out.length >= max) break;
    }
  }
  return out;
}

async function runPlannedSearch(plan, ctx) {
  const lanes = [];
  for (const item of plan.items) {
    if (item.category) for (const q of item.category.queries) lanes.push({ item, query: q, kind: 'category' });
    else lanes.push({ item, query: item.query, kind: 'item' });
  }
  if (!lanes.length) return null;
  const per = Math.max(3, Math.ceil(MAX_CARDS / lanes.length));
  console.log(`[SearchRouter] planned search: ${lanes.length} lane(s) ${JSON.stringify(lanes.map((l) => l.query))} per=${per}`);

  const done = await Promise.all(lanes.map((l) => searchLane(l, per, ctx)));

  const itemReport = plan.items.map((item) => {
    const mine = done.filter((d) => d.item === item);
    if (item.category) {
      const hits = mine.filter((d) => d.products.length);
      return hits.length
        ? { asked: item.original, status: 'category', shownAs: hits.map((d) => d.query) }
        : { asked: item.original, status: 'none' };
    }
    const d = mine[0];
    if (!d || !d.products.length) return { asked: item.original, status: 'none' };
    if (d.status === 'relaxed') return { asked: item.original, status: 'relaxed', shownAs: d.used, dropped: d.dropped };
    return { asked: item.original, status: 'found', shownAs: d.used };
  });

  const products = interleave(done.map((d) => d.products), MAX_CARDS);
  const report = JSON.stringify(itemReport.map((r) => `${r.asked}:${r.status}`));
  if (!products.length) {
    console.log(`[SearchRouter] planned search: 0 products report=${report}`);
    return null;
  }

  let searchType;
  if (plan.items.some((i) => i.category)) searchType = 'algolia_category';
  else if (plan.items.length > 1) searchType = 'algolia_multi';
  else searchType = itemReport[0]?.status === 'relaxed' ? 'algolia_relaxed' : 'algolia_search';

  const effectiveQuery = done.filter((d) => d.products.length).map((d) => d.used).join(' | ');
  console.log(`[SearchRouter] planned search: type=${searchType} n=${products.length} report=${report}`);
  return buildResult(products, searchType, effectiveQuery, { systemHint: planHint(itemReport), itemReport });
}

// ===========================================================================
// Single-item search: T1 → T1b relax → T2 → T3 → weak → null
// ===========================================================================

async function trySingleRelax(item, ctx) {
  const brand = brandFor(item.query, ctx.requestedBrand);
  for (const cand of relaxCandidates(item.query, brand)) {
    console.log(`[SearchRouter] TIER 1b (relaxed): trying "${cand}"`);
    const products = await laneQuery(cand, MAX_CARDS, ctx);
    if (products.length) {
      const dropped = droppedWords(item.query, cand, item.aliases);
      console.log(`[SearchRouter] TIER 1b (relaxed): ${products.length} results for "${cand}" (not matched: ${dropped.join(', ') || '-'})`);
      return buildResult(products, 'algolia_relaxed', cand, {
        systemHint: relaxedLine(item.original, cand, dropped),
        itemReport: [{ asked: item.original, status: 'relaxed', shownAs: cand, dropped }],
      });
    }
  }
  return null;
}

async function searchSingle(item, ctx) {
  const primary = item.query;
  let weak = null;

  // --- TIER 1: ALGOLIA ---------------------------------------------------
  if (ctx.algoliaOn) {
    console.log(`[SearchRouter] TIER 1 (Algolia): querying "${primary}"`);
    const t1 = await algoliaDetailed(primary, {
      first: MAX_CARDS,
      shopDomain: ctx.shopDomain,
      requestedBrand: ctx.requestedBrand,
    });
    const count = t1.products.length;
    const confidence = t1.confidence;
    console.log(`[SearchRouter] TIER 1 (Algolia): ${count} results (confidence=${confidence})`);

    if (count > 0 && confidence === 'high') {
      const unmet = unmetMaterials(item, t1.products);
      if (unmet.length) {
        console.log(`[SearchRouter] TIER 1: no card mentions [${unmet.join(', ')}] -- returned as closest match`);
        return buildResult(t1.products, 'algolia_relaxed', primary, {
          systemHint: relaxedLine(item.original, primary, unmet),
          itemReport: [{ asked: item.original, status: 'relaxed', shownAs: primary, dropped: unmet }],
        });
      }
      console.log(`[SearchRouter] OK Returning Algolia results -- tiers 2/3 NOT consulted`);
      return buildResult(t1.products, 'algolia_search', primary);
    }

    if (count > 0 && confidence === 'brand_missing') {
      const brand = ctx.requestedBrand || 'the requested brand';
      const altVendors = [...new Set(t1.products.map((p) => p.vendor).filter(Boolean))].slice(0, 3);
      console.warn(`[SearchRouter] Brand "${brand}" not found -- returning ${count} alternatives (${altVendors.join(', ')})`);
      return buildResult(t1.products, 'algolia_brand_missing', primary, {
        systemHint:
          `The customer asked for ${brand} but we have NO ${brand} products in the catalog. ` +
          `The cards show alternatives from ${altVendors.join(', ') || 'other brands'} with matching specs. ` +
          `Say clearly that ${brand} is not currently listed, present these as alternatives (never as ${brand}), ` +
          `and offer ${SALES_EMAIL} if they need ${brand} specifically.`,
      });
    }

    if (count > 0) {
      console.warn(`[SearchRouter] TIER 1 (Algolia): results look off-target -- trying relaxed query, then tiers 2/3`);
      weak = { products: t1.products, query: primary };
    }

    if (t1.status === 'ok' || t1.status === 'empty') {
      const relaxed = await trySingleRelax(item, ctx);
      if (relaxed) return relaxed;
    }
  } else {
    console.warn(`[SearchRouter] TIER 1 (Algolia) SKIPPED -- not configured. Set ALGOLIA_APP_ID, ALGOLIA_SEARCH_KEY, ALGOLIA_INDEX_NAME.`);
  }

  // --- TIER 2: ADMIN (title must contain the product noun) -------------------
  console.log(`[SearchRouter] TIER 2 (Admin): falling back for "${primary}"`);
  const adminProducts = await guardedAdminSearch(primary, ctx.shopDomain);
  if (adminProducts.length) {
    console.log(`[SearchRouter] TIER 2 (Admin): ${adminProducts.length} results -- tier 3 NOT consulted`);
    return buildResult(adminProducts.slice(0, MAX_CARDS), 'admin_text_search', primary);
  }
  console.log(`[SearchRouter] TIER 2 (Admin): 0 relevant results`);

  // --- TIER 3: STOREFRONT (last resort) -------------------------------------
  console.log(`[SearchRouter] TIER 3 (Storefront): last-resort fallback`);
  const sfProducts = await guardedStorefrontSearch(primary, ctx.shopDomain);
  if (sfProducts.length) {
    return buildResult(sfProducts.slice(0, MAX_CARDS), 'storefront_search_last_resort', primary);
  }

  // --- Weak Tier 1 hits, flagged so chat.jsx keeps the catalog tools ---------
  if (weak && weak.products.length > 0) {
    console.warn(`[SearchRouter] Falling back to WEAK Algolia results (${weak.products.length}) for "${weak.query}"`);
    return buildResult(weak.products, 'algolia_search_weak', weak.query, {
      systemHint:
        `Search returned ${weak.products.length} product(s) for "${weak.query}", but they may NOT match what ` +
        `the customer asked for. Check the titles against the request. If they are unrelated, say you could not find a ` +
        `match and ask a clarifying question instead of presenting them as answers.`,
    });
  }

  console.log(`[SearchRouter] --- all tiers exhausted: 0 results for "${primary}" ---`);
  return null;
}

// ===========================================================================
// SKU path
// ===========================================================================

async function handleSkuSearch(sku, originalMessage, shopDomain) {
  console.log(`[SearchRouter] SKU detected: "${sku}" → admin lookup`);

  // Step 1: Admin API exact SKU lookup
  try {
    const { searchBySku } = await import("./admin-products.server.js");
    const result = await withTimeout(searchBySku(shopDomain, sku), STAGE_TIMEOUT_MS, "Admin SKU search");
    if (result && result.type !== "none" && Array.isArray(result.variants) && result.variants.length > 0) {
      const products = dedupeById(result.variants.map(skuVariantToCardShape));
      if (products.length > 0) {
        const exact = result.type === "exact";
        return buildResult(products, exact ? "sku_exact" : "sku_partial", sku, {
          systemHint: exact
            ? `Found exact SKU match for "${sku}". Acknowledge briefly -- the product card is already shown.`
            : `Found similar products for "${sku}". Tell the user no exact match was found and these are alternatives.`,
        });
      }
    }
  } catch (err) {
    console.warn(`[SearchRouter] Admin SKU search failed: ${err.message}`);
  }

  // Short/numeric tokens must not reach the broad Storefront search.
  const tokenIsRichEnough = sku.length >= 5 && /[A-Za-z]/.test(sku) && /\d/.test(sku);
  if (!tokenIsRichEnough) {
    console.log(`[SearchRouter] SKU "${sku}" too short/numeric for Storefront fallback -- returning null so caller can try text search`);
    return null;
  }

  // Step 2: Storefront search fallback (indexes variant.sku too)
  try {
    const { searchWithStorefront } = await import("../storefront-service.js");
    const result = await withTimeout(searchWithStorefront(sku, { first: MAX_CARDS, shopDomain }), STAGE_TIMEOUT_MS, "Storefront SKU search");
    if (result?.products?.length > 0) {
      return buildResult(result.products.map(storefrontProductToCardShape), "sku_storefront_fallback", sku, {
        systemHint: `No exact SKU match for "${sku}" in our system. Showing related products that may be alternatives.`,
      });
    }

    // Step 3: try without separators
    const noSep = sku.replace(/[-\.\/]/g, "");
    if (noSep !== sku && noSep.length >= 3) {
      const retry = await withTimeout(searchWithStorefront(noSep, { first: MAX_CARDS, shopDomain }), STAGE_TIMEOUT_MS, "Storefront SKU search");
      if (retry?.products?.length > 0) {
        return buildResult(retry.products.map(storefrontProductToCardShape), "sku_nosep_fallback", noSep, {
          systemHint: `No exact match for "${sku}". Showing products matching "${noSep}".`,
        });
      }
    }
  } catch (err) {
    console.warn(`[SearchRouter] Storefront SKU fallback failed: ${err.message}`);
  }

  return null;
}

// ===========================================================================
// Text path
// ===========================================================================

async function handleTextSearch(query, shopDomain, conversationHistory = []) {
  console.log(`[SearchRouter] --- text search start: "${query}" ---`);
  const algoliaOn = algoliaConfigured();

  // QueryIntel (Haiku rewrite). Runs only when Algolia is configured, as before.
  let intel = null;
  if (algoliaOn) {
    try {
      intel = await withTimeout(rewriteQueryForSearch(query, conversationHistory), QUERY_INTEL_TIMEOUT_MS, 'QueryIntel');
      if (intel && typeof intel !== 'object') intel = null;
      console.log(`[SearchRouter] QueryIntel: "${query}" → "${intel?.query || query}" (skip=${!!intel?.skip}, reason=${intel?.reason})`);
    } catch (err) {
      console.warn(`[SearchRouter] QueryIntel error: ${err.message} -- using original query`);
      intel = null;
    }
  }

  const plan = planEnquiry(query, intel);
  if (plan.skip) {
    console.log(`[SearchRouter] Conversational input detected -- skipping ALL search tiers (reason=${plan.reason || 'n/a'})`);
    return null;
  }
  if (plan.overridden) {
    console.log(`[SearchRouter] QueryIntel skip overridden (${intel?.reason}) -- searching ${JSON.stringify(plan.items.map((i) => i.query))}`);
  }
  if (plan.splitReason && !plan.overridden) {
    console.log(`[SearchRouter] list enquiry split (${plan.splitReason}): ${JSON.stringify(plan.items.map((i) => i.query))}`);
  }

  const ctx = { shopDomain, algoliaOn, requestedBrand: intel?.brand || null };

  if (plan.items.length > 1 || plan.items.some((i) => i.category)) {
    return await runPlannedSearch(plan, ctx);
  }
  return await searchSingle(plan.items[0], ctx);
}

// ===========================================================================
// Public entry point
// ===========================================================================

export async function smartSearch(userMessage, shopDomain, conversationHistory = []) {
  try {
    if (!userMessage || typeof userMessage !== "string" || !shopDomain) return null;
    const trimmed = userMessage.trim();
    if (!trimmed) return null;
    const history = Array.isArray(conversationHistory) ? conversationHistory : [];

    // SKU check FIRST -- an embedded part code overrides conversational phrasing.
    const skuToken = detectSku(trimmed);
    if (skuToken) {
      const skuResult = await handleSkuSearch(skuToken, trimmed, shopDomain);
      if (skuResult) return skuResult;
      console.log(`[SearchRouter] SKU "${skuToken}" not found -- falling back to text search`);
    }

    if (isConversationalMessage(trimmed)) return null;

    return await handleTextSearch(trimmed, shopDomain, history);
  } catch (err) {
    console.error(`[SearchRouter] smartSearch failed -- returning null so Claude can search itself: ${err?.stack || err}`);
    return null;
  }
}

// ===========================================================================
// Boot self-test for the enquiry planner (logs only, never throws)
// ===========================================================================

(function selfTestEnquiryPlanner() {
  const cases = [
    ['strip framing', () => stripFraming('do you supply frp cable tray, frp enclosure?'), 'frp cable tray, frp enclosure'],
    ['strip greeting', () => stripFraming('Hi, do you have Siemens contactor?'), 'Siemens contactor'],
    ['FRP: skip overridden + split', () => planEnquiry('do you supply frp cable tray, frp enclosure?', { skip: true, reason: 'product_category_out_of_scope', query: '' }).items.map((i) => i.query), ['polyester cable tray', 'polyester enclosure']],
    ['FRP: QueryIntel dropped an item', () => planEnquiry('do you supply frp cable tray, frp enclosure?', { skip: false, query: 'FRP cable tray' }).items.length, 2],
    ['spec list is not split', () => planEnquiry('do you have 24V power supply, din rail mounted', { skip: false, query: '24V DIN rail power supply' }).items.length, 1],
    ['switchgear expands', () => planEnquiry('do you supply switchgare', { skip: false, query: 'switchgear' }).items[0].category?.queries, ['circuit breaker', 'contactor', 'switch disconnector']],
    ['careers stays skipped', () => planEnquiry('help me find job here', { skip: true, reason: 'no_product_search_intent_careers_inquiry' }).skip, true],
    ['troubleshooting stays skipped', () => planEnquiry('Solution for cylinder leakage', { skip: true, reason: 'troubleshooting_no_product_search_intent' }).skip, true],
    ['"yes thank you" is chit-chat', () => isConversationalMessage('yes thank you'), true],
    ['follow-up with a product is a search', () => isConversationalMessage('any alternative for frp enclosure'), false],
    ['"what about siemens" stays a follow-up', () => isConversationalMessage('what about siemens'), true],
    ['relax keeps the noun', () => relaxCandidates('polyester cable tray'), ['cable tray', 'tray']],
    ['relax keeps specs', () => relaxCandidates('inductive proximity sensor 7 mm'), ['proximity sensor 7 mm', 'sensor 7 mm']],
    ['head noun before preposition', () => headNounOf('variable frequency drive for pump'), 'drive'],
    ['dropped word uses customer term', () => droppedWords('polyester enclosure', 'enclosure', { polyester: 'FRP' }), ['FRP']],
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
    console.error(`[SearchRouter] v${ROUTER_VERSION} enquiry self-test FAILED:\n${failures.join('\n')}`);
  } else {
    console.log(`[SearchRouter] v${ROUTER_VERSION} enquiry self-test passed (${cases.length} cases)`);
  }
})();

// Exported for unit tests only.
export const __routerInternals = {
  detectSku,
  matchSkuToken,
  isConversationalMessage,
  stripFraming,
  isAvailabilityQuestion,
  splitItems,
  normalizeQuery,
  expandCategory,
  applySkipGuard,
  planEnquiry,
  relaxCandidates,
  droppedWords,
  unmetMaterials,
  headNounOf,
  relevanceGuard,
};
