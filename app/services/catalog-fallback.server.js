// app/services/catalog-fallback.server.js — v1.1 (29 Sep 2026)
//
// Helpers for chat.jsx v2.5.1 (no dependencies, no network):
//   - catalogToolMode(): CATALOG_TOOL_MODE = auto (default) | local | ucp
//   - ucpBreaker / isUcpDiscoveryError / ucpErrorCode: skip UCP after an agent-profile error
//   - refineProducts(): cleans a result list before it is shown
//       · low-quality paths (storefront last resort): keep only products whose title/vendor/SKU
//         contain ALL meaningful query words ("FRP enclosure" must contain FRP *and* enclosure)
//       · any path: accessories/spare parts go after main products unless the query asks for them,
//         and accessoryOnly=true when nothing else was found

export const RELEVANCE_FILTERED_PATHS = new Set(["storefront_search_last_resort"]);

function intEnv(name, fallback) {
  const n = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function catalogToolMode() {
  const m = String(process.env.CATALOG_TOOL_MODE || "auto").toLowerCase();
  return m === "local" || m === "ucp" ? m : "auto";
}

// ─── UCP errors / circuit breaker ──────────────────────────────────────

// e.g. 422 {"message":"UCP discovery failed","data":{"code":"profile_unreachable"}}
const RE_UCP_DISCOVERY =
  /UCP discovery failed|profile_(?:unreachable|invalid|too_large|malformed)|negotiation failed/i;

export function isUcpDiscoveryError(text) {
  return RE_UCP_DISCOVERY.test(String(text || ""));
}

/** Short reason for logs: the string error code inside the JSON (e.g. "profile_unreachable"). */
export function ucpErrorCode(text) {
  const m = String(text || "").match(/"code"\s*:\s*"([a-z_]+)"/i);
  return m ? m[1] : "ucp_discovery_failed";
}

export function createCircuitBreaker(cooldownMs) {
  let openUntil = 0;
  let reason = null;
  return {
    cooldownMs,
    isOpen(now = Date.now()) {
      return now < openUntil;
    },
    trip(why, now = Date.now()) {
      openUntil = now + cooldownMs;
      reason = why || "unknown";
    },
    reset() {
      openUntil = 0;
      reason = null;
    },
    get reason() {
      return reason;
    },
  };
}

// One breaker per container (module singleton).
export const ucpBreaker = createCircuitBreaker(intEnv("UCP_BREAKER_MS", 10 * 60 * 1000));

// ─── Query terms / relevance filter ────────────────────────────────────

const STOPWORDS = new Set(
  (
    "a an and or of in on at to for from with by the this that these those it its is are was were be been " +
    "do does did you your we our us i me my have has had can could would should will shall may might " +
    "please pls kindly hi hello hey dear sir team thanks thank yes no ok okay " +
    "supply supplies supplier sell sells stock stocks carry carries provide available availability " +
    "price prices pricing cost quote quotation buy order get need needs want wants looking look " +
    "require required requirement urgent urgently project company quantity qty pcs nos uae dubai " +
    "show list find search any some all other more also only like about what which who how where when " +
    "product products item items type types kind brand brands mm"
  ).split(/\s+/)
);

/** Meaningful words of a query: lower-cased, filler removed, >=3 chars (or containing a digit). */
export function queryTerms(text) {
  const out = [];
  for (const raw of String(text || "").toLowerCase().split(/[^a-z0-9\-\/.]+/)) {
    const t = raw.replace(/^[-/.]+|[-/.]+$/g, "");
    if (!t || STOPWORDS.has(t)) continue;
    if (t.length < 2) continue;
    if (t.length < 3 && !/\d/.test(t)) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

function termInHaystack(term, hay) {
  if (hay.includes(term)) return true;
  if (term.length > 4 && term.endsWith("es") && hay.includes(term.slice(0, -2))) return true;
  if (term.length > 3 && term.endsWith("s") && hay.includes(term.slice(0, -1))) return true;
  return false;
}

/**
 * Keep products whose title/vendor/SKU contain ALL meaningful query words.
 * Only used on last-resort results: Algolia and the Admin title search already found nothing,
 * so partial matches there are noise ("FRP enclosure" → metal enclosures).
 * With no meaningful words, nothing is judged and all products are kept.
 */
export function filterProductsByQueryTerms(products, text) {
  const list = Array.isArray(products) ? products : [];
  const terms = queryTerms(text);
  if (terms.length === 0) return { kept: list, dropped: 0, terms, judged: false };
  const kept = list.filter((p) => {
    const hay = `${p?.title || ""} ${p?.vendor || ""} ${p?.sku || ""}`.toLowerCase();
    return terms.every((t) => termInHaystack(t, hay));
  });
  return { kept, dropped: list.length - kept.length, terms, judged: true };
}

// ─── Accessories ───────────────────────────────────────────────────────

// Catalogue titles such as "Siemens Circuit Breaker Accessories 8WA2867".
const RE_ACCESSORY =
  /\b(?:accessor(?:y|ies)|boots?|covers?|brackets?|markers?|labels?|spare\s+parts?|seal\s+kits?|repair\s+kits?|mounting\s+kits?|auxiliary\s+(?:contacts?|switch(?:es)?)|end\s+plates?|shrouds?)\b/i;

export function isAccessoryTitle(title) {
  return RE_ACCESSORY.test(String(title || ""));
}

export function queryWantsAccessory(text) {
  return RE_ACCESSORY.test(String(text || ""));
}

/**
 * Clean a result list before showing it.
 * @returns {{products: Array, dropped: number, terms: string[], accessoryOnly: boolean}}
 */
export function refineProducts(products, query, searchType) {
  let list = Array.isArray(products) ? products : [];
  let dropped = 0;
  let terms = [];

  if (list.length && RELEVANCE_FILTERED_PATHS.has(searchType)) {
    const f = filterProductsByQueryTerms(list, query);
    list = f.kept;
    dropped = f.dropped;
    terms = f.terms;
  }

  let accessoryOnly = false;
  if (list.length && !queryWantsAccessory(query)) {
    const main = list.filter((p) => !isAccessoryTitle(p?.title));
    const acc = list.filter((p) => isAccessoryTitle(p?.title));
    if (acc.length) {
      list = [...main, ...acc];
      accessoryOnly = main.length === 0;
    }
  }

  return { products: list, dropped, terms, accessoryOnly };
}
