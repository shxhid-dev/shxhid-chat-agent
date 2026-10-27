// app/services/photo-search.server.js — v2.0
//
// PHOTO MATCHING: turns what image-intel read from a photo into a ranked, honest set of cards.
//
//   1. Part number read  → smartSearch(part number) (router SKU path). sku_exact → done, "high".
//   2. Queries, specific → generic (buildPhotoQueries): brand / brand guess + catalogue name,
//      the name alone, type + visual traits, broad type. All run through smartSearch in parallel.
//   3. Family expansion: the strongest hits' product lines are searched too
//      ("IFM IN5224 - Dual Inductive Sensor for Valve" → "IFM Dual Inductive Sensor for Valve"),
//      so a sibling hit pulls in the exact model.
//   4. Candidates are merged (de-duplicated) and text-scored against the analysis.
//   5. Visual verification: the best ~8 are compared with the customer's photo in one vision call
//      (image-intel compareProductImages). Final score = 65% visual + 35% text.
//   6. Confidence high / medium / low / none. Even "none" returns the 3 closest cards, so the
//      reply can show them and ask one clarifying question instead of "couldn't find it".
//   Without a usable visual check (no images / call failed) the text ranking is used.
//
// Every stage is logged as "[PhotoSearch] stage=…". photoSearch() never throws.

export const PHOTO_SEARCH_VERSION = "2.0.0";

const MAX_CARDS = 5;
const MAX_LOW_CARDS = 4;
const MAX_CLOSEST = 3;
const MAX_QUERIES = 6;
const MAX_FAMILY_QUERIES = 2;
const MAX_VISUAL = 8;
const SCORE_FLOOR = 0.35;
const VISUAL_WEIGHT = 0.65;
const ACCESSORY_RE = /\b(connectors?|cables?|cordsets?|brackets?|accessor(?:y|ies)|mounting kits?|spare parts?|seals?)\b/i;

const LABELS = {
  high: "Best match",
  medium: "Likely match",
  low: "Possible matches",
  none: "Closest matches — not confirmed",
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

function cleanQuery(q) {
  return String(q ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
}

// ─── Queries (pure) ────────────────────────────────────────────────────

/**
 * Specific → generic, de-duplicated, at most 6. The model's own queries come first; a branded
 * query is added from brand_guess when no brand was printed, and the broad type closes the list.
 */
export function buildPhotoQueries(analysis) {
  const brand = analysis?.brand || "";
  const guess = brand ? "" : analysis?.brandGuess || "";
  const type = analysis?.productType || "";
  const list = [...(analysis?.searchQueries || [])];
  if ((brand || guess) && type) list.splice(1, 0, `${brand || guess} ${type}`);
  if (type && analysis?.connector) list.push(`${type} ${analysis.connector}`);
  const seen = new Set();
  const unique = (q) => {
    const k = norm(q);
    if (q.length < 3 || seen.has(k)) return false;
    seen.add(k);
    return true;
  };
  const broad = cleanQuery(type);
  if (broad) seen.add(norm(broad)); // reserved: the broad type is always the last query
  const out = list.map(cleanQuery).filter(unique).slice(0, broad ? MAX_QUERIES - 1 : MAX_QUERIES);
  return broad ? [...out, broad] : out;
}

/** Kept for callers / tests of v1: the photo queries. */
export function photoQueries(analysis) {
  return buildPhotoQueries(analysis);
}

/**
 * Product-line queries from the strongest candidates: vendor + the descriptive part of the title,
 * without the part number. "IFM IN5224 - Dual Inductive Sensor for Valve Actuators, …" →
 * "IFM Dual Inductive Sensor for Valve Actuators".
 */
export function familyQueries(products, alreadyRun = []) {
  const ran = new Set(alreadyRun.map(norm));
  const out = [];
  for (const p of products || []) {
    const title = String(p?.title || "");
    const vendor = String(p?.vendor || "").trim();
    let desc = title.includes(" - ") ? title.split(" - ").slice(1).join(" - ") : title;
    desc = desc.split(",")[0];
    if (vendor) desc = desc.replace(new RegExp(`^${vendor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+`, "i"), "");
    // drop part-number-like tokens (letters + digits)
    desc = desc.split(/\s+/).filter((w) => !(/\d/.test(w) && /[a-z]/i.test(w) && w.length >= 4)).slice(0, 6).join(" ");
    const q = cleanQuery([vendor, desc].filter(Boolean).join(" "));
    if (q.split(" ").length < 3 || ran.has(norm(q))) continue;
    ran.add(norm(q));
    out.push(q);
    if (out.length >= MAX_FAMILY_QUERIES) break;
  }
  return out;
}

// ─── Scoring (pure) ────────────────────────────────────────────────────

/**
 * Text score of one product against the photo analysis.
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
  // A guessed brand helps a little, never as much as a printed one.
  const guessHit = !analysis?.brand && !!analysis?.brandGuess && (hasTerm(vendor, analysis.brandGuess) || hasTerm(title, analysis.brandGuess));
  if (guessHit) score += 8;

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
      score -= 6;
    }
  }

  // Function words ("valve", "position", "flow") that the catalogue title shares with the analysis.
  const fnWords = norm(analysis?.function).split(" ").filter((w) => w.length >= 5);
  const fnHits = fnWords.filter((w) => hasTerm(title, w)).length;
  score += Math.min(fnHits, 2) * 6;

  const noun = typeNoun(analysis?.productType);
  // "Sensor Connector …" or "Sensor Cable …" is an accessory of a sensor, not a sensor — unless the
  // photo itself shows a connector / cable / bracket.
  const accessory = ACCESSORY_RE.test(title) && !ACCESSORY_RE.test(analysis?.productType || "");
  const typeHit = !accessory && (!noun || hasTerm(title, noun) || hasTerm(product?.productType || "", noun));
  score += typeHit ? 10 : accessory ? -20 : -10;

  let specHits = 0;
  for (const spec of analysis?.keySpecs || []) {
    if (specHits < 3 && hasTerm(all, spec)) {
      specHits++;
      score += 3;
    }
  }

  const queryIndex = Number.isFinite(source.queryIndex) ? source.queryIndex : 0;
  const rank = Number.isFinite(source.rank) ? source.rank : 0;
  score += Math.max(0, 6 - queryIndex) + Math.max(0, (10 - rank) * 0.4);

  return { score, exactPart, brandHit, guessHit, termsHit, termsTotal: terms.length, typeHit };
}

/** Confidence of the best text-scored product (used when no visual check is available). */
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

/** Confidence from the visual check of the top card. */
export function classifyVisual(top) {
  if (!top) return "none";
  if (top.s.exactPart) return "high";
  const v = top.v;
  if (!v) return "none";
  if (v.visual >= 80 && v.sameType) return "high";
  if (v.visual >= 60 && v.sameType) return "medium";
  if (v.visual >= 40) return "low";
  return "none";
}

export function matchLabelFor(s, v = null, isTop = false, confidence = "low") {
  if (s.exactPart) return "Exact part number";
  if (v) {
    if (isTop && (confidence === "high" || confidence === "medium")) return "Best match";
    if (v.visual >= 55) return "Possible match";
    return "Similar";
  }
  if (s.typeHit && s.termsTotal > 0 && s.termsHit === s.termsTotal) return "Strong match";
  if (s.termsHit > 0) return "Partial match";
  return "Similar";
}

function productKey(p) {
  return p?.id || p?.handle || p?.title || null;
}

/** Merge candidates (best text score per product), sorted by text score. */
export function mergeCandidates(candidates, analysis) {
  const best = new Map();
  for (const c of Array.isArray(candidates) ? candidates : []) {
    (Array.isArray(c?.products) ? c.products : []).forEach((product, rank) => {
      const key = productKey(product);
      if (!key) return;
      const s = scoreProduct(product, analysis, { queryIndex: c.queryIndex, rank, exactSku: c.exactSku });
      const prev = best.get(key);
      if (!prev || s.score > prev.s.score) best.set(key, { key, product, s });
    });
  }
  return [...best.values()].sort((a, b) => b.s.score - a.s.score);
}

function reasonsFor(top, analysis) {
  const reasons = [];
  if (!top) return reasons;
  if (top.s.exactPart) reasons.push("the part number on the photo matches the catalogue");
  if (top.v) reasons.push(`looks like the photo (visual ${top.v.visual}/100${top.v.sameProduct ? ", likely the same model" : ""})`);
  if (top.s.brandHit) reasons.push(`brand ${analysis.brand}`);
  else if (top.s.guessHit) reasons.push(`brand ${analysis.brandGuess} (recognised from the design, not printed)`);
  const shownTerms = (analysis?.distinctiveTerms || []).filter((t) =>
    hasTerm(`${top.product.title} ${top.product.sku || ""} ${top.product.description || ""}`, t)
  );
  if (shownTerms.length) reasons.push(`shows ${shownTerms.join(", ")}`);
  return reasons;
}

function toCards(kept, confidence, { visual }) {
  return kept.map((x, i) => ({
    ...x.product,
    match_label: matchLabelFor(x.s, visual ? x.v : null, i === 0, confidence),
    match_score: Math.round(x.final ?? x.s.score),
  }));
}

/**
 * Text-only ranking (no visual check). candidates: [{ products, queryIndex, exactSku }].
 * Returns { products, confidence, label, reasons }. "none" still returns the 3 closest cards.
 */
export function rankPhotoCandidates(candidates, analysis) {
  let scored = mergeCandidates(candidates, analysis);
  const typed = scored.filter((x) => x.s.exactPart || x.s.typeHit);
  let kept = typed.filter((x) => x.s.exactPart || x.s.termsTotal === 0 || x.s.termsHit > 0);
  const topScore = kept[0]?.s.score ?? 0;
  if (topScore > 0) kept = kept.filter((x) => x.s.exactPart || x.s.score >= topScore * SCORE_FLOOR);

  let confidence = classifyMatch(kept[0]?.s, analysis);
  if (!kept.length) {
    // Nothing confident: still show the closest typed products and let Claude ask.
    kept = typed.slice(0, MAX_CLOSEST);
    confidence = "none";
  }
  const limit = confidence === "none" ? MAX_CLOSEST : confidence === "low" ? MAX_LOW_CARDS : MAX_CARDS;
  kept = kept.slice(0, limit);
  const top = kept[0];
  const label = top?.s.exactPart ? "Exact part number match" : LABELS[confidence];
  return { products: toCards(kept, confidence, { visual: false }), confidence, label, reasons: reasonsFor(top, analysis) };
}

/**
 * Visual ranking. shortlist: merged entries; visual: array aligned with shortlist
 * ({ visual, sameType, sameProduct } | null). Final = 65% visual + 35% normalised text score.
 */
export function rankWithVisual(shortlist, visual, analysis) {
  const texts = shortlist.map((x) => x.s.score);
  const maxT = Math.max(...texts);
  const minT = Math.min(...texts);
  const span = maxT - minT || 1;
  const scored = shortlist
    .map((x, i) => {
      const v = visual[i] || null;
      const textNorm = ((x.s.score - minT) / span) * 100;
      const final = x.s.exactPart ? 100 + (v?.visual ?? 0) / 100 : v ? VISUAL_WEIGHT * v.visual + (1 - VISUAL_WEIGHT) * textNorm : (1 - VISUAL_WEIGHT) * textNorm;
      return { ...x, v, final };
    })
    .sort((a, b) => b.final - a.final);

  const confidence = classifyVisual(scored[0]);
  let kept;
  if (confidence === "none") kept = scored.slice(0, MAX_CLOSEST);
  else {
    const limit = confidence === "low" ? MAX_LOW_CARDS : MAX_CARDS;
    kept = scored.filter((x, i) => i === 0 || x.s.exactPart || (x.v && x.v.visual >= 30)).slice(0, limit);
  }
  const top = kept[0];
  const label = top?.s.exactPart ? "Exact part number match" : LABELS[confidence];
  return { products: toCards(kept, confidence, { visual: true }), confidence, label, reasons: reasonsFor(top, analysis) };
}

/** Best candidates for the visual check: top by text score, with photos, at most 8. */
export function pickShortlist(merged, max = MAX_VISUAL) {
  const withImage = merged.filter((x) => typeof x.product?.image_url === "string" && x.product.image_url.startsWith("http"));
  return (withImage.length ? withImage : merged).slice(0, max);
}

// ─── Orchestration ─────────────────────────────────────────────────────

async function loadSmartSearch() {
  const mod = await import("./search-router.server.js");
  return mod.smartSearch;
}

const log = (stage, msg) => console.log(`[PhotoSearch] stage=${stage} ${msg}`);

/**
 * Never throws. Returns { products, confidence, label, reasons, queries, visualChecked }.
 *   searchFn(query, shopDomain, history) — defaults to smartSearch
 *   image                                — the customer's photo ({ data, mediaType }) for the visual check
 *   compareFn(image, [{title, imageUrl}]) — defaults to none (text ranking only)
 *   onStage(stage)                       — "searching" | "comparing", for the live status line
 */
export async function photoSearch(analysis, shopDomain, { searchFn, image = null, compareFn = null, onStage } = {}) {
  const t0 = Date.now();
  const stage = (name) => {
    try { onStage?.(name); } catch { /* status only */ }
  };
  const empty = (extra = {}) => ({ products: [], confidence: "none", label: LABELS.none, reasons: [], queries: [], visualChecked: false, ...extra });
  if (!analysis?.isProductPhoto) return empty();

  try {
    const search = searchFn || (await loadSmartSearch());
    const safeSearch = async (q) => {
      try {
        const r = await search(q, shopDomain, []);
        log("search", `"${q}" → ${r?.products?.length || 0} (${r?.searchType || "none"})`);
        return r;
      } catch (e) {
        console.warn(`[PhotoSearch] search failed for "${q}": ${e.message}`);
        return null;
      }
    };
    const candidates = [];
    const ran = [];
    stage("searching");

    // 1. Part number → SKU path. An exact hit is the answer.
    const pn = analysis.partNumbers?.[0];
    if (pn) {
      const r = await safeSearch(pn);
      ran.push(pn);
      if (r?.products?.length) {
        const exactSku = r.searchType === "sku_exact";
        candidates.push({ products: r.products, queryIndex: 0, exactSku });
        if (exactSku) {
          const ranked = rankPhotoCandidates(candidates, analysis);
          log("result", `exact part number "${pn}" → ${ranked.products.length} card(s) | ${Date.now() - t0}ms`);
          return { ...ranked, queries: ran, visualChecked: false };
        }
      }
    }

    // 2. Specific → generic queries in parallel.
    const queries = buildPhotoQueries(analysis);
    log("queries", JSON.stringify(queries));
    const results = await Promise.all(queries.map((q) => safeSearch(q)));
    ran.push(...queries);
    results.forEach((r, i) => {
      if (r?.products?.length) candidates.push({ products: r.products, queryIndex: i + (pn ? 1 : 0) });
    });

    // 3. Family expansion from the strongest hits.
    const firstPass = mergeCandidates(candidates, analysis);
    const family = familyQueries(firstPass.slice(0, 3).map((x) => x.product), ran);
    if (family.length) {
      log("family", JSON.stringify(family));
      const famResults = await Promise.all(family.map((q) => safeSearch(q)));
      ran.push(...family);
      famResults.forEach((r, i) => {
        // Family results rank as high as the best query: they come from a confirmed product line.
        if (r?.products?.length) candidates.push({ products: r.products, queryIndex: 1 + i });
      });
    }

    const merged = mergeCandidates(candidates, analysis);
    log("pool", `${merged.length} unique candidate(s) from ${ran.length} quer${ran.length === 1 ? "y" : "ies"}`);
    if (!merged.length) {
      log("result", `no candidates | ${Date.now() - t0}ms`);
      return empty({ queries: ran });
    }

    // 4. Visual verification of the shortlist.
    let ranked = null;
    if (image && typeof compareFn === "function") {
      const shortlist = pickShortlist(merged);
      stage("comparing");
      const visual = await compareFn(
        image,
        shortlist.map((x) => ({ title: x.product.title, imageUrl: x.product.image_url }))
      ).catch(() => null);
      if (Array.isArray(visual) && visual.some(Boolean)) {
        ranked = { ...rankWithVisual(shortlist, visual, analysis), visualChecked: true };
        log("visual", shortlist.map((x, i) => `${String(x.product.title).slice(0, 30)}=${visual[i]?.visual ?? "?"}`).join(", "));
      } else {
        log("visual", "unavailable — text ranking");
      }
    }
    if (!ranked) ranked = { ...rankPhotoCandidates(candidates, analysis), visualChecked: false };

    log(
      "result",
      `confidence=${ranked.confidence} cards=${ranked.products.length}` +
        (ranked.products[0] ? ` top="${ranked.products[0].title}" (${ranked.products[0].match_score})` : "") +
        ` | ${Date.now() - t0}ms`
    );
    return { ...ranked, queries: ran };
  } catch (e) {
    console.warn(`[PhotoSearch] failed: ${e.message}`);
    return empty();
  }
}

export default {
  photoSearch,
  buildPhotoQueries,
  familyQueries,
  mergeCandidates,
  pickShortlist,
  rankPhotoCandidates,
  rankWithVisual,
  scoreProduct,
  classifyMatch,
  classifyVisual,
  matchLabelFor,
  hasTerm,
  typeNoun,
  photoQueries,
};
