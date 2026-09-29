// app/services/catalog-fallback.server.js
//
// Helpers for chat.jsx v2.5 (no dependencies, no network):
//   - catalogToolMode(): CATALOG_TOOL_MODE = auto (default) | local | ucp
//   - ucpBreaker: circuit breaker that skips UCP for UCP_BREAKER_MS after a discovery/profile error
//   - filterProductsByQueryTerms(): drops low-quality (storefront last-resort) cards that share no
//     meaningful words with the query ("switchgear" / "FRP" returned 10 unrelated products on 28 Sep)

export const RELEVANCE_FILTERED_PATHS = new Set(["storefront_search_last_resort"]);

function intEnv(name, fallback) {
  const n = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function catalogToolMode() {
  const m = String(process.env.CATALOG_TOOL_MODE || "auto").toLowerCase();
  return m === "local" || m === "ucp" ? m : "auto";
}

// Shopify rejects UCP calls before running them when the agent profile can't be fetched/validated,
// e.g. 422 {"message":"UCP discovery failed","data":{"code":"profile_unreachable"}}
const RE_UCP_DISCOVERY =
  /UCP discovery failed|profile_(?:unreachable|invalid|too_large|malformed)|negotiation failed/i;

export function isUcpDiscoveryError(text) {
  return RE_UCP_DISCOVERY.test(String(text || ""));
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

const STOPWORDS = new Set(
  (
    "a an and or of in on at to for from with by the this that these those it its is are was were be been " +
    "do does did you your we our us i me my have has had can could would should will shall may might " +
    "please pls hi hello hey thanks thank yes no ok okay " +
    "supply supplies supplier sell sells stock stocks carry carries provide available availability " +
    "price prices pricing cost quote quotation buy order get need needs want wants looking look " +
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
 * Keep products whose title/vendor/SKU contain the query terms (1 term: that term;
 * 2+ terms: at least half). With no meaningful terms, nothing is judged and all are kept.
 */
export function filterProductsByQueryTerms(products, text) {
  const list = Array.isArray(products) ? products : [];
  const terms = queryTerms(text);
  if (terms.length === 0) return { kept: list, dropped: 0, terms, judged: false };
  const need = terms.length === 1 ? 1 : Math.ceil(terms.length / 2);
  const kept = list.filter((p) => {
    const hay = `${p?.title || ""} ${p?.vendor || ""} ${p?.sku || ""}`.toLowerCase();
    let hits = 0;
    for (const t of terms) if (termInHaystack(t, hay)) hits++;
    return hits >= need;
  });
  return { kept, dropped: list.length - kept.length, terms, judged: true };
}
