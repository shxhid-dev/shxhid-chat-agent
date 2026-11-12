// Regression tests for the 12 Nov 2026 backend review (search accuracy, photo matching, input parsing).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { isSpecToken, isThreadToken } from "../app/services/spec-tokens.server.js";
import { pickHeadNoun } from "../app/services/query-terms.server.js";
import { __routerInternals as R } from "../app/services/search-router.server.js";
import { __internals as A } from "../app/services/algolia.server.js";
import {
  hasTerm,
  scoreProduct,
  classifyMatch,
  classifyVisual,
  mergeCandidates,
  pickShortlist,
  rankWithVisual,
} from "../app/services/photo-search.server.js";
import { parseImagePayload, createRateLimiter } from "../app/services/image-intel.server.js";

// ─── Spec tokens and SKU detection ────────────────────────────────────

test("spec tokens are never part numbers", () => {
  for (const t of ["0.75kW", "24V-DC", "DC24V", "12-24VDC", "100-240VAC", "4-20mA", "0-10V", "2.5mm2", "32x100", "3x2.5", "3-phase", "2-pole", "IP69K", "NEMA17", "Cat6a", "10bar"]) {
    assert.equal(isSpecToken(t), true, t);
  }
  for (const t of ["IN5225", "E2E-X5ME1", "DSNU-20-50-P-A", "3RT2026-1BB40", "ACS580"]) {
    assert.equal(isSpecToken(t), false, t);
  }
  assert.equal(isThreadToken("M12x1"), true);
  assert.equal(isThreadToken("G1/4"), true);
  assert.equal(isThreadToken("IN5225"), false);
});

test("router SKU detection skips specs but keeps real codes", () => {
  for (const msg of ["0.75kW motor", "M12X1 connector", "24V-DC relay", "G1/4 fitting", "3-phase motor", "100-240VAC SMPS", "4-20mA transmitter", "IP69K sensor"]) {
    assert.equal(R.detectSku(msg), null, msg);
  }
  assert.equal(R.detectSku("IFM IN5225"), "IN5225");
  assert.equal(R.detectSku("E2E-X5ME1 sensor"), "E2E-X5ME1");
  assert.equal(R.detectSku("6ES7214-1AG40-0XB0"), "6ES7214-1AG40-0XB0");
  assert.equal(R.detectSku("part no 6ES7 214-1AG40-0XB0 please"), "6ES7214-1AG40-0XB0");
  assert.equal(R.detectSku("part no MCJI-12-32-100"), "MCJI-12-32-100");
  // A thread size typed on its own is still searched as a code.
  assert.equal(R.detectSku("G1/2"), "G1/2");
});

// ─── Head noun ────────────────────────────────────────────────────────

test("the product noun skips trailing qualifiers", () => {
  const cases = {
    "photoelectric sensor long range": "sensor",
    "push button green": "button",
    "limit switch roller lever": "switch",
    "contactor 3 pole": "contactor",
    "solenoid valve 5/2 single acting": "valve",
    "inductive sensor 8 mm PNP normally open": "sensor",
    "power supply 24 V DC 5 A": "supply",
    "cable tie": "tie",
    "safety light curtain": "curtain",
    "contactor 24V coil": "contactor",
    "solenoid coil": "coil",
    "variable frequency drive for pump": "drive",
  };
  for (const [q, want] of Object.entries(cases)) {
    assert.equal(R.headNounOf(q), want, `router: ${q}`);
    assert.equal(A.headNounOf(q), want, `algolia: ${q}`);
  }
  assert.equal(pickHeadNoun([]), null);
});

test("relaxed queries never fall back to a qualifier or the object of 'for'", () => {
  for (const q of ["photoelectric sensor long range", "push button green", "variable frequency drive for pump"]) {
    const relaxed = R.relaxCandidates(q);
    assert.ok(!relaxed.some((r) => /^(range|green|pump)$/i.test(r)), `${q} → ${JSON.stringify(relaxed)}`);
  }
  assert.ok(R.relaxCandidates("power supply 24 V DC 5 A").some((r) => /power supply/.test(r)));
});

// ─── Algolia spec matching ────────────────────────────────────────────

const hit = (title) => ({ title, handle: "", product_type: "", vendor: "", tags: [], body_html_safe: "" });
const spec = (q, title) => A.scoreHitBySpec(hit(title), A.extractSpecTokens(q));

test("spec values match on number boundaries", () => {
  assert.ok(spec("5mm", "Inductive sensor 2.5 mm range") < 0);
  assert.ok(spec("5 mm", "sensor 1.5 mm") < 0);
  assert.equal(spec("5 mm", "Inductive sensor Sn 5 mm"), 1000);
});

test("spec notations are normalised", () => {
  assert.equal(spec("24VDC", "Relay 24 V DC coil"), 1000);
  assert.equal(spec("24 V DC", "Relay 24VDC"), 1000);
  assert.equal(spec("DC 24V", "Relay 24VDC"), 1000);
  assert.equal(spec("24V", "PSU 24 V DC 5 A"), 1000);
  assert.equal(spec("24VDC", "Relay 24 V AC/DC"), 1000);
  assert.ok(spec("24VDC", "Coil 230 V AC") < 0);
  assert.equal(spec("M12", "Sensor M12x1"), 1000);
  assert.equal(spec("m12 sensor", "Sensor M12 x 1"), 1000);
  assert.ok(spec("M12", "Sensor M8x1") < 0);
  assert.equal(spec("0.75kW", "Motor 750 W"), 1000);
  assert.ok(spec("0.75kW", "Motor 1.5 kW") < 0);
  assert.equal(spec("10 bar", "Regulator 10 bar"), 1000);
});

test("brand matching is whole-word", () => {
  assert.equal(A.brandAppearsInHits("Beta", [{ vendor: "Eta" }]), false);
  assert.equal(A.brandAppearsInHits("LS", [{ vendor: "Omron", title: "Omron Pulse Counter" }]), false);
  assert.equal(A.brandAppearsInHits("Schmersal", [{ vendor: "Schmersal GmbH & Co. KG" }]), true);
  assert.equal(A.brandAppearsInHits("Autonics", [{ vendor: "Creative Automation", title: "TIMER STAR DELTA 220 VAC 8 PIN AUTONICS" }]), true);
});

// ─── Photo matching ───────────────────────────────────────────────────

const SENSOR_PHOTO = {
  isProductPhoto: true,
  brand: "IFM",
  partNumbers: ["IN5225"],
  productType: "inductive sensor",
  distinctiveTerms: ["dual", "valve"],
  keySpecs: [],
  function: "valve position",
};
const card = (id, title, sku, image = true) => ({ id, title, sku, vendor: "IFM", description: "", image_url: image ? "https://cdn.shopify.com/x.jpg" : null });

test("hasTerm does not match inside a longer number", () => {
  assert.equal(hasTerm("Harting M23 connector 17-pin", "7 pin"), false);
  assert.equal(hasTerm("Sensor 14-pin", "4 pin"), false);
  assert.equal(hasTerm("Cylinder 132mm", "32 mm"), false);
  assert.equal(hasTerm("Harting M23 connector 17-pin", "17 pin"), true);
  assert.equal(hasTerm("M12/M8 adapter", "M12"), true);
});

test("part numbers match whole codes, and accessories are judged by the title head", () => {
  const sensor = scoreProduct(card("s", "IFM IN5225 - Dual Inductive Sensor, M12 connector", "IN5225"), SENSOR_PHOTO);
  assert.equal(sensor.exactPart, true);
  assert.equal(sensor.typeHit, true, "a sensor whose title mentions its connector is still a sensor");

  const cable = scoreProduct(card("c", "Connection cable for IFM IN5225", "EVC001"), SENSOR_PHOTO);
  assert.equal(cable.exactPart, false, "a cable naming the sensor is not the sensor");
  assert.equal(cable.typeHit, false);

  const longer = scoreProduct(
    card("x", "Siemens 3RT2026-1BB40-0CC0 contactor", "3RT2026-1BB40-0CC0"),
    { ...SENSOR_PHOTO, partNumbers: ["3RT2026-1BB40"], productType: "contactor" }
  );
  assert.equal(longer.exactPart, false);
});

test("an exact part-number hit without a photo stays in the visual shortlist", () => {
  const merged = mergeCandidates(
    [{ products: [card("sib", "IFM IN5224 - Dual Inductive Sensor", "IN5224"), card("ex", "IFM IN5225 - Dual Inductive Sensor", "IN5225", false)], queryIndex: 0 }],
    SENSOR_PHOTO
  );
  const shortlist = pickShortlist(merged);
  assert.deepEqual(shortlist.map((x) => x.product.id), ["ex", "sib"]);
  const ranked = rankWithVisual(shortlist, shortlist.map((x) => (x.product.id === "sib" ? { visual: 85, sameType: true, sameProduct: false } : null)), SENSOR_PHOTO);
  assert.equal(ranked.products[0].id, "ex");
  assert.equal(ranked.confidence, "high");
});

test("look-alike siblings without a clear lead are medium, not high", () => {
  const top = { s: { exactPart: false }, v: { visual: 86, sameType: true, sameProduct: false } };
  assert.equal(classifyVisual(top, { s: {}, v: { visual: 82, sameType: true } }), "medium");
  assert.equal(classifyVisual(top, { s: {}, v: { visual: 60, sameType: true } }), "high");
  assert.equal(classifyVisual({ ...top, v: { ...top.v, sameProduct: true } }, { s: {}, v: { visual: 84 } }), "high");
});

test("a single matching term without a brand is not high", () => {
  const s = (o) => ({ exactPart: false, brandHit: false, termsHit: 1, termsTotal: 1, typeHit: true, score: 10, ...o });
  assert.equal(classifyMatch(s(), { brand: "" }), "medium");
  assert.equal(classifyMatch(s({ termsHit: 2, termsTotal: 2, brandHit: true }), { brand: "IFM" }), "high");
});

// ─── Input parsing and limits ─────────────────────────────────────────

test("photo payloads accept data URLs with parameters and are re-encoded", () => {
  const b64 = fs.readFileSync(new URL("./fixtures/in5225.jpg", import.meta.url)).toString("base64");
  for (const data of [b64, `data:image/jpeg;base64,${b64}`, `data:image/png;name=a.png;base64,${b64}`, `  data:image/jpeg;base64,${b64}`]) {
    const r = parseImagePayload({ data });
    assert.equal(r.ok, true);
    assert.equal(r.image.mediaType, "image/jpeg");
    assert.equal(r.image.data, b64);
  }
});

test("rate limiter peek does not record a hit", () => {
  const l = createRateLimiter({ max: 1, windowMs: 1000, now: () => 0 });
  assert.equal(l.peek("a"), true);
  assert.equal(l.peek("a"), true);
  assert.equal(l.allow("a"), true);
  assert.equal(l.peek("a"), false);
});
