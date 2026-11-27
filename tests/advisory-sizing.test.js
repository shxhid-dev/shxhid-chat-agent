import test from "node:test";
import assert from "node:assert/strict";

import { analyzeEnquiry, buildAdvisoryBrief, buildAdvisoryFallback } from "../app/services/advisory.server.js";
import { pushForceN, pullForceN, standardBoreFor, nextDriveKw, detectSizingDomain } from "../app/services/advisory-sizing.server.js";

test("cylinder force maths", () => {
  assert.equal(Math.round(pushForceN(50, 6)), 1178);
  assert.equal(Math.round(pullForceN(50, 6)), 990);
  assert.equal(standardBoreFor(981, 6), 50);
  assert.equal(standardBoreFor(1100, 6, { pull: true }), 63);
  assert.equal(standardBoreFor(1e7, 6), null);
});

test("lifting 50 kg at 6 bar → 50 mm bore, with the stroke in the search", () => {
  const a = analyzeEnquiry("Which cylinder do I need to lift 50 kg vertically at 6 bar? 200 mm stroke", []);
  assert.equal(a.domain, "cylinder");
  assert.equal(a.plan.numbers.boreMm, 50);
  assert.equal(a.searchQuery, "pneumatic cylinder 50 mm bore 200 mm stroke");
  assert.ok(a.plan.avoid.some((x) => /air loss/.test(x)), "lifting warns about the load dropping");
});

test("clamping uses the 70% ratio and the given pressure", () => {
  const a = analyzeEnquiry("Help me choose a cylinder to clamp a part with 1.5 kN, we have 5 bar air", []);
  assert.equal(a.plan.numbers.requiredN, 2143);
  assert.equal(a.plan.numbers.boreMm, 80);
});

test("no load given: no size, no search, ask for the load", () => {
  const a = analyzeEnquiry("Which cylinder should I use for my machine? need advice", []);
  assert.equal(a.domain, "cylinder");
  assert.equal(a.searchQuery, null);
  assert.equal(a.skipPreSearch, true);
  assert.equal(a.questions[0].key, "load");
  assert.match(buildAdvisoryBrief(a), /Do not guess a size/);
});

test("a follow-up with the load completes the cylinder enquiry", () => {
  const history = [
    { role: "user", content: "Which cylinder should I use to lift a load? need advice" },
    { role: "assistant", content: "What load?" },
    { role: "user", content: "80 kg, 5 bar" },
  ];
  const a = analyzeEnquiry("80 kg, 5 bar", history);
  assert.equal(a.continuation, true);
  assert.equal(a.plan.numbers.boreMm, 80);
});

test("drive selection: duty, hp conversion and single-phase limits", () => {
  const pump = analyzeEnquiry("Which VFD should I use for a 5.5 kW pump motor, 3 phase 400V?", []);
  assert.equal(pump.plan.numbers.driveKw, 5.5);
  assert.equal(pump.plan.numbers.duty, "normal");

  const conveyor = analyzeEnquiry("Suggest the right inverter for a 7.5 hp conveyor motor on single phase 230V", []);
  assert.equal(conveyor.plan.numbers.driveKw, 7.5);
  assert.equal(conveyor.plan.numbers.duty, "heavy");
  assert.match(conveyor.plan.recommendation, /three-phase supply/);
  assert.match(buildAdvisoryFallback(conveyor), /Recommended drive/);

  assert.equal(nextDriveKw(5.6), 7.5);
  assert.equal(nextDriveKw(4), 4);
});

test("lookups, other products and solar inverters are left alone", () => {
  for (const m of ["do you have a 5.5 kW VFD?", "show me pneumatic cylinders 50 mm bore", "do you have festo cylinders", "Suggest the right solar inverter for my roof", "what size cable gland should I use for a 10 mm cable"]) {
    const a = analyzeEnquiry(m, []);
    assert.ok(!a || (a.domain !== "cylinder" && a.domain !== "drive"), m);
  }
  assert.equal(detectSizingDomain("gas cylinder regulator"), null);
});
