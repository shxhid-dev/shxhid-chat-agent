import test from "node:test";
import assert from "node:assert/strict";
import {
  hasTerm,
  typeNoun,
  scoreProduct,
  classifyMatch,
  rankPhotoCandidates,
  photoQueries,
  photoSearch,
} from "../app/services/photo-search.server.js";

// Modelled on the 24 Oct screenshot: an M23 cable connector photo, no label readable.
const M23_PHOTO = {
  isProductPhoto: true,
  brand: "",
  partNumbers: [],
  productType: "circular connector",
  keySpecs: [],
  distinctiveTerms: ["M23", "17 pin", "female"],
  searchQueries: ["M23 17 pin female cable connector", "M23 circular connector"],
  confidence: "medium",
};

const WEIDMULLER_M12 = { id: "w1", title: "1803860000 - Weidmuller M12 Sensor Connector 4-pin", sku: "1803860000", vendor: "Weidmuller", description: "M12 female straight" };
const HARTING_M23_17 = { id: "h1", title: "9150000401 - Harting M23 Female Connector 17-pin", sku: "9150000401", vendor: "Harting", description: "M23 cable connector" };
const SIEMENS_M23_12 = { id: "s1", title: "6FX2003-0SU12 - Siemens M23 signal connector 12-pin", sku: "6FX2003-0SU12", vendor: "Siemens", description: "M23 connector kit, female" };
const ACCESSORY = { id: "a1", title: "Harting M23 Housing Seal", sku: "9151000702", vendor: "Harting", description: "" };

test("hasTerm matches designations across spelling variants", () => {
  assert.equal(hasTerm("Harting M23 Female Connector 17-pin", "17 pin"), true);
  assert.equal(hasTerm("Connector 17pin straight", "17 pin"), true);
  assert.equal(hasTerm("Weidmuller M12 Sensor Connector", "M23"), false);
  assert.equal(hasTerm("Proximity Sensors", "sensor"), true);
  assert.equal(hasTerm("Siemens M230 frame", "M23"), false);
});

test("hasTerm treats thread sizes with a pitch as the same size", () => {
  assert.equal(hasTerm("IFM Sensor cable M8x1 4-pin PUR", "M8"), true);
  assert.equal(hasTerm("Lapp M12x1-A coded connector", "M12"), true);
  assert.equal(hasTerm("Connector M8 x 1 straight", "M8"), true);
  assert.equal(hasTerm("Sick M12 female cable", "M12x1"), true);
  assert.equal(hasTerm("Festo M18x1.5 proximity sensor", "M18"), true);
  assert.equal(hasTerm("Festo M18x1.5 proximity sensor", "M18x1.5"), true);
  assert.equal(hasTerm("Siemens M80 motor", "M8"), false);
  assert.equal(hasTerm("Turck M12x1 connector", "M8"), false);
  assert.equal(hasTerm("Harting M23 connector", "M2"), false);
});

test("an M8 photo keeps M8x1 catalogue titles", () => {
  const photo = { ...M23_PHOTO, productType: "sensor cable", distinctiveTerms: ["M8", "4 pin"] };
  const r = rankPhotoCandidates(
    [{ products: [
      { id: "m8", title: "IFM EVC001 sensor cable M8x1 4-pin 5 m", sku: "EVC001", description: "" },
      { id: "m12", title: "IFM EVC002 sensor cable M12x1 4-pin 5 m", sku: "EVC002", description: "" },
    ], queryIndex: 0 }],
    photo
  );
  assert.equal(r.products[0].id, "m8");
  assert.equal(r.products[0].match_label, "Strong match");
});

test("typeNoun takes the last real word of the product type", () => {
  assert.equal(typeNoun("inductive proximity sensor"), "sensor");
  assert.equal(typeNoun("M23 circular connectors"), "connector");
  assert.equal(typeNoun(""), "");
});

test("an M23 photo ranks the M23 17-pin part first and drops the M12 part", () => {
  const r = rankPhotoCandidates([{ products: [WEIDMULLER_M12, SIEMENS_M23_12, HARTING_M23_17, ACCESSORY], queryIndex: 0 }], M23_PHOTO);
  const ids = r.products.map((p) => p.id);
  assert.equal(ids[0], "h1");
  assert.ok(!ids.includes("w1"), "M12 connector must not be shown for an M23 photo");
  assert.ok(!ids.includes("a1"), "housing seal has no connector noun");
  assert.equal(r.confidence, "high");
  assert.equal(r.products[0].match_label, "Strong match");
  assert.ok(r.reasons.some((x) => /M23/.test(x)));
});

test("exact part number wins and is labelled", () => {
  const photo = { ...M23_PHOTO, partNumbers: ["6FX2003-0SU12"], brand: "Siemens" };
  const r = rankPhotoCandidates([{ products: [HARTING_M23_17, SIEMENS_M23_12], queryIndex: 0 }], photo);
  assert.equal(r.products[0].id, "s1");
  assert.equal(r.products[0].match_label, "Exact part number");
  assert.equal(r.confidence, "high");
  assert.equal(r.label, "Exact part number match");
});

test("confidence tiers", () => {
  const s = (o) => ({ exactPart: false, brandHit: false, termsHit: 0, termsTotal: 3, typeHit: true, score: 10, ...o });
  assert.equal(classifyMatch(s({ termsHit: 3 }), { brand: "" }), "high");
  assert.equal(classifyMatch(s({ termsHit: 3 }), { brand: "Harting" }), "medium"); // brand read but not matched
  assert.equal(classifyMatch(s({ termsHit: 2 }), {}), "medium");
  assert.equal(classifyMatch(s({ termsHit: 1 }), {}), "low");
  assert.equal(classifyMatch(s({ typeHit: false }), {}), "none");
  assert.equal(classifyMatch(undefined, {}), "none");
  assert.equal(classifyMatch(s({ exactPart: true, typeHit: false }), {}), "high");
});

test("low confidence shows at most 3 cards, none shows nothing", () => {
  const photo = { ...M23_PHOTO, distinctiveTerms: ["M8", "angled", "PUR"] };
  const many = Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, title: `Generic angled connector ${i}`, sku: `X${i}`, description: "" }));
  const low = rankPhotoCandidates([{ products: many, queryIndex: 0 }], photo);
  assert.equal(low.confidence, "low");
  assert.ok(low.products.length <= 3);

  const none = rankPhotoCandidates([{ products: [{ id: "z", title: "Siemens Circuit Breaker", sku: "5SL6", description: "" }], queryIndex: 0 }], M23_PHOTO);
  assert.equal(none.confidence, "none");
  assert.equal(none.products.length, 0);
});

test("the same product from several queries keeps its best score", () => {
  const r = rankPhotoCandidates(
    [
      { products: [SIEMENS_M23_12, HARTING_M23_17], queryIndex: 0 },
      { products: [HARTING_M23_17], queryIndex: 1 },
    ],
    M23_PHOTO
  );
  assert.equal(r.products.filter((p) => p.id === "h1").length, 1);
});

test("scoreProduct penalises missing distinctive terms", () => {
  const good = scoreProduct(HARTING_M23_17, M23_PHOTO).score;
  const bad = scoreProduct(WEIDMULLER_M12, M23_PHOTO).score;
  assert.ok(good > bad + 30, `${good} vs ${bad}`);
});

test("photoQueries falls back to brand + type", () => {
  assert.deepEqual(photoQueries({ searchQueries: [], brand: "SMC", productType: "solenoid valve" }), ["SMC solenoid valve"]);
  assert.equal(photoQueries({ ...M23_PHOTO, searchQueries: ["a b", "c d", "e f", "g h"] }).length, 3);
});

test("photoSearch: exact SKU short-circuits the query searches", async () => {
  const calls = [];
  const searchFn = async (q) => {
    calls.push(q);
    return q === "6FX2003-0SU12" ? { products: [SIEMENS_M23_12], searchType: "sku_exact" } : { products: [HARTING_M23_17], searchType: "algolia_search" };
  };
  const r = await photoSearch({ ...M23_PHOTO, partNumbers: ["6FX2003-0SU12"] }, "shop.example", { searchFn });
  assert.deepEqual(calls, ["6FX2003-0SU12"]);
  assert.equal(r.confidence, "high");
  assert.equal(r.products[0].id, "s1");
});

test("photoSearch: runs the queries in parallel, survives failing searches, never throws", async () => {
  const calls = [];
  const searchFn = async (q) => {
    calls.push(q);
    if (q.includes("circular")) throw new Error("Algolia down");
    return { products: [WEIDMULLER_M12, HARTING_M23_17], searchType: "algolia_search" };
  };
  const r = await photoSearch(M23_PHOTO, "shop.example", { searchFn });
  assert.equal(calls.length, 2);
  assert.equal(r.products[0].id, "h1");
  assert.deepEqual(r.queries, M23_PHOTO.searchQueries);

  const notProduct = await photoSearch({ ...M23_PHOTO, isProductPhoto: false }, "shop.example", { searchFn });
  assert.equal(notProduct.confidence, "none");
});
