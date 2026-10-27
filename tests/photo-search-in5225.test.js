// Regression: a photo of the IFM IN5225 dual inductive valve sensor (orange rectangular body,
// two slotted mounting holes, M12 connector, no legible label) must return IN5225 in the top
// results. Before photo-search v2 the live agent answered "I can't match it" with no cards.
//
// The fake catalogue answers each query the way the live Algolia/router pipeline did on
// 27 Oct 2026 (probed through the deployed chat API):
//   "rectangular inductive proximity sensor M12" → IM5033, IN5224 (sibling, not IN5225)
//   "inductive valve sensor"                     → Omron proximity sensors
//   "valve position sensor"                      → sensor connector cables
//   "IFM dual inductive valve sensor" / family   → IN5224, IN5225
//
// Set LIVE_PHOTO_TEST=1 (with ANTHROPIC_API_KEY, ALGOLIA_* and SHOPIFY_STORE_DOMAIN) to also run
// the real vision + catalogue pipeline on tests/fixtures/in5225.jpg.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { photoSearch, familyQueries } from "../app/services/photo-search.server.js";

const IMG = "https://cdn.shopify.com/s/files/test/";
const IN5225 = { id: "in5225", handle: "in5225", title: "IFM IN5225 - Dual Inductive Valve Sensor, Dual NO Outputs, 4 mm Range", sku: "IN5225", vendor: "IFM", description: "dual inductive position sensor for quarter-turn valve actuators, 2 x NO PNP outputs, 4 mm range", image_url: `${IMG}IN5225.jpg` };
const IN5224 = { id: "in5224", handle: "in5224", title: "IFM IN5224 - Dual Inductive Sensor for Valve Actuators, 2 x PNP", sku: "IN5224", vendor: "IFM", description: "dual inductive sensor for valve actuators", image_url: `${IMG}IN5224.jpg` };
const IM5033 = { id: "im5033", title: "IFM IM5033 - Inductive Sensor, 40 x 40 x 120 mm", sku: "IM5033", vendor: "IFM", description: "", image_url: `${IMG}IM5033.jpg` };
const KI5038 = { id: "ki5038", title: "IFM KI5038 - Capacitive Sensor, M30, Sn 15 mm", sku: "KI5038", vendor: "IFM", description: "", image_url: `${IMG}KI5038.jpg` };
const OMRON = ["TL-W5F2", "TL-W5F1", "TL-W5E1"].map((sku) => ({ id: sku, title: `Omron Proximity Sensors ${sku}`, sku, vendor: "Omron", description: "", image_url: `${IMG}${sku}.jpg` }));
const CABLES = [{ id: "xs2f", title: "Sensor Connector, Lite M12 4 Wire, 5M, XS2F-L", sku: "XS2F-L", vendor: "Omron", description: "", image_url: `${IMG}XS2F.jpg` }];

function fakeCatalog(q) {
  const k = q.toLowerCase();
  if (k.includes("rectangular")) return [IM5033, IN5224];
  if (k.includes("ifm") && k.includes("dual inductive")) return [IN5224, IN5225];
  if (k === "ifm valve sensor") return [IN5224, KI5038, IN5225];
  if (k.includes("valve position")) return CABLES;
  if (k.includes("inductive valve sensor") || k.includes("proximity")) return OMRON;
  return [];
}

// What the vision model returned live for this photo (no brand, no part number).
const LIVE_ANALYSIS = {
  isProductPhoto: true,
  brand: "",
  brandGuess: "",
  partNumbers: [],
  productType: "inductive proximity sensor",
  function: "valve position feedback",
  color: "orange",
  shape: "rectangular block",
  connector: "M12 connector",
  mounting: "two slotted mounting holes",
  keySpecs: [],
  distinctiveTerms: ["M12", "rectangular", "slotted"],
  searchQueries: ["rectangular inductive proximity sensor M12", "inductive valve sensor", "valve position sensor"],
  confidence: "medium",
};

// Visual check: the catalogue photo of IN5225 is the customer's photo; IN5224 looks similar.
const VISUAL = { IN5225: [96, true, true], IN5224: [74, true, false], IM5033: [38, true, false], KI5038: [12, false, false] };
async function fakeCompare(_image, candidates) {
  return candidates.map((c) => {
    const sku = Object.keys(VISUAL).find((s) => c.title.includes(s));
    const [visual, sameType, sameProduct] = sku ? VISUAL[sku] : [15, false, false];
    return { visual, sameType, sameProduct };
  });
}

const IMAGE = { data: "AAAA", mediaType: "image/jpeg" };
const searchFn = async (q) => ({ products: fakeCatalog(q), searchType: "algolia_search" });

function captureLogs(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  return fn().finally(() => { console.log = orig; }).then((result) => ({ result, lines }));
}

test("IN5225 photo: found through family expansion and ranked first by the visual check", async () => {
  const { result: r, lines } = await captureLogs(() =>
    photoSearch(LIVE_ANALYSIS, "creativeautomation.ae", { searchFn, image: IMAGE, compareFn: fakeCompare })
  );
  const skus = r.products.map((p) => p.sku);
  assert.equal(skus[0], "IN5225", `top results: ${skus.join(", ")}`);
  assert.equal(r.confidence, "high");
  assert.equal(r.products[0].match_label, "Best match");
  assert.ok(r.products.length >= 2 && r.products.length <= 5);
  assert.ok(skus.includes("IN5224"), "the look-alike sibling is offered as a possible match");
  assert.equal(r.products.find((p) => p.sku === "IN5224").match_label, "Possible match");
  assert.equal(r.visualChecked, true);
  assert.ok(r.queries.some((q) => /^IFM Dual Inductive Sensor for Valve/i.test(q)), `family query missing: ${r.queries.join(" | ")}`);
  // every pipeline stage is logged for debugging
  for (const stage of ["queries", "search", "family", "pool", "visual", "result"]) {
    assert.ok(lines.some((l) => l.includes(`[PhotoSearch] stage=${stage}`)), `missing stage log: ${stage}`);
  }
});

test("IN5225 photo with a brand guess: the branded query finds it directly", async () => {
  const analysis = { ...LIVE_ANALYSIS, brandGuess: "IFM", searchQueries: ["IFM dual inductive valve sensor", ...LIVE_ANALYSIS.searchQueries] };
  const r = await photoSearch(analysis, "creativeautomation.ae", { searchFn, image: IMAGE, compareFn: fakeCompare });
  assert.equal(r.products[0].sku, "IN5225");
  assert.equal(r.confidence, "high");
});

test("IN5225 photo without a visual check: still among the closest cards, never empty", async () => {
  const r = await photoSearch(LIVE_ANALYSIS, "creativeautomation.ae", { searchFn, image: IMAGE, compareFn: async () => null });
  const skus = r.products.map((p) => p.sku);
  assert.ok(skus.length > 0, "cards must be shown");
  assert.ok(skus.slice(0, 5).includes("IN5225"), `top results: ${skus.join(", ")}`);
  assert.equal(r.visualChecked, false);
});

test("all candidates look different: confidence none, but the 3 closest are still shown", async () => {
  const lowCompare = async (_i, c) => c.map(() => ({ visual: 10, sameType: false, sameProduct: false }));
  const r = await photoSearch(LIVE_ANALYSIS, "creativeautomation.ae", { searchFn, image: IMAGE, compareFn: lowCompare });
  assert.equal(r.confidence, "none");
  assert.equal(r.products.length, 3);
  assert.match(r.label, /not confirmed/);
});

test("familyQueries drops the part number and keeps the product line", () => {
  assert.deepEqual(familyQueries([IN5224, IM5033], []), ["IFM Dual Inductive Sensor for Valve Actuators", "IFM Inductive Sensor"]);
  assert.deepEqual(familyQueries([IN5224], ["IFM Dual Inductive Sensor for Valve Actuators"]), []);
});

const LIVE = process.env.LIVE_PHOTO_TEST === "1";
test("LIVE: real vision + catalogue pipeline returns IN5225 for the fixture photo", { skip: !LIVE && "set LIVE_PHOTO_TEST=1 to run" }, async () => {
  const intel = await import("../app/services/image-intel.server.js");
  const data = readFileSync(new URL("./fixtures/in5225.jpg", import.meta.url)).toString("base64");
  const image = { data, mediaType: "image/jpeg" };
  const analysis = await intel.analyzeProductImage(image);
  assert.ok(analysis, "vision analysis failed (API key / credits?)");
  const r = await photoSearch(analysis, process.env.SHOPIFY_STORE_DOMAIN || "creativeautomation.ae", { image, compareFn: intel.compareProductImages });
  const skus = r.products.map((p) => p.sku);
  console.log(`[live] queries=${JSON.stringify(r.queries)} top=${skus.join(", ")} confidence=${r.confidence}`);
  assert.ok(skus.slice(0, 5).includes("IN5225"), `top results: ${skus.join(", ")}`);
});
