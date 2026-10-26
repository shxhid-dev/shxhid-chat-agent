import test from "node:test";
import assert from "node:assert/strict";
import { buildCardsMarker, withCardsMarker, stripCardsMarker, specSnippet, CARDS_MARKER_RE } from "../app/services/card-memory.server.js";

// Same pattern as CARDS_MARKER_RE in extensions/chat-bubble/assets/chat.js.
const WIDGET_RE = /\n*\[\[Cards shown:[\s\S]*?\]\]\s*$/;

const CARDS = [
  { title: "Siemens Contactor 3RT2026-1BB40 24V DC", sku: "3RT2026-1BB40", price: "310.00 AED" },
  { title: "ABB [AF26] | contactor", sku: null, price: null },
];

test("marker lists the shown cards in order", () => {
  const m = buildCardsMarker(CARDS);
  assert.equal(
    m,
    "[[Cards shown: 1) Siemens Contactor 3RT2026-1BB40 24V DC · SKU 3RT2026-1BB40 · 310.00 AED | 2) ABB AF26 contactor]]"
  );
  assert.equal(buildCardsMarker([]), "");
  assert.equal(buildCardsMarker(null), "");
});

test("withCardsMarker appends once and strip restores the reply (server + widget)", () => {
  const saved = withCardsMarker("Here is the contactor you asked for.", CARDS);
  assert.ok(saved.startsWith("Here is the contactor you asked for.\n\n[[Cards shown: 1)"));
  assert.equal(withCardsMarker(saved, CARDS), saved, "no double marker");
  assert.equal(stripCardsMarker(saved), "Here is the contactor you asked for.");
  assert.equal(saved.replace(WIDGET_RE, ""), "Here is the contactor you asked for.");
  assert.equal(String(CARDS_MARKER_RE), String(WIDGET_RE));
  assert.equal(withCardsMarker("No cards this time.", []), "No cards this time.");
});

test("specSnippet trims on a word boundary", () => {
  assert.equal(specSnippet(""), null);
  assert.equal(specSnippet("  24 V DC   coil  "), "24 V DC coil");
  const long = "Contactor, AC-3 11 kW / 400 V, 1 NO + 1 NC, 24 V DC coil, screw terminals, size S0, for mounting on 35 mm DIN rail and for use with overload relays and auxiliary switch blocks";
  const s = specSnippet(long);
  assert.ok(s.length <= 161 && s.endsWith("…"), s);
  assert.ok(!/\s…$/.test(s));
});
