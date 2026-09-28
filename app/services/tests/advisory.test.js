import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeEnquiry,
  buildAdvisoryBrief,
  prependToLastUserMessage,
  nextStandardSn,
  requiredSn,
  bodiesFor,
  ADVISORY_TAG,
} from "../app/services/advisory.server.js";

const SAMPLE =
  "I need a sensor solution for detecting metal parts on a conveyor belt, about 5 mm away, 24V DC, in a dusty factory environment. Suggest the right sensor type, key specs to look for, and what to check before buying.";

test("range maths", () => {
  assert.equal(nextStandardSn(6.25), 8);
  assert.equal(requiredSn(5, "ferrous"), 8);
  assert.equal(requiredSn(5, "stainless"), 10);
  assert.equal(requiredSn(5, "nonFerrous"), 20);
  assert.equal(requiredSn(4, "ferrous"), 5);
  assert.equal(requiredSn(60, "ferrous"), null);
  assert.deepEqual(bodiesFor(8, "flush"), ["M18", "M30"]);
  assert.deepEqual(bodiesFor(8, "nonFlush"), ["M12", "M18", "M30"]);
});

test("the sensor enquiry is identified, clarified and searched consistently", () => {
  const a = analyzeEnquiry(SAMPLE, []);
  assert.ok(a);
  assert.equal(a.intent, "selection");
  assert.equal(a.domain, "sensing");
  assert.equal(a.requirements.target, "metal");
  assert.equal(a.requirements.gapMm, 5);
  assert.ok(a.requirementLines.some((l) => l.includes("24 V DC")));
  assert.ok(a.requirements.env.includes("dust"));
  assert.equal(a.plan.numbers.minSn, 8);
  assert.equal(a.searchQuery, "inductive proximity sensor 8 mm");
  assert.deepEqual(a.plan.missing.slice(0, 3).map((m) => m.key), ["material", "partSize", "mounting"]);

  const brief = buildAdvisoryBrief(a);
  assert.ok(brief.startsWith(ADVISORY_TAG));
  assert.match(brief, /inductive/i);
  assert.match(brief, /Sn 8 mm/);
});

test("plain lookups and chit-chat are NOT advisory", () => {
  for (const q of [
    "show me abb products",
    "cylinder",
    "yes thank you",
    "do you have Circular Connector ?",
    "star delta timer",
    "terminal block",
    "I need a 24V DC M12 inductive sensor 8 mm PNP",
  ]) {
    assert.equal(analyzeEnquiry(q, []), null, q);
  }
});

test("a SKU in the message bypasses advisory mode", () => {
  assert.equal(analyzeEnquiry(SAMPLE, [], { hasSku: true }), null);
});

test("troubleshooting is identified", () => {
  const a = analyzeEnquiry("Solution for cylinder leakage", []);
  assert.equal(a.intent, "troubleshooting");
  assert.equal(a.searchQuery, null);
  assert.match(buildAdvisoryBrief(a), /Likely causes/);
});

test("non-metal objects go to photoelectric", () => {
  const a = analyzeEnquiry(
    "Suggest the right sensor for detecting plastic bottles on a conveyor, 100 mm away, in a dusty plant",
    []
  );
  assert.equal(a.requirements.target, "nonMetal");
  assert.match(a.plan.sensorType, /Photoelectric/);
  assert.equal(a.searchQuery, "photoelectric sensor");
});

test("generic selection has no search rewrite", () => {
  const a = analyzeEnquiry("Which VFD should I use for a 5.5 kW pump on a 415 V supply?", []);
  assert.equal(a.intent, "selection");
  assert.equal(a.domain, "generic");
  assert.equal(a.searchQuery, null);
});

test("follow-up answers are merged with the earlier enquiry", () => {
  const follow = "Steel parts, about 20 mm wide, on a rubber belt with open frame. PNP please.";
  const history = [
    { role: "user", content: SAMPLE },
    { role: "assistant", content: "..." },
    { role: "user", content: follow },
  ];
  const a = analyzeEnquiry(follow, history);
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

test("a new lookup after an advisory turn is not swallowed", () => {
  const history = [
    { role: "user", content: SAMPLE },
    { role: "assistant", content: "..." },
    { role: "user", content: "show me abb products" },
  ];
  assert.equal(analyzeEnquiry("show me abb products", history), null);
  assert.equal(analyzeEnquiry("yes thank you", history), null);
});

test("prependToLastUserMessage handles strings and blocks", () => {
  const m1 = [{ role: "user", content: "hello" }];
  prependToLastUserMessage(m1, "BRIEF");
  assert.equal(m1[0].content, "BRIEF\n\nhello");

  const m2 = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
  prependToLastUserMessage(m2, "BRIEF");
  assert.equal(m2[0].content[0].text, "BRIEF\n\nhello");
});
