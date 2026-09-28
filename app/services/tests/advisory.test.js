import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeEnquiry,
  buildAdvisoryBrief,
  buildAdvisoryFallback,
  formatAdvisoryLog,
  prependToLastUserMessage,
  nextStandardSn,
  requiredSn,
  bodiesFor,
  maxGapFor,
  ADVISORY_TAG,
} from "../app/services/advisory.server.js";

const SAMPLE =
  "I need a sensor solution for detecting metal parts on a conveyor belt, about 5 mm away, 24V DC, in a dusty factory environment. Suggest the right sensor type, key specs to look for, and what to check before buying.";

// [user, assistant, user, assistant, ..., user] as chat.jsx builds it (current turn last).
function historyOf(...userTexts) {
  const h = [];
  userTexts.forEach((u, i) => {
    h.push({ role: "user", content: u });
    if (i < userTexts.length - 1) h.push({ role: "assistant", content: "..." });
  });
  return h;
}

// ─── Engineering maths ────────────────────────────────────────────────

test("range maths", () => {
  assert.equal(nextStandardSn(6.25), 8);
  assert.equal(requiredSn(5, "ferrous"), 8);
  assert.equal(requiredSn(5, "stainless"), 10);
  assert.equal(requiredSn(5, "nonFerrous"), 20);
  assert.equal(requiredSn(4, "ferrous"), 5);
  assert.equal(requiredSn(2, "ferrous"), 2.5);
  assert.equal(requiredSn(60, "ferrous"), null);
  assert.deepEqual(bodiesFor(8, "flush"), ["M18", "M30"]);
  assert.deepEqual(bodiesFor(8, "nonFlush"), ["M12", "M18", "M30"]);
  assert.deepEqual(maxGapFor(8), { ferrous: 6.4, stainless: 4.8, nonFerrous: 2.6 });
});

// ─── The target enquiry ───────────────────────────────────────────────

test("the sensor enquiry is identified, clarified and searched consistently", () => {
  const a = analyzeEnquiry(SAMPLE, []);
  assert.ok(a);
  assert.equal(a.intent, "selection");
  assert.equal(a.domain, "sensing");
  assert.equal(a.continuation, false);
  assert.equal(a.requirements.target, "metal");
  assert.equal(a.requirements.gapMm, 5);
  assert.equal(a.requirements.gapKind, "explicit");
  assert.ok(a.requirementLines.some((l) => l.includes("24 V DC")));
  assert.ok(a.requirements.env.includes("dust"));
  assert.equal(a.plan.numbers.minSn, 8);
  assert.equal(a.searchQuery, "inductive proximity sensor 8 mm");
  assert.equal(a.skipPreSearch, false);
  assert.deepEqual(a.questions.map((q) => q.key), ["material", "partSize", "mounting"]);

  const brief = buildAdvisoryBrief(a);
  assert.ok(brief.startsWith(ADVISORY_TAG));
  assert.match(brief, /inductive/i);
  assert.match(brief, /Sn 8 mm/);
  assert.doesNotMatch(brief, /SAFETY/);
});

// ─── What must NOT be advisory ────────────────────────────────────────

test("plain lookups, stock/price questions, orders and chit-chat are NOT advisory", () => {
  for (const q of [
    "show me abb products",
    "cylinder",
    "yes thank you",
    "do you have Circular Connector ?",
    "star delta timer",
    "terminal block",
    "I need a 24V DC M12 inductive sensor 8 mm PNP",
    "Do you have a sensor for detecting metal on a conveyor, 5 mm?",
    "price of inductive sensor for conveyor 24V",
    "My order is stuck, can you help?",
  ]) {
    assert.equal(analyzeEnquiry(q, []), null, q);
  }
});

test("a SKU in the message bypasses advisory mode", () => {
  assert.equal(analyzeEnquiry(SAMPLE, [], { hasSku: true }), null);
});

test('"fail-safe" is not a fault report', () => {
  const a = analyzeEnquiry("I need a fail-safe relay for my machine", []);
  assert.notEqual(a?.intent, "troubleshooting");
});

// ─── Troubleshooting ──────────────────────────────────────────────────

test("cylinder leakage is troubleshooting with component hints", () => {
  const a = analyzeEnquiry("Solution for cylinder leakage", []);
  assert.equal(a.intent, "troubleshooting");
  assert.equal(a.domain, "troubleshooting");
  assert.equal(a.searchQuery, null);
  assert.equal(a.skipPreSearch, true);
  assert.equal(a.trouble.key, "cylinder");
  const brief = buildAdvisoryBrief(a);
  assert.match(brief, /Likely causes/);
  assert.match(brief, /piston seal/i);
});

test("sensor false triggers are troubleshooting on the sensor", () => {
  const a = analyzeEnquiry("My proximity sensor gives false triggers on the conveyor, why?", []);
  assert.equal(a.intent, "troubleshooting");
  assert.equal(a.trouble.key, "sensor");
});

// ─── Other sensing paths ──────────────────────────────────────────────

test("non-metal objects go to photoelectric", () => {
  const a = analyzeEnquiry(
    "Suggest the right sensor for detecting plastic bottles on a conveyor, 100 mm away, in a dusty plant",
    []
  );
  assert.equal(a.requirements.target, "nonMetal");
  assert.match(a.plan.sensorType, /Photoelectric/);
  assert.equal(a.searchQuery, "photoelectric sensor");
});

test("generic selection keeps the normal pre-search", () => {
  const a = analyzeEnquiry("Which VFD should I use for a 5.5 kW pump on a 415 V supply?", []);
  assert.equal(a.intent, "selection");
  assert.equal(a.domain, "generic");
  assert.equal(a.searchQuery, null);
  assert.equal(a.skipPreSearch, false);
});

test("rated Sn without a gap: search by Sn and ask for the gap", () => {
  const a = analyzeEnquiry("Which inductive sensor should I use, Sn 8 mm, for detecting steel parts on a conveyor?", []);
  assert.equal(a.requirements.ratedSn, 8);
  assert.equal(a.requirements.gapMm, null);
  assert.equal(a.plan.numbers.maxGap.ferrous, 6.4);
  assert.equal(a.searchQuery, "inductive proximity sensor 8 mm");
  assert.ok(a.plan.missing.some((m) => m.key === "gap"));
});

test('"sensing distance" is read as the gap but flagged as ambiguous', () => {
  const a = analyzeEnquiry("Suggest a sensor for detecting steel parts, sensing distance 4 mm", []);
  assert.equal(a.requirements.gapKind, "sensingRange");
  assert.equal(a.plan.numbers.minSn, 5);
  assert.ok(a.plan.assumptions.some((x) => /rated Sn/.test(x)));
});

test("AC supply switches to 2-wire sensors", () => {
  const a = analyzeEnquiry("Suggest the right sensor for detecting steel parts on a conveyor, 230V AC supply", []);
  assert.equal(a.requirements.voltage.type, "AC");
  assert.match(a.plan.sensorType, /2-wire AC/);
  assert.match(buildAdvisoryBrief(a), /2-wire AC/);
});

test("110 V with no AC/DC asks about the supply first", () => {
  const a = analyzeEnquiry("Suggest the right sensor for detecting steel parts on a conveyor, 5 mm away, 110V supply", []);
  assert.equal(a.questions[0].key, "supplyType");
});

test("personnel detection adds the safety warning", () => {
  const a = analyzeEnquiry("Suggest the right sensor to detect an operator's hand near a press", []);
  assert.equal(a.requirements.safety, true);
  assert.match(buildAdvisoryBrief(a), /IEC 61496/);
});

test("throughput becomes a switching-frequency fact", () => {
  const a = analyzeEnquiry(`${SAMPLE} About 600 parts per minute.`, []);
  assert.equal(a.plan.numbers.partsPerSecond, 10);
  assert.ok(!a.plan.missing.some((m) => m.key === "speed"));
});

test("M12x1 is read as the body size", () => {
  const a = analyzeEnquiry(
    "Which inductive sensor should I use for steel parts on a conveyor, M12x1 body, 2 mm away?",
    []
  );
  assert.equal(a.requirements.bodySize, "M12");
  assert.equal(a.searchQuery, "M12 inductive proximity sensor 2.5 mm");
});

// ─── Follow-ups ───────────────────────────────────────────────────────

test("follow-up answers are merged with the earlier enquiry", () => {
  const follow = "Steel parts, about 20 mm wide, on a rubber belt with open frame. PNP please.";
  const a = analyzeEnquiry(follow, historyOf(SAMPLE, follow));
  assert.ok(a);
  assert.equal(a.continuation, true);
  assert.equal(a.requirements.target, "ferrous");
  assert.equal(a.requirements.belt, "non-metal");
  assert.equal(a.requirements.output, "PNP");
  assert.equal(a.requirements.gapMm, 5);
  assert.equal(a.plan.numbers.bodies.mode, "nonFlush");
  assert.equal(a.searchQuery, "inductive proximity sensor 8 mm");
  const keys = a.plan.missing.map((m) => m.key);
  assert.ok(!keys.includes("material") && !keys.includes("partSize"));
});

test("a later answer overrides an earlier one (metal -> aluminium)", () => {
  const a = analyzeEnquiry("aluminium", historyOf(SAMPLE, "aluminium"));
  assert.equal(a.continuation, true);
  assert.equal(a.requirements.target, "nonFerrous");
  assert.equal(a.plan.numbers.minSn, 20);
  assert.equal(a.searchQuery, "inductive proximity sensor 20 mm");
});

test("a lookup in between ends the advisory thread", () => {
  assert.equal(analyzeEnquiry("24v please", historyOf(SAMPLE, "show me abb products", "24v please")), null);
});

test("a new lookup after an advisory turn is not swallowed", () => {
  const history = historyOf(SAMPLE, "show me abb products");
  assert.equal(analyzeEnquiry("show me abb products", history), null);
  assert.equal(analyzeEnquiry("yes thank you", history), null);
});

// ─── Fallback, logging, helpers ───────────────────────────────────────

test("fallback answers and pre-search skipping", () => {
  const a = analyzeEnquiry(SAMPLE, []);
  const fb = buildAdvisoryFallback(a);
  assert.match(fb, /Inductive proximity sensor/);
  assert.match(fb, /at least 8 mm/);
  assert.match(fb, /websales@creativeautomation\.ae/);

  const t = analyzeEnquiry("Solution for cylinder leakage", []);
  assert.equal(t.skipPreSearch, true);
  assert.match(buildAdvisoryFallback(t), /isolate/i);

  assert.equal(buildAdvisoryFallback(null), "");
});

test("log line", () => {
  assert.equal(formatAdvisoryLog(null), "[Advisory] none");
  const line = formatAdvisoryLog(analyzeEnquiry(SAMPLE, []));
  assert.match(line, /intent=selection/);
  assert.match(line, /sn=8/);
  assert.match(line, /skipPreSearch=false/);
});

test("prependToLastUserMessage handles strings and blocks", () => {
  const m1 = [{ role: "user", content: "hello" }];
  prependToLastUserMessage(m1, "BRIEF");
  assert.equal(m1[0].content, "BRIEF\n\nhello");

  const m2 = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
  prependToLastUserMessage(m2, "BRIEF");
  assert.equal(m2[0].content[0].text, "BRIEF\n\nhello");
});
