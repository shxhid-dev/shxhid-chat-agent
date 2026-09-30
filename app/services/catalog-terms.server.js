// app/services/catalog-terms.server.js — v1.0 (30 Sep 2026)
// Deterministic handling of general "do you supply X?" enquiries + category-aware reranking.
// Pure functions plus one orchestrator (runPlannedSearch) that receives the search function
// as a parameter. No network, no env, no DB. Nothing in this file throws.

export const CATALOG_TERMS_VERSION = '1.0';
const NOTE_TAG = '[SYSTEM NOTE — NOT FROM USER]';
const SALES_EMAIL = 'websales@creativeautomation.ae';

/* ---------------------------------------------------------------------------
 * 1. "Do you supply …" framing
 * ------------------------------------------------------------------------- */
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

export function stripFraming(text) {
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

export function isAvailabilityQuestion(text) {
  return AVAILABILITY_RE.test(String(text ?? ''));
}

// "frp cable tray, frp enclosure" → ["frp cable tray", "frp enclosure"].
// Splits on , and ; always; on "and"/"&" only when both sides have 2+ words ("PNP and NPN sensor" stays whole).
export function splitItems(phrase) {
  const out = [];
  for (const chunk of String(phrase ?? '').split(/\s*[,;]\s*/)) {
    const andParts = chunk.split(/\s+(?:and|&)\s+/i);
    if (andParts.length > 1 && andParts.every((p) => p.trim().split(/\s+/).length >= 2)) out.push(...andParts);
    else out.push(chunk);
  }
  return out.map((s) => s.trim()).filter((s) => /[a-z]{3,}/i.test(s)).slice(0, 3);
}

/* ---------------------------------------------------------------------------
 * 2. Catalogue vocabulary (verified against the live catalogue, 30 Sep 2026)
 * ------------------------------------------------------------------------- */
const TERM_REWRITES = [
  // FRP = GRP = fibreglass = glass-fibre reinforced polyester. Titles use "polyester".
  { re: /\b(?:frp|grp|fib(?:re|er)\s?glass|glass[\s-]?fib(?:re|er)[\s-]?reinforced(?:[\s-]polyester)?)\b/gi, to: 'polyester' },
  // switchgear typos and spacing: switchgare, switchgaer, switch gear, switchgears
  { re: /\bswitch\s*g[ae]{1,2}re?s?\b/gi, to: 'switchgear' },
];

export function normalizeQuery(query) {
  let q = String(query ?? '');
  const aliases = {};
  for (const { re, to } of TERM_REWRITES) {
    q = q.replace(re, (m) => {
      if (m.toLowerCase() !== to) aliases[to] = m.length <= 4 ? m.toUpperCase() : m;
      return to;
    });
  }
  const words = q.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const deduped = words.filter((w, i) => i === 0 || w.toLowerCase() !== words[i - 1].toLowerCase());
  return { query: deduped.join(' '), aliases };
}

// Umbrella terms that never appear in titles → concrete catalogue categories.
// Add entries here only after checking the target words exist in titles/tags.
const CATEGORY_EXPANSIONS = [
  {
    label: 'switchgear',
    re: /\b(?:lv\s+|low[\s-]voltage\s+)?switchgear\b/i,
    queries: ['circuit breaker', 'contactor', 'switch disconnector'],
  },
];

export function expandCategory(query) {
  const q = String(query ?? '');
  for (const c of CATEGORY_EXPANSIONS) {
    if (!c.re.test(q)) continue;
    const rest = q.replace(c.re, ' ').replace(/\s+/g, ' ').trim(); // keeps a brand, e.g. "Siemens switchgear"
    return { label: c.label, queries: c.queries.map((x) => `${rest} ${x}`.trim()) };
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * 3. Relaxation when the exact query has no hits
 *    (replaces Algolia removeWordsIfNoResults:'lastWords', which removed the
 *    product noun — "polyester enclosure" → "polyester" → limit switches)
 * ------------------------------------------------------------------------- */
const MODIFIER_WORDS = new Set([
  'polyester', 'stainless', 'steel', 'ss', 'ss304', 'ss316', 'aluminium', 'aluminum', 'plastic',
  'polycarbonate', 'abs', 'brass', 'nylon', 'pvc', 'galvanised', 'galvanized',
  'high-performance', 'performance', 'heavy-duty', 'heavy', 'duty', 'industrial', 'premium',
  'quality', 'original', 'genuine', 'best', 'good', 'new',
]);

export function relaxQuery(query) {
  const tokens = String(query ?? '').split(/\s+/).filter(Boolean);
  const isMod = (t) => MODIFIER_WORDS.has(t.toLowerCase());
  const kept = tokens.filter((t) => !isMod(t));
  const dropped = tokens.filter(isMod);
  const out = [];
  if (dropped.length && kept.length) out.push({ query: kept.join(' '), dropped });
  if (kept.length >= 3) out.push({ query: kept.slice(1).join(' '), dropped: [...dropped, kept[0]] });
  return out.filter((r) => /[a-z]{3,}/i.test(r.query));
}

/* ---------------------------------------------------------------------------
 * 4. QueryIntel skip guard — Haiku must never decide what we stock
 * ------------------------------------------------------------------------- */
const SCOPE_REASON = /scope|not_stocked|not_sold|not_carried|unrelated_category|not_in_catalog|unsupported_category/i;
const HARD_SKIP_REASON = /career|job|vacanc|order|account|login|refund|invoice|greet|thank|acknowledg|small_?talk|troubleshoot|company_info|contact_info|polic|shipping|delivery|return/i;

export function applySkipGuard(message, qi) {
  const base = qi && typeof qi === 'object' ? qi : {};
  if (!base.skip) return { ...base, overridden: false };
  const reason = String(base.reason ?? '');
  const force = SCOPE_REASON.test(reason) || (isAvailabilityQuestion(message) && !HARD_SKIP_REASON.test(reason));
  if (!force) return { ...base, overridden: false };
  const phrase = stripFraming(message);
  if (!/[a-z]{3,}/i.test(phrase)) return { ...base, overridden: false };
  return { ...base, skip: false, query: phrase, reason: `${reason}|guard_override`, overridden: true };
}

/* ---------------------------------------------------------------------------
 * 5. Plan
 * ------------------------------------------------------------------------- */
export function planGeneralSearch(message, qi) {
  try {
    const g = applySkipGuard(message, qi);
    if (g.skip) return { skip: true, overridden: false, reason: String(g.reason ?? ''), items: [], primaryQuery: '' };
    const base = String(g.query || stripFraming(message) || '').trim();
    const raw = g.overridden ? splitItems(base) : [base];
    const items = (raw.length ? raw : [base]).filter(Boolean).map((original) => {
      const n = normalizeQuery(original);
      return { original, query: n.query, aliases: n.aliases, category: expandCategory(n.query) };
    });
    return { skip: false, overridden: !!g.overridden, reason: String(g.reason ?? ''), items, primaryQuery: items[0]?.query ?? base };
  } catch {
    const q = String(qi?.query ?? '');
    return { skip: !!qi?.skip, overridden: false, reason: 'plan_error', items: q ? [{ original: q, query: q, aliases: {}, category: null }] : [], primaryQuery: q };
  }
}

export function needsPlannedSearch(plan) {
  return !!plan && !plan.skip && (plan.items.length > 1 || plan.items.some((i) => i.category));
}

/* ---------------------------------------------------------------------------
 * 6. Orchestrator — search(query, n) → Promise<{ products: [], confidence }>
 * ------------------------------------------------------------------------- */
const usable = (r) => r.products.length > 0 && r.confidence !== 'low' && r.confidence !== 'brand_missing' && r.confidence !== 'error';

async function safeSearch(search, query, n) {
  try {
    const r = await search(query, n);
    return { products: Array.isArray(r?.products) ? r.products : [], confidence: r?.confidence ?? 'high' };
  } catch {
    return { products: [], confidence: 'error' };
  }
}

async function searchLane(lane, per, search, relaxOnly) {
  if (!(relaxOnly && lane.kind === 'item')) {
    const r0 = await safeSearch(search, lane.query, per);
    if (usable(r0)) return { ...lane, products: r0.products, status: 'found', used: lane.query, dropped: [] };
  }
  if (lane.kind === 'item') {
    for (const rx of relaxQuery(lane.query)) {
      const r = await safeSearch(search, rx.query, per);
      if (usable(r)) return { ...lane, products: r.products, status: 'relaxed', used: rx.query, dropped: rx.dropped };
    }
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

export async function runPlannedSearch(plan, { search, first = 10, relaxOnly = false } = {}) {
  try {
    if (!plan || plan.skip || typeof search !== 'function') return null;
    const lanes = [];
    for (const item of plan.items) {
      if (item.category) for (const q of item.category.queries) lanes.push({ item, query: q, kind: 'category' });
      else lanes.push({ item, query: item.query, kind: 'item' });
    }
    if (!lanes.length) return null;
    const per = Math.max(3, Math.ceil(first / lanes.length));
    const done = await Promise.all(lanes.map((l) => searchLane(l, per, search, relaxOnly)));

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
      if (d.status === 'relaxed') {
        return { asked: item.original, status: 'relaxed', shownAs: d.used, dropped: d.dropped.map((w) => item.aliases?.[w.toLowerCase()] ?? w) };
      }
      return { asked: item.original, status: 'found', shownAs: d.used };
    });

    const products = interleave(done.map((d) => d.products), first);
    let searchType;
    if (!products.length) searchType = 'no_match';
    else if (plan.items.some((i) => i.category)) searchType = 'algolia_category';
    else if (plan.items.length > 1) searchType = 'algolia_multi';
    else searchType = itemReport[0]?.status === 'relaxed' ? 'algolia_relaxed' : 'algolia_search';

    return { products, searchType, effectiveQuery: done.map((d) => d.used).join(' | '), itemReport };
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------------------
 * 7. Category-aware rerank (uses the "<Vendor> <Leaf category>" tag)
 * ------------------------------------------------------------------------- */
export const CATEGORY_MATCH_BONUS = 500;
export const CATEGORY_SUBPART_PENALTY = 900;

const HEAD_STOP = new Set(['mm', 'cm', 'kw', 'vac', 'vdc', 'hz', 'bar', 'psi', 'pnp', 'npn', 'type', 'series', 'model', 'pcs', 'nos', 'piece', 'pieces', 'price', 'stock', 'unit', 'units', 'new', 'original', 'the', 'and']);
const PREP_SPLIT = /\s(?:for|with|to|on|in|from|by|of|at|under|without)\s/i;

export function singular(word) {
  const w = String(word ?? '').toLowerCase();
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (/(ss|us|is)$/.test(w)) return w;
  if (/(ch|sh|x|z)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s')) return w.slice(0, -1);
  return w;
}

// Last noun before any preposition: "variable frequency drive for pump" → "drive".
export function headNounOf(query) {
  const firstPart = ` ${String(query ?? '').toLowerCase()} `.split(PREP_SPLIT)[0];
  const toks = firstPart
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => /^[a-z][a-z-]*[a-z]$/.test(t) && t.length >= 3 && !HEAD_STOP.has(t));
  return toks.length ? singular(toks[toks.length - 1]) : null;
}

function tagList(hit) {
  const t = hit?.tags;
  if (Array.isArray(t)) return t.map(String);
  if (typeof t === 'string') return t.split(',');
  return [];
}

export function leafCategory(hit) {
  const vendor = String(hit?.vendor ?? '').trim().toLowerCase();
  if (!vendor) return null;
  const prefix = `${vendor} `;
  for (const raw of tagList(hit)) {
    const tag = raw.trim().toLowerCase();
    if (tag.startsWith(prefix) && tag.length > prefix.length + 2) return tag.slice(prefix.length);
  }
  // Fallback for "<Vendor> <Category> <SKU>" titles without tags.
  const title = String(hit?.title ?? '').trim();
  if (title.toLowerCase().startsWith(prefix)) {
    const cat = [];
    for (const w of title.slice(prefix.length).split(/\s+/)) {
      if (!w || /\d/.test(w)) break;
      cat.push(w.toLowerCase());
    }
    if (cat.length) return cat.join(' ');
  }
  return null;
}

// +500 when the product's leaf category IS the thing asked for ("contactors" for "contactor").
// −900 when it is a sub-part of it ("contactor accessories", "cylinder switches") and the
// customer didn't ask for that sub-part. Pass the query AFTER vendor routing removed the brand.
export function scoreHitByCategory(hit, query) {
  try {
    const head = headNounOf(query);
    if (!head) return 0;
    if (head === String(hit?.vendor ?? '').trim().toLowerCase()) return 0;
    const leaf = leafCategory(hit);
    if (!leaf) return 0;
    const words = leaf.split(/[\s&/,]+/).filter(Boolean).map(singular);
    if (!words.length) return 0;
    const last = words[words.length - 1];
    if (last === head) return CATEGORY_MATCH_BONUS;
    const qWords = new Set(String(query).toLowerCase().split(/[^a-z-]+/).filter(Boolean).map(singular));
    if (words.includes(head) && !qWords.has(last)) return -CATEGORY_SUBPART_PENALTY;
    return 0;
  } catch {
    return 0;
  }
}

/* ---------------------------------------------------------------------------
 * 8. Notes for Claude + log line
 * ------------------------------------------------------------------------- */
export function buildSearchContextLine(preSearch) {
  const parts = [];
  for (const r of preSearch?.itemReport ?? []) {
    if (r.status === 'category') {
      parts.push(`"${r.asked}" is a broad category; the cards mix ${r.shownAs.join(', ')}. Confirm we supply it and ask which type, brand or rating they need.`);
    } else if (r.status === 'relaxed') {
      parts.push(`Nothing is listed for "${r.asked}" exactly; the cards are the closest "${r.shownAs}" products. Say we don't list the ${r.dropped.join(' / ')} version online, offer these as alternatives, and offer sourcing via ${SALES_EMAIL}.`);
    } else if (r.status === 'none') {
      parts.push(`Nothing is listed for "${r.asked}". Say it isn't listed online and offer sourcing via ${SALES_EMAIL}; don't say we don't supply it.`);
    }
  }
  return parts.join(' ');
}

export function buildNoMatchNote(preSearch, fallbackQuery = '') {
  const report = preSearch?.itemReport?.length
    ? preSearch.itemReport
    : [{ asked: preSearch?.effectiveQuery || fallbackQuery, status: 'none' }];
  const asked = report.map((r) => `"${r.asked}"`).join(', ');
  return [
    `${NOTE_TAG} The catalogue search found no listed product for ${asked}.`,
    `Do NOT say we don't supply or deal in it, and never call it out of scope. Say it isn't listed in our online catalogue, that our sales team can often source it, and ask the customer to email ${SALES_EMAIL} with brand, specification and quantity.`,
    'You may call search_catalog at most once more, and only with a clearly different catalogue term (a synonym or the component category). Otherwise do not search again.',
  ].join('\n');
}

export function formatPlanLog(plan, result) {
  const items = JSON.stringify((plan?.items ?? []).map((i) => i.query));
  const head = `[CatalogTerms] v=${CATALOG_TERMS_VERSION} overridden=${!!plan?.overridden} items=${items}`;
  if (!result) return `${head} result=none`;
  const rep = JSON.stringify((result.itemReport ?? []).map((r) => `${r.asked}:${r.status}`));
  return `${head} type=${result.searchType} n=${result.products?.length ?? 0} report=${rep} q="${result.effectiveQuery ?? ''}"`;
}
