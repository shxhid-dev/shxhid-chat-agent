// app/services/card-memory.server.js — v1.0
//
// FOLLOW-UP MEMORY: assistant turns are stored as text only, so on the next turn Claude could not
// tell what "the second one" or "add the first to cart" referred to. When cards were shown, the
// saved assistant text gets a compact note:
//
//   …reply text…
//
//   [[Cards shown: 1) Siemens Contactor 3RT2026-1BB40 · SKU 3RT2026-1BB40 · 310.00 AED | 2) …]]
//
// Claude reads it from history; the widget strips it before rendering (same pattern as
// CARDS_MARKER_RE in extensions/chat-bubble/assets/chat.js). No DB schema change.

export const CARDS_MARKER_RE = /\n*\[\[Cards shown:[\s\S]*?\]\]\s*$/;

const MAX_ITEMS = 10;

function clean(value, max) {
  return String(value ?? "")
    .replace(/[\[\]|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** "[[Cards shown: 1) title · SKU x · price | 2) …]]", or "" when nothing was shown. */
export function buildCardsMarker(products) {
  const list = (Array.isArray(products) ? products : []).filter((p) => p && p.title).slice(0, MAX_ITEMS);
  if (!list.length) return "";
  const items = list.map((p, i) => {
    const parts = [clean(p.title, 90)];
    if (p.sku) parts.push(`SKU ${clean(p.sku, 40)}`);
    if (p.price) parts.push(clean(p.price, 30));
    return `${i + 1}) ${parts.join(" · ")}`;
  });
  return `[[Cards shown: ${items.join(" | ")}]]`;
}

/** Append the marker to a reply that is about to be saved. */
export function withCardsMarker(text, products) {
  const marker = buildCardsMarker(products);
  const base = String(text ?? "").replace(CARDS_MARKER_RE, "");
  return marker ? `${base}\n\n${marker}` : base;
}

export function stripCardsMarker(text) {
  return String(text ?? "").replace(CARDS_MARKER_RE, "");
}

/** First ~160 characters of a description, for grounding spec answers. */
export function specSnippet(description, max = 160) {
  const text = String(description ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

export default { CARDS_MARKER_RE, buildCardsMarker, withCardsMarker, stripCardsMarker, specSnippet };
