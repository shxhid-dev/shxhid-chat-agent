// app/services/photo-search.server.js — v1.0
//
// PHOTO MATCHING: turns what image-intel read from a photo into a ranked, honest set of cards.
//
//   1. Part number read  → smartSearch(part number) (router SKU path). sku_exact → done, "high".
//   2. Otherwise up to 3 of the analysis' search_queries run through smartSearch in parallel.
//   3. Every product is scored against the photo: part number, brand, distinctive terms
//      ("M23", "17 pin", "female"), product-type noun, printed specs, query priority / rank.
//   4. Dropped: products without the type noun, without any distinctive term (when the photo
//      has some), or under 35% of the best score.
//   5. Confidence: high / medium / low / none (rules in classifyMatch). low → at most 3 cards,
//      none → no cards; Claude then says so and asks for the part number or specs.
//
// Pure scoring is exported for tests; photoSearch() never throws.

export const PHOTO_SEARCH_VERSION = "1.0.0";

const MAX_CARDS = 6;
const MAX_LOW_CARDS = 3;
const MAX_QUERIES = 3;
const SCORE_FLOOR = 0.35;

const LABELS = {
  high: "Strong match",
  medium: "Likely match",
  low: "Possible matches",
  none: "No good match",
};

// ─── Text helpers ──────────────────────────────────────────────────────

function norm(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/(\d)\s*-\s*(pin|pole|way|wire)/g, "$1 $2")
    .replace(/[^a-z0-9/.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compact(text) {
  return String(text ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function singular(word) {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** "M23" in "Harting M23 Connector 17-pol"; "17 pin" also matches "17-pin" and "17pin". */
export function hasTerm(text, term) {
  const t = norm(term);
  if (!t) return false;
  const hay = ` ${norm(text)} `;
  // Thread / body sizes: "M8" also matches "M8x1", "M12x1-A", "M8 x 1"; "M12x1" matches a plain
  // "M12". The size must end there, so "M8" never matches "M80".
  const thread = /^m(\d+(?:\.\d+)?)(?: ?x ?\d+(?:\.\d+)?)?$/.exec(t);
  if (thread) {
    const size = thread[1].replace(".", "\\.");
    return new RegExp(` m${size}(?: ?x ?\\d+(?:\\.\\d+)?)? `).test(hay);
  }
  if (hay.includes(` ${t} `)) return true;
  // plural/singular of the last word ("connector" ↔ "connectors")
  const words = t.split(" ");
  const last = words[words.length - 1];
  const alt = [...words.slice(0, -1), singular(last) === last ? `${last}s` : singular(last)].join(" ");
  if (hay.includes(` ${alt} `)) return true;
  // "17pin" / "17-pin": compare without separators, only for mixed letter+digit terms
  const c = compact(term);
  return c.length >= 4 && /\d/.test(c) && /[a-z]/.test(c) && compact(text).includes(c);
}

/** Last meaningful word of the product type: "inductive proximity sensor" → "sensor". */
export function typeNoun(productType) {
  const words = norm(productType).split(" ").filter((w) => w.length > 2 && !/\d/.test(w));
  return words.length ? singular(words[words.length - 1]) : "";
}

// ─── Scoring (pure) ────────────────────────────────────────────────────

/**
 * Score one product against the photo analysis.
 * source = { queryIndex, rank, exactSku } — where the product came from.
 */
export function scoreProduct(product, analysis, source = {}) {
  const title = product?.title || "";
  const sku = product?.sku || "";
  const vendor = product?.vendor || "";
  const desc = product?.description || "";
  const titleAndSku = `${title} ${sku}`;
  const all = `${title} ${sku} ${vendor} ${desc}`;

  let score = 0;
  let exactPart = !!source.exactSku;

  for (const pn of analysis?.partNumbers || []) {
    const c = compact(pn);
    if (c.length < 4) continue;
    if (compact(sku) === c || (c.length >= 5 && compact(titleAndSku).includes(c))) {
      exactPart = true;
    } else if (c.length >= 6 && compact(sku).startsWith(c.slice(0, Math.ceil(c.length * 0.7)))) {
      score += 35; // same series / family
    }
  }
  if (exactPart) score += 100;

  const brandHit = !!analysis?.brand && (hasTerm(vendor, analysis.brand) || hasTerm(title, analysis.brand));
  if (brandHit) score += 15;

  const terms = analysis?.distinctiveTerms || [];
  let termsHit = 0;
  for (const term of terms) {
    if (hasTerm(titleAndSku, term)) {
      termsHit++;
      score += 14;
    } else if (hasTerm(desc, term)) {
      termsHit++;
      score += 6;
    } else {
      score -= 12;
    }
  }

  const noun = typeNoun(analysis?.productType);
  const typeHit = !noun || hasTerm(title, noun) || hasTerm(product?.productType || "", noun);
  score += typeHit ? 10 : -10;

  let specHits = 0;
  for (const spec of analysis?.keySpecs || []) {
    if (specHits < 3 && hasTerm(all, spec)) {
      specHits++;
      score += 3;
    }
  }

  const queryIndex = Number.isFinite(source.queryIndex) ? source.queryIndex : 0;
  const rank = Number.isFinite(source.rank) ? source.rank : 0;
  score += Math.max(0, 6 - queryIndex * 2) + Math.max(0, (10 - rank) * 0.4);

  return { score, exactPart, brandHit, termsHit, termsTotal: terms.length, typeHit };
}

export function matchLabelFor(s) {
  if (s.exactPart) return "Exact part number";
  if (s.typeHit && s.termsTotal > 0 && s.termsHit === s.termsTotal) return "Strong match";
  if (s.termsHit > 0) return "Partial match";
  return "Similar";
}

/** Confidence of the best-scored product. */
export function classifyMatch(top, analysis) {
  if (!top) return "none";
  if (top.exactPart) return "high";
  if (!top.typeHit) return "none";
  const terms = top.termsTotal;
  const brandOk = top.brandHit || !analysis?.brand;
  if (terms > 0 && top.termsHit === terms && brandOk) return "high";
  if (terms > 0 ? top.termsHit >= Math.ceil(terms / 2) : top.brandHit) return "medium";
  return "low";
}

function productKey(p) {
  return p?.id || p?.handle || p?.title || null;
}

/**
 * candidates: [{ products, queryIndex, exactSku }] in query priority order.
 * Returns { products, confidence, label, reasons } with match_label / match_score on each card.
 */
export function rankPhotoCandidates(candidates, analysis) {
  const best = new Map();
  for (const c of Array.isArray(candidates) ? candidates : []) {
    (Array.isArray(c?.products) ? c.products : []).forEach((product, rank) => {
      const key = productKey(product);
      if (!key) return;
      const s = scoreProduct(product, analysis, { queryIndex: c.queryIndex, rank, exactSku: c.exactSku });
      const prev = best.get(key);
      if (!prev || s.score > prev.s.score) best.set(key, { product, s });
    });
  }

  let scored = [...best.values()].sort((a, b) => b.s.score - a.s.score);
  scored = scored.filter((x) => x.s.exactPart || (x.s.typeHit && (x.s.termsTotal === 0 || x.s.termsHit > 0)));
  const topScore = scored[0]?.s.score ?? 0;
  if (topScore > 0) scored = scored.filter((x) => x.s.exactPart || x.s.score >= topScore * SCORE_FLOOR);

  const confidence = classifyMatch(scored[0]?.s, analysis);
  const limit = confidence === "none" ? 0 : confidence === "low" ? MAX_LOW_CARDS : MAX_CARDS;
  const kept = scored.slice(0, limit);

  const products = kept.map(({ product, s }) => ({
    ...product,
    match_label: matchLabelFor(s),
    match_score: Math.round(s.score),
  }));

  const reasons = [];
  const top = kept[0];
  if (top) {
    if (top.s.exactPart) reasons.push("the part number on the photo matches the catalogue");
    if (top.s.brandHit) reasons.push(`brand ${analysis.brand}`);
    const shownTerms = (analysis?.distinctiveTerms || []).filter((t) =>
      hasTerm(`${top.product.title} ${top.product.sku || ""} ${top.product.description || ""}`, t)
    );
    if (shownTerms.length) reasons.push(`shows ${shownTerms.join(", ")}`);
    const missing = (analysis?.distinctiveTerms || []).filter((t) => !shownTerms.includes(t));
    if (missing.length) reasons.push(`not confirmed: ${missing.join(", ")}`);
  }

  const label = top?.s.exactPart ? "Exact part number match" : LABELS[confidence];
  return { products, confidence, label, reasons };
}

// ─── Orchestration ─────────────────────────────────────────────────────

/** Queries to run: the model's list, or brand + type as a fallback. */
export function photoQueries(analysis) {
  const list = [...(analysis?.searchQueries || [])];
  const fallback = [analysis?.brand, analysis?.productType].filter(Boolean).join(" ");
  if (!list.length && fallback) list.push(fallback);
  return list.slice(0, MAX_QUERIES);
}

async function loadSmartSearch() {
  const mod = await import("./search-router.server.js");
  return mod.smartSearch;
}

/**
 * Never throws. Returns { products, confidence, label, reasons, queries }.
 * `searchFn(query, shopDomain, history)` defaults to smartSearch (injectable for tests).
 */
export async function photoSearch(analysis, shopDomain, { searchFn } = {}) {
  const t0 = Date.now();
  const empty = (extra = {}) => ({ products: [], confidence: "none", label: LABELS.none, reasons: [], queries: [], ...extra });
  if (!analysis?.isProductPhoto) return empty();

  try {
    const search = searchFn || (await loadSmartSearch());
    const safeSearch = async (q) => {
      try {
        return await search(q, shopDomain, []);
      } catch (e) {
        console.warn(`[PhotoSearch] search failed for "${q}": ${e.message}`);
        return null;
      }
    };
    const candidates = [];

    // 1. Part number → SKU path. An exact hit is the answer.
    const pn = analysis.partNumbers?.[0];
    if (pn) {
      const r = await safeSearch(pn);
      if (r?.products?.length) {
        const exactSku = r.searchType === "sku_exact";
        candidates.push({ products: r.products, queryIndex: 0, exactSku });
        if (exactSku) {
          const ranked = rankPhotoCandidates(candidates, analysis);
          console.log(`[PhotoSearch] exact part number "${pn}" → ${ranked.products.length} card(s) | ${Date.now() - t0}ms`);
          return { ...ranked, queries: [pn] };
        }
      }
    }

    // 2. Catalogue-style queries in parallel.
    const queries = photoQueries(analysis);
    const results = await Promise.all(queries.map((q) => safeSearch(q)));
    results.forEach((r, i) => {
      if (r?.products?.length) candidates.push({ products: r.products, queryIndex: i + (pn ? 1 : 0) });
    });

    const ranked = rankPhotoCandidates(candidates, analysis);
    console.log(
      `[PhotoSearch] queries=${JSON.stringify(pn ? [pn, ...queries] : queries)} pool=${candidates.reduce((n, c) => n + c.products.length, 0)} ` +
        `→ ${ranked.products.length} card(s), confidence=${ranked.confidence}` +
        (ranked.products[0] ? ` top="${ranked.products[0].title}" (${ranked.products[0].match_score})` : "") +
        ` | ${Date.now() - t0}ms`
    );
    return { ...ranked, queries: pn ? [pn, ...queries] : queries };
  } catch (e) {
    console.warn(`[PhotoSearch] failed: ${e.message}`);
    return empty();
  }
}

export default { photoSearch, rankPhotoCandidates, scoreProduct, classifyMatch, matchLabelFor, hasTerm, typeNoun, photoQueries };
