// app/services/advisory.server.js
//
// ADVISORY MODE for GENERAL ENQUIRIES
// e.g. "I need a sensor solution for detecting metal parts on a conveyor belt, about 5 mm
// away, 24V DC, dusty factory. Suggest the right sensor type, key specs, and what to check
// before buying."
//
// What it does (pure functions: no LLM call, no network, no DB, no dependencies):
//   1. IDENTIFY - decides whether a message is an application-advice / troubleshooting
//                 enquiry rather than a product or SKU lookup.
//   2. CLARIFY  - extracts what the customer already told us (material, gap, voltage,
//                 environment...), works out what is still missing, and picks <=3 questions.
//   3. GROUND   - computes engineering numbers (e.g. inductive rated range Sn from the working
//                 gap) and builds an [ADVISORY BRIEF] that chat.jsx prepends to the last user
//                 message, so Claude answers with: recommended type, key specs, checks before
//                 buying, and questions to confirm.
//   4. ALIGN    - returns a search query that matches the ADVICE (e.g. "inductive proximity
//                 sensor 8 mm") so the product cards agree with the text.
//
// Follow-ups work too: if the customer answers the clarifying questions in the next message
// ("steel, 20 mm wide, rubber belt, PNP"), the earlier enquiry is merged with the new details.
//
// Nothing here changes the DB schema, env vars or package.json.

export const ADVISORY_TAG = "[ADVISORY BRIEF — NOT FROM USER]";

// Minimum score for a message to count as an advice enquiry (see classify()).
const MIN_SELECTION_SCORE = 3;

// ---------------------------------------------------------------------------
// 1. Text helpers
// ---------------------------------------------------------------------------

function cleanText(s) {
  return String(s ?? "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function lc(s) {
  return cleanText(s).toLowerCase();
}

function textOf(msg) {
  if (!msg) return "";
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter((b) => b && b.type === "text")
      .map((b) => b.text || "")
      .join(" ");
  }
  return "";
}

// ---------------------------------------------------------------------------
// 2. Intent classification  (all regexes are NON-global on purpose: safe with .test)
// ---------------------------------------------------------------------------

const SELECT_NOUNS =
  "sensors?|type|model|product|one|choice|option|drive|valve|cylinder|plc|motor|cable|connector|switch|relay|solution|brand|size|rating|specs?|specification";

const RE_SELECT_CUE = new RegExp(
  "\\b(?:" +
    [
      "(?:right|best|suitable|appropriate|correct|ideal|proper)\\s+(?:\\w+\\s+){0,2}?(?:" + SELECT_NOUNS + ")",
      "what\\s+(?:type|kind|sort)\\s+of",
      "which\\s+(?:\\w+\\s+){0,3}?(?:should|do|would|to|is\\s+best|is\\s+right|is\\s+suitable)",
      "how\\s+(?:do\\s+|can\\s+|should\\s+|to\\s+)(?:i\\s+|we\\s+)?(?:choose|select|pick|size|specify)",
      "help\\s+(?:me\\s+)?(?:choose|select|pick|decide)",
      "before\\s+(?:buying|purchasing|ordering)",
      "key\\s+specs?",
      "what\\s+specs?",
      "what\\s+(?:to|should\\s+i|do\\s+i)\\s+(?:check|look\\s+for|consider)",
      "things\\s+to\\s+(?:check|consider)",
    ].join("|") +
    ")\\b",
  "i"
);

const RE_SOLUTION_CUE =
  /\b(?:solutions?\s+(?:for|to)|need\s+(?:a\s+|an\s+)?solution|advice|advise|recommend(?:ation|ations)?|suggest(?:ion|ions)?|guidance)\b/i;

const RE_FRAMING =
  /\b(?:need|needs|needed|looking\s+for|looking\s+to|want|wants|require|requires|required|planning|installing|designing)\b/i;

const RE_PURPOSE =
  /\b(?:detect(?:ing|ion|or|ors)?|sens(?:e|ing)|measur(?:e|ing|ement)|monitor(?:ing)?|count(?:ing)?|control(?:ling)?|position(?:ing)?|protect(?:ing|ion)?|regulat(?:e|ing)|prevent(?:ing)?|sort(?:ing)?|lift(?:ing)?|pump(?:ing)?|convey(?:ing)?|automat(?:e|ing|ion)|eliminat(?:e|ing)|reduc(?:e|ing)|solv(?:e|ing))\b/i;

const RE_PROCESS =
  /\b(?:conveyors?|belts?|assembly\s+line|production\s+line|packag(?:e|ing)\s+line|packing\s+line|machine|machines|machinery|factory|factories|plant|workshop|robots?|palleti[sz]\w*|warehouse|press|furnace)\b/i;

const RE_NUMERIC_SPEC =
  /\b\d+(?:\.\d+)?\s*(?:mm|cm|kw|hp|bar|psi|vdc|vac|v|ma|hz|khz|rpm|°\s*c|nm|l\/min|kg)\b/i;

const RE_TROUBLE_CUE =
  /\b(?:leak(?:s|ing|age|ed)?|not\s+working|stopped\s+working|won't\s+(?:start|work|turn|run|close|open)|doesn't\s+work|fault(?:s|y)?|fail(?:s|ed|ing|ure|ures)?|trip(?:s|ping|ped)?|overheat(?:s|ing|ed)?|over[- ]heat(?:s|ing|ed)?|noisy|erratic|intermittent|burn(?:t|ing|ed)?|damaged|error\s+code|jam(?:s|med|ming)?|stuck|false\s+trigger(?:s|ing)?|nuisance\s+trip(?:s|ping)?|drift(?:s|ing)?)\b/i;

const RE_TROUBLE_GATE =
  /\b(?:why|how\s+(?:do\s+|can\s+|to\s+|should\s+)(?:i\s+|we\s+)?(?:fix|stop|solve|prevent|repair|troubleshoot|diagnose)|what\s+causes|what(?:'s|\s+is)\s+wrong|troubleshoot\w*|diagnos\w*|my|our|help)\b/i;

// A message that opens like a plain product lookup is never treated as a follow-up.
const RE_LOOKUP_OPENER =
  /^(?:show|list|find|search|do\s+you\s+(?:have|stock|sell|carry)|price|quote|how\s+much|can\s+i\s+(?:buy|order)|i\s+want\s+to\s+(?:buy|order)|add\s+to\s+cart|order|buy)\b/i;

const ENV_PATTERNS = {
  dust: /\b(?:dust|dusty|powder|powdery|cement|flour|sawdust|debris|dirt|dirty|grime|particulates?)\b/,
  metallicDebris:
    /\b(?:swarf|filings?|shavings|grinding|machining|milling|metal(?:lic)?\s+(?:dust|chips|particles|debris)|iron\s+dust|steel\s+dust)\b/,
  wet: /\b(?:wet|water|wash-?down|wash\s+down|hose|splash\w*|humid\w*|condensation|rain|outdoors?|hygienic|food|beverage|steam)\b/,
  oil: /\b(?:oil|oily|coolant|grease|greasy|lubricant|cutting\s+fluid|emulsion)\b/,
  hot: /\b(?:hot|furnace|oven|foundry|kiln|forging|high[- ]temp\w*|heat)\b/,
  cold: /\b(?:freezer|cold\s+stor\w+|freezing|sub-?zero|cold\s+room)\b/,
  welding: /\b(?:weld\w*|spatter)\b/,
  hazardous: /\b(?:atex|explosive|explosion|hazardous|flammable|zone\s+[012]|ex-?proof|iecex)\b/,
  vibration: /\b(?:vibrat\w*|shock|impact|heavy[- ]duty)\b/,
  chemical: /\b(?:chemicals?|acids?|corros\w*|solvents?|caustic)\b/,
};

const ENV_LABELS = {
  dust: "dusty",
  metallicDebris: "metallic swarf/debris",
  wet: "wet / humid / washdown",
  oil: "oil / coolant",
  hot: "high temperature",
  cold: "cold / freezer",
  welding: "welding spatter",
  hazardous: "hazardous / explosive atmosphere",
  vibration: "vibration / impact",
  chemical: "chemicals / corrosive",
};

function hasEnv(t) {
  return Object.values(ENV_PATTERNS).some((r) => r.test(t));
}

/**
 * Classify ONE message on its own.
 * Returns { intent: "selection" | "troubleshooting" | null, score }.
 *
 * Scoring (selection): select-cue 2 (or solution-cue 1) + framing 1 + purpose verb 1
 * + process context 1 + environment 1 + numeric spec 1. Needs >= MIN_SELECTION_SCORE.
 * Plain lookups ("show me abb products", "24V M12 inductive sensor 8 mm PNP") score < 3.
 */
function classify(text) {
  const t = lc(text);
  if (!t || t.length < 12) return { intent: null, score: 0 };

  const selectCue = RE_SELECT_CUE.test(t);
  const solutionCue = RE_SOLUTION_CUE.test(t);

  const trouble =
    !selectCue && RE_TROUBLE_CUE.test(t) && (RE_TROUBLE_GATE.test(t) || solutionCue);
  if (trouble) return { intent: "troubleshooting", score: 3 };

  let score = 0;
  if (selectCue) score += 2;
  else if (solutionCue) score += 1;
  if (RE_FRAMING.test(t)) score += 1;
  if (RE_PURPOSE.test(t)) score += 1;
  if (RE_PROCESS.test(t)) score += 1;
  if (hasEnv(t)) score += 1;
  if (RE_NUMERIC_SPEC.test(t)) score += 1;

  return { intent: score >= MIN_SELECTION_SCORE ? "selection" : null, score };
}

// ---------------------------------------------------------------------------
// 3. Requirement extraction
// ---------------------------------------------------------------------------

const RE_SENSING =
  /\b(?:sensors?|proximity|inductive|capacitive|photoelectric|photo[- ]?sensors?|photo[- ]?eye|ultrasonic|detect(?:ing|ion|or|ors)?|presence|retro[- ]?reflective|through[- ]?beam|light\s+curtain)\b/;
const RE_LEVEL = /\b(?:level|liquid|liquids|tank|silo|hopper|fluid)\b/;

function isSensing(t) {
  return RE_SENSING.test(t) && !RE_LEVEL.test(t);
}

const RE_BELT =
  /\b(steel|metal|metallic|stainless|wire[- ]?mesh|mesh|chain|roller|slat|rubber|pvc|pu|plastic|modular|fabric|textile|nylon|felt)\s+(?:conveyor\s+)?(?:belt|belts|conveyor|conveyors|chain|rollers?)\b/;

// "steel frame", "metal bracket" ... describe the MOUNTING, not the part being detected.
const RE_MOUNT_METAL_CONTEXT_G =
  /\b(?:steel|metal|metallic|aluminium|aluminum|stainless)\s+(?:frames?|brackets?|housings?|mount(?:s|ing)?|structures?|rails?|guards?|plates?|supports?|tables?|chassis)\b/g;

const RE_NONMETAL_WORDS =
  /\b(?:plastics?|cardboard|cartons?|boxes|box|wood(?:en)?|paper|rubber|glass|bottles?|cans|pouch(?:es)?|bags?|pallets?|ceramic|foam|film|labels?|tiles?|bricks?|sachets?|tubs?|trays?)\b/;

const RE_DUST_KNOWN =
  /\b(?:cement|flour|sawdust|wood|grain|sand|paper|plastic|non[- ]?metal(?:lic)?\s+dust|non[- ]?conductive)\b/;

function detectBelt(t) {
  const m = t.match(RE_BELT);
  if (!m) return { belt: null, word: null, stripped: t };
  const w = m[1].replace(/[- ]/g, "");
  const isMetal = /^(?:steel|metal|metallic|stainless|wiremesh|mesh|chain|roller|slat)$/.test(w);
  return {
    belt: isMetal ? "metal" : "non-metal",
    word: m[1],
    stripped: t.replace(m[0], " belt "),
  };
}

/** Returns "ferrous" | "stainless" | "nonFerrous" | "mixed" | "metal" | "nonMetal" | null */
function detectTarget(t0) {
  const t = t0.replace(RE_MOUNT_METAL_CONTEXT_G, " ");
  if (/\bnon[- ]?metal(?:lic)?\b/.test(t)) return "nonMetal";

  const hasNonFerrous = /\b(?:non[- ]?ferrous|alumin(?:i)?um|brass|copper|bronze|zinc|titanium)\b/.test(t);
  const t2 = t.replace(/\bnon[- ]?ferrous\b/g, " ");
  const hasStainless = /\bstainless\b/.test(t2);
  const t3 = t2.replace(/\bstainless(?:\s+steel)?\b/g, " ");
  const hasFerrous = /\b(?:steel|iron|ferrous|ferromagnetic)\b/.test(t3);
  const hasMetal = /\bmetal(?:s|lic)?\b/.test(t3);

  if (hasFerrous && hasNonFerrous) return "mixed";
  if (hasNonFerrous && hasStainless) return "mixed";
  if (hasNonFerrous) return "nonFerrous";
  if (hasStainless) return "stainless";
  if (hasFerrous) return "ferrous";
  if (hasMetal) return "metal";
  if (RE_NONMETAL_WORDS.test(t)) return "nonMetal";
  return null;
}

function detectPartSize(t) {
  let m = t.match(
    /(\d+(?:\.\d+)?)\s*(mm|cm)\s*(?:wide|long|thick|thickness|diameter|dia|width|length|height|across|square)\b/
  );
  if (m) return { label: m[0].trim(), num: m[1] };
  m = t.match(
    /(?:width|length|thickness|diameter|dia|size|height)\s*(?:of|is|=|:|about|approx(?:imately)?)?\s*(\d+(?:\.\d+)?)\s*(mm|cm)\b/
  );
  if (m) return { label: m[0].trim(), num: m[1] };
  m = t.match(
    /\b(?:small|tiny|thin|miniature|large|big|heavy)\s+(?:(?:metal|steel|iron)\s+)?(?:parts?|components?|pieces?|items?|bolts?|screws?|nuts?|washers?|sheets?)\b/
  );
  if (m) return { label: m[0], num: null };
  return null;
}

/** Working gap between sensor face and part, in mm. */
function detectGap(t, partSize) {
  const toMm = (n, unit) => parseFloat(n) * (unit === "cm" ? 10 : 1);

  let m = t.match(
    /(\d+(?:\.\d+)?)\s*(mm|cm)\s*(?:away|gap|distance|clearance|range|apart|above|below|standoff|stand-off|from\s+(?:the\s+)?(?:belt|sensor|surface|part|parts|target|face))\b/
  );
  if (m) return { value: toMm(m[1], m[2]), assumed: false };

  m = t.match(
    /(?:distance|gap|clearance|stand-?off|sensing\s+(?:range|distance)|range)\s*(?:of|is|=|:|about|approx(?:imately)?|around|up\s+to)?\s*(\d+(?:\.\d+)?)\s*(mm|cm)\b/
  );
  if (m) return { value: toMm(m[1], m[2]), assumed: false };

  // One lone "N mm" that is not the part size: read it as the gap, but flag it as assumed.
  const all = [...t.matchAll(/(\d+(?:\.\d+)?)\s*mm\b/g)]
    .map((x) => x[1])
    .filter((n) => !partSize || n !== partSize.num);
  if (all.length === 1) return { value: parseFloat(all[0]), assumed: true };

  return { value: null, assumed: false };
}

function detectVoltage(t) {
  let m = t.match(/\b(\d{1,3}(?:\.\d+)?)\s*v(?:olts?)?(?:\s*[-_]?\s*(dc|ac))?\b/);
  if (m) return { value: parseFloat(m[1]), type: m[2] ? m[2].toUpperCase() : null };
  m = t.match(/\b(dc|ac)\s*(\d{1,3}(?:\.\d+)?)\s*v\b/);
  if (m) return { value: parseFloat(m[2]), type: m[1].toUpperCase() };
  return null;
}

function voltageLabel(v) {
  return `${v.value} V${v.type ? " " + v.type : ""}`;
}

function detectIp(t) {
  const m = t.match(/\bip\s?-?(\d{2})(k)?\b/);
  return m ? `IP${m[1]}${m[2] ? "K" : ""}` : null;
}

function detectOutput(t) {
  const m = t.match(/\b(pnp|npn|namur|io-?link|relay|analog(?:ue)?|4-?20\s?ma)\b/);
  return m ? m[1].toUpperCase().replace(/\s+/g, "") : null;
}

function detectMounting(t) {
  if (/\b(?:non[- ]?flush|unshielded|not\s+flush)\b/.test(t)) return "nonFlush";
  if (/\b(?:flush|shielded|embeddable)\b/.test(t)) return "flush";
  return null;
}

function detectBodySize(t) {
  // "M12 connector / plug / 4-pin" is a connector size, not the sensor body.
  const m = t.match(
    /(?<!connector\s)\bm(8|12|18|30)\b(?!\s*(?:connector|plug|socket|cable|pigtail|\d[- ]?pin|\d-?wire))/
  );
  return m ? `M${m[1]}` : null;
}

function detectMountEnv(t) {
  if (
    /\b(?:mounted\s+(?:in|on|into|inside|to)\s+(?:a\s+|the\s+)?(?:steel|metal|aluminium|aluminum)|(?:steel|metal|aluminium|aluminum|stainless)\s+(?:frame|bracket|housing|structure|rail|plate|support|table|chassis)|embedded\s+in|surrounded\s+by\s+metal|next\s+to\s+metal)\b/.test(
      t
    )
  )
    return "metal";
  if (
    /\b(?:open\s+(?:space|frame|mount)|free\s+space|no\s+metal\s+(?:around|nearby|close)|plastic\s+(?:frame|bracket|housing))\b/.test(
      t
    )
  )
    return "free";
  return null;
}

function detectSpeed(t) {
  const m = t.match(
    /(\d+(?:\.\d+)?)\s*(?:m\/s|m\/min|mm\/s|ft\/min|ppm|(?:parts?|pcs|pieces|items|units|boxes)\s*(?:per|\/)\s*(?:min(?:ute)?|sec(?:ond)?|s|hour|hr|h)\b)/
  );
  return m ? m[0].trim() : null;
}

function detectTempC(t) {
  const m = t.match(/(-?\d{2,3})\s*(?:°\s*c|deg(?:rees)?(?:\s*c)?|celsius)\b/);
  return m ? parseInt(m[1], 10) : null;
}

function detectEnv(t, tempC) {
  const out = [];
  for (const [key, re] of Object.entries(ENV_PATTERNS)) {
    if (re.test(t)) out.push(key);
  }
  if (tempC != null && tempC >= 70 && !out.includes("hot")) out.push("hot");
  if (tempC != null && tempC <= -10 && !out.includes("cold")) out.push("cold");
  return out;
}

function extractRequirements(t) {
  const beltInfo = detectBelt(t);
  const partSize = detectPartSize(t);
  const gap = detectGap(t, partSize);
  const tempC = detectTempC(t);
  return {
    target: detectTarget(beltInfo.stripped),
    belt: beltInfo.belt,
    beltWord: beltInfo.word,
    gapMm: gap.value,
    gapAssumed: gap.assumed,
    partSize: partSize ? partSize.label : null,
    voltage: detectVoltage(t),
    ip: detectIp(t),
    output: detectOutput(t),
    mounting: detectMounting(t),
    bodySize: detectBodySize(t),
    mountEnv: detectMountEnv(t),
    speed: detectSpeed(t),
    tempC,
    env: detectEnv(t, tempC),
    dustKnown: RE_DUST_KNOWN.test(t),
  };
}

function hasAnyParam(r) {
  return Boolean(
    r.target ||
      r.gapMm != null ||
      r.voltage ||
      r.env.length ||
      r.output ||
      r.mounting ||
      r.belt ||
      r.partSize ||
      r.speed ||
      r.ip ||
      r.bodySize ||
      r.mountEnv
  );
}

// ---------------------------------------------------------------------------
// 4. Engineering numbers (inductive proximity sensors)
// ---------------------------------------------------------------------------

// Standard rated sensing distances Sn (mm).
const SN_SERIES = [1, 1.5, 2, 2.5, 4, 5, 8, 10, 12, 15, 20, 22, 30, 40];

// IEC 60947-5-2: assured operating distance is <= 0.81 x Sn. We use 0.8 as the rule of thumb.
const OPERATING_FRACTION = 0.8;

// Typical reduction factors vs. the standard mild-steel target (varies by brand: check datasheet).
const REDUCTION = { ferrous: 1, stainless: 0.75, nonFerrous: 0.4 };

// Typical maximum Sn by body size in standard catalogues (varies by brand).
const BODY_MAX_SN = {
  flush: { M8: 2, M12: 4, M18: 8, M30: 15 },
  nonFlush: { M8: 4, M12: 8, M18: 12, M30: 22 },
};

export function nextStandardSn(x) {
  if (!Number.isFinite(x) || x <= 0) return null;
  for (const s of SN_SERIES) if (s >= x - 1e-9) return s;
  return null;
}

/** Smallest standard Sn (mm) that keeps `gapMm` within 80% of the corrected range. null if > 40 mm. */
export function requiredSn(gapMm, material = "ferrous") {
  const f = REDUCTION[material] ?? 1;
  return nextStandardSn(gapMm / (OPERATING_FRACTION * f));
}

/** Body sizes whose typical maximum Sn reaches `sn`, for "flush" or "nonFlush". */
export function bodiesFor(sn, mode) {
  const table = BODY_MAX_SN[mode];
  if (!table || sn == null) return [];
  return Object.keys(table).filter((k) => table[k] >= sn);
}

const METAL_TARGETS = new Set(["ferrous", "stainless", "nonFerrous", "mixed", "metal"]);

function baseMaterialKey(target) {
  if (target === "nonFerrous" || target === "mixed") return "nonFerrous";
  if (target === "stainless") return "stainless";
  return "ferrous"; // ferrous, or generic "metal" (steel assumed until confirmed)
}

// ---------------------------------------------------------------------------
// 5. Plans (what Claude is told)
// ---------------------------------------------------------------------------

function emptyPlan() {
  return {
    sensorType: null,
    facts: [],
    envNotes: [],
    avoid: [],
    keySpecs: [],
    checks: [],
    missing: [],
    assumptions: [],
    searchQuery: null,
    numbers: {},
  };
}

function envNotesMetal(env) {
  const N = [];
  if (env.includes("dust"))
    N.push(
      "Dust: non-conductive dust does not affect inductive sensors (photoelectric lenses foul and capacitive sensors false-trigger), so this is a good fit. Still specify IP67 or better."
    );
  if (env.includes("metallicDebris"))
    N.push(
      "Metallic swarf/filings can build up on the sensing face and cause false triggers: mount so debris falls away, keep the face easy to clean, and plan periodic cleaning."
    );
  if (env.includes("wet"))
    N.push(
      "Moisture/washdown: IP67 minimum; IP68/IP69K for high-pressure washdown; stainless-steel housing for hygienic or corrosive areas."
    );
  if (env.includes("oil"))
    N.push("Oil/coolant: check housing and cable compatibility (PUR cable, nickel-plated brass or stainless housing).");
  if (env.includes("hot"))
    N.push("High temperature: standard sensors are typically rated to about 70-85 °C; check the maximum ambient rating or use a high-temperature version.");
  if (env.includes("cold"))
    N.push("Cold/freezer: check the minimum ambient rating (many standard sensors stop at about -25 °C).");
  if (env.includes("welding"))
    N.push("Welding: choose weld-field-immune, spatter-resistant (e.g. PTFE-coated) versions.");
  if (env.includes("hazardous"))
    N.push(
      "Explosive atmosphere: a standard 24 V DC sensor is NOT acceptable. It needs ATEX/IECEx certification (often NAMUR with an isolating amplifier). Flag for sales/engineering review."
    );
  if (env.includes("vibration"))
    N.push("Vibration/impact: use a protective bracket or guard and lock nuts; consider a sturdier metal housing.");
  if (env.includes("chemical"))
    N.push("Chemicals: verify housing and cable chemical resistance (stainless steel or PTFE-coated).");
  return N;
}

function envNotesNonMetal(env) {
  const N = [];
  if (env.includes("dust"))
    N.push(
      "Dust fouls photoelectric lenses over time: use IP67, prefer through-beam or retro-reflective with plenty of excess gain, and plan lens cleaning or an air purge."
    );
  if (env.includes("wet"))
    N.push("Moisture/washdown: IP67 minimum, IP69K for high-pressure washdown; stainless housing where hygienic.");
  if (env.includes("oil")) N.push("Oil/coolant: film on the lens reduces signal; check housing/cable compatibility.");
  if (env.includes("hot")) N.push("High temperature: check the maximum ambient rating.");
  if (env.includes("hazardous"))
    N.push("Explosive atmosphere: needs ATEX/IECEx-certified sensors. Flag for sales/engineering review.");
  return N;
}

function buildSensingPlan(req) {
  const plan = emptyPlan();
  const gap = req.gapMm;
  const ask = (key, question) => plan.missing.push({ key, question });

  // ---------- Metal targets -> inductive ----------
  if (METAL_TARGETS.has(req.target)) {
    plan.sensorType = "Inductive proximity sensor (3-wire DC)";
    plan.facts.push(
      "Inductive sensors detect metal only, have no moving parts, and are unaffected by non-conductive dust, dirt and ambient light: the standard choice for metal parts on a conveyor."
    );

    if (gap != null) {
      const byMat = {
        ferrous: requiredSn(gap, "ferrous"),
        stainless: requiredSn(gap, "stainless"),
        nonFerrous: requiredSn(gap, "nonFerrous"),
      };
      const base = baseMaterialKey(req.target);
      const minSn = byMat[base];
      plan.numbers = { gapMm: gap, minSn, byMaterial: byMat, baseMaterial: base };

      if (minSn == null) {
        plan.facts.push(
          `A ${gap} mm working gap needs more than the largest standard inductive range (about 40 mm rated). Options: mount the sensor closer, or consider a different technology.`
        );
      } else {
        const ratio = Number((gap / OPERATING_FRACTION / (REDUCTION[base] ?? 1)).toFixed(2));
        plan.facts.push(
          `Range rule: keep the working gap at or below ~80% of the rated sensing distance Sn (IEC 60947-5-2 allows for drift with temperature and voltage). For a ${gap} mm gap on ${
            base === "ferrous" ? "steel" : base === "stainless" ? "stainless steel" : "non-ferrous metal"
          }: ${gap} ÷ ${OPERATING_FRACTION}${base === "ferrous" ? "" : " ÷ " + REDUCTION[base]} = ${ratio} mm, so the next standard size is Sn ${minSn} mm.`
        );
        if (req.target !== "ferrous") {
          plan.facts.push(
            `Material matters (Sn is rated on 1 mm mild steel): for the same ${gap} mm gap the rated Sn needed is about ${byMat.ferrous ?? ">40"} mm for steel, ${byMat.stainless ?? ">40"} mm for stainless steel and ${byMat.nonFerrous ?? ">40"} mm for aluminium/brass/copper (typical reduction factors 0.75 and 0.4), or use a "factor-1" (all-metal) sensor whose range does not drop on non-ferrous metals.`
          );
        }
        if (req.target === "metal") {
          plan.assumptions.push("Metal type not stated: the baseline assumes steel/iron.");
        }

        let mode = null;
        if (req.mounting === "flush") mode = "flush";
        else if (req.mounting === "nonFlush") mode = "nonFlush";
        else if (req.mountEnv === "metal") mode = "flush";
        else if (req.mountEnv === "free") mode = "nonFlush";

        const f = bodiesFor(minSn, "flush");
        const n = bodiesFor(minSn, "nonFlush");
        plan.numbers.bodies = { flush: f, nonFlush: n, mode };
        const fmt = (a) => (a.length ? a.join(" / ") : "none in standard catalogues");
        const caveat = " (typical catalogue values; they vary by manufacturer: confirm on the datasheet)";

        if (mode === "flush") {
          plan.facts.push(
            `Mounting: flush (shielded) suits mounting in or next to metal but has the shortest range. At Sn ${minSn} mm typical bodies: ${fmt(f)}${caveat}.`
          );
        } else if (mode === "nonFlush") {
          plan.facts.push(
            `Mounting: non-flush (unshielded) gives roughly 1.5-2x the range of flush for the same body but needs a metal-free zone around the sensing head. At Sn ${minSn} mm typical bodies: ${fmt(n)}${caveat}.`
          );
        } else {
          plan.facts.push(
            `Flush vs non-flush is not decided yet. Flush (shielded) can sit in or next to metal but has the shortest range: at Sn ${minSn} mm typical bodies ${fmt(f)}. Non-flush (unshielded) needs a metal-free zone around the head: typical bodies ${fmt(n)}${caveat}.`
          );
        }

        plan.searchQuery = [req.bodySize, "inductive proximity sensor", `${minSn} mm`].filter(Boolean).join(" ");
      }
    } else {
      plan.searchQuery = [req.bodySize, "inductive proximity sensor"].filter(Boolean).join(" ");
      ask("gap", "What gap (mm) will there be between the sensor face and the part?");
    }

    if (req.gapAssumed) {
      plan.assumptions.push(`The ${gap} mm figure was read as the sensor-to-part gap. Ask the customer to correct it if wrong.`);
    }
    plan.facts.push(
      "Rated Sn assumes a target at least as large as the sensing face (about 12 mm for M12, 18 mm for M18, 30 mm for M30) and at least 1 mm thick mild steel; smaller or thinner parts reduce the effective range."
    );

    plan.envNotes = envNotesMetal(req.env);

    plan.avoid.push(
      "Photoelectric: dust and oil film on the lens cause gradual signal loss and false triggers; shiny or mixed-finish metal also reflects inconsistently."
    );
    plan.avoid.push("Capacitive: reacts to dust build-up and humidity and has no advantage for metal targets.");
    if (gap != null && gap <= 30) {
      plan.avoid.push("Ultrasonic: has a blind zone of typically several cm, so it cannot work at this short range.");
    }

    plan.keySpecs.push(
      plan.numbers.minSn != null
        ? `Rated sensing distance Sn: at least ${plan.numbers.minSn} mm (working gap ${gap} mm kept within ~80% of Sn)`
        : "Rated sensing distance Sn sized so the working gap is at most ~80% of Sn",
      "Flush (shielded) vs non-flush (unshielded), based on what surrounds the sensor",
      "Body size: M12 or M18 are typical on conveyors; M30 for longer range",
      "Supply 10-30 V DC, 3-wire; output PNP or NPN to match the PLC input; NO or NC as the logic needs",
      "Switching frequency (Hz) comfortably above parts per second (belt speed ÷ part length plus gap)",
      "Protection IP67 minimum (IP68/IP69K if washdown), temperature range, housing material and cable type",
      "Connection: M12 4-pin connector (quick replacement) or pre-wired cable; LED status indicator",
      "If parts are non-ferrous: a factor-1 sensor or a larger Sn"
    );

    plan.checks.push(
      "Confirm the part material, size and thickness: they set the real sensing distance.",
      "Confirm the worst-case gap (belt sag, part height variation, vibration) is still within ~80% of Sn.",
      "Check the PLC/controller input: supply voltage, PNP vs NPN, NO vs NC, and load current.",
      "Compare switching frequency with belt speed and part spacing.",
      "Check mounting: free space for non-flush, spacing between neighbouring sensors, mechanical protection from impact, bracket and lock nuts.",
      "Check the environment: metallic swarf, oil/coolant, washdown, temperature extremes, and the IP rating and housing material they need.",
      "Check certifications if required (CE, UL, ATEX) and that a matching connector cable and bracket are available."
    );

    // Questions, in priority order (the brief shows the first 3).
    if (req.target === "metal")
      ask(
        "material",
        "Are the parts steel/iron, or aluminium/brass/copper? (Non-ferrous metals need roughly 2-3x the rated range.)"
      );
    if (!req.partSize)
      ask("partSize", "Roughly how big and thick are the parts? (Small or thin parts shorten the effective range.)");
    if (!req.mounting && !req.mountEnv)
      ask(
        "mounting",
        "What is the belt made of, and will the sensor sit beside a steel frame or in free space? (This decides flush vs non-flush.)"
      );
    if (req.env.includes("dust") && !req.env.includes("metallicDebris") && !req.dustKnown)
      ask(
        "dustType",
        "Is the dust ordinary (cement, flour, wood) or metallic swarf/oily debris? (Metallic build-up on the sensor face can cause false triggers.)"
      );
    if (!req.speed) ask("speed", "What are the belt speed and the spacing between parts? (This sets the switching frequency needed.)");
    if (!req.output) ask("output", "Does your PLC input expect PNP or NPN, and do you prefer an M12 connector or a cable?");
  }

  // ---------- Non-metal targets -> photoelectric ----------
  else if (req.target === "nonMetal") {
    plan.sensorType = "Photoelectric sensor (diffuse with background suppression, or through-beam / retro-reflective)";
    plan.facts.push(
      "Inductive sensors cannot detect non-metallic objects, so they are not suitable here.",
      "Diffuse (proximity) photoelectric sensors detect the object directly with no reflector, typically from a few cm to about a metre. Background-suppression models ignore the belt behind the object, which matters on conveyors.",
      "Retro-reflective and through-beam types reach further and tolerate dirt better. Use polarised retro-reflective or through-beam for clear, glossy or transparent objects."
    );
    plan.avoid.push(
      "Capacitive: can detect non-metals through thin walls at very short range (mm to about 30 mm), but is sensitive to dust and humidity.",
      "Ultrasonic: copes with clear or varied surfaces but has a blind zone of typically several cm and a larger body."
    );
    plan.envNotes = envNotesNonMetal(req.env);
    plan.keySpecs.push(
      "Sensing principle: diffuse with background suppression, or through-beam / retro-reflective",
      "Sensing range with margin (excess gain), because dust reduces the signal over time",
      "Supply 10-30 V DC; output PNP or NPN to match the PLC; light-on / dark-on switching",
      "Response time / switching frequency versus belt speed and object spacing",
      "IP67 minimum, lens material, temperature range; M12 connector or cable"
    );
    plan.checks.push(
      "Confirm object material, colour, gloss and transparency: they decide the sensing principle.",
      "Confirm the detection distance and the background (belt or frame) behind the object.",
      "Check the PLC input: voltage, PNP vs NPN, and light-on vs dark-on logic.",
      "Check lens cleaning access or an air purge in dusty areas.",
      "Check mounting space, alignment tolerance and protection from impact."
    );
    plan.searchQuery = "photoelectric sensor";
    ask(
      "objectDetail",
      "What exactly are the objects (material, colour, clear or glossy?) and roughly how big are they?"
    );
    if (gap == null) ask("gap", "At what distance will the sensor sit from the objects?");
    if (!req.speed) ask("speed", "What are the belt speed and the spacing between objects?");
    if (!req.output) ask("output", "Does your PLC input expect PNP or NPN, and do you prefer an M12 connector or a cable?");
  }

  // ---------- Target unknown ----------
  else {
    plan.sensorType = "Depends on what is being detected";
    plan.facts.push(
      "Metal objects: inductive proximity sensor (most robust in dust and oil).",
      "Non-metal solids (plastic, cardboard, wood): photoelectric sensor; capacitive only at very short range.",
      "Clear or shiny objects: polarised retro-reflective or through-beam photoelectric, or ultrasonic.",
      "Liquids and levels need level-specific sensors: confirm before recommending."
    );
    plan.keySpecs.push(
      "Sensing principle matched to the object material",
      "Sensing distance with margin",
      "Supply voltage and PNP/NPN output to match the PLC",
      "IP rating and temperature range for the environment"
    );
    plan.checks.push(
      "Confirm object material, size and surface finish.",
      "Confirm the working distance and mounting space.",
      "Confirm the PLC input type and the environment (dust, oil, washdown, temperature)."
    );
    ask("target", "What exactly are you detecting (metal, plastic, cardboard, glass...) and at what distance will the sensor sit?");
    if (!req.output) ask("output", "Does your PLC input expect PNP or NPN?");
  }

  if (!req.voltage) plan.assumptions.push("Supply not stated: assuming 24 V DC (the most common).");
  if (req.voltage && req.voltage.type === "AC")
    plan.checks.push(
      "The customer mentioned an AC supply: standard 3-wire DC sensors will not work. Check for AC or AC/DC 2-wire sensor versions."
    );

  return plan;
}

// ---------------------------------------------------------------------------
// 6. Public API
// ---------------------------------------------------------------------------

function describeRequirements(req, sensing) {
  const L = [];
  if (sensing) {
    const labels = {
      ferrous: "steel/iron (ferrous) parts",
      stainless: "stainless-steel parts",
      nonFerrous: "non-ferrous metal parts (aluminium/brass/copper)",
      mixed: "mixed ferrous and non-ferrous metal parts",
      metal: "metal parts (steel vs aluminium/brass not stated)",
      nonMetal: "non-metal objects",
    };
    if (req.target && labels[req.target]) L.push(`Detecting: ${labels[req.target]}`);
    if (req.gapMm != null)
      L.push(`Working gap: ${req.gapMm} mm${req.gapAssumed ? " (assumed: the customer gave a single mm figure)" : ""}`);
    if (req.partSize) L.push(`Part size: ${req.partSize}`);
    if (req.belt) L.push(`Belt: ${req.beltWord} (${req.belt})`);
    if (req.mounting) L.push(`Mounting preference: ${req.mounting === "flush" ? "flush (shielded)" : "non-flush (unshielded)"}`);
    if (req.mountEnv) L.push(`Mounting surroundings: ${req.mountEnv === "metal" ? "in/next to metal" : "free space"}`);
    if (req.bodySize) L.push(`Body size asked for: ${req.bodySize}`);
    if (req.output) L.push(`Output asked for: ${req.output}`);
    if (req.speed) L.push(`Speed: ${req.speed}`);
  }
  if (req.voltage) L.push(`Supply: ${voltageLabel(req.voltage)}`);
  if (req.ip) L.push(`Protection asked for: ${req.ip}`);
  if (req.tempC != null) L.push(`Temperature mentioned: ${req.tempC} °C`);
  if (req.env.length) L.push(`Environment: ${req.env.map((k) => ENV_LABELS[k]).join(", ")}`);
  return L;
}

/**
 * Follow-up support: if this message is not an enquiry by itself but answers one asked in the
 * last few user turns, return the earlier enquiry text so both can be analysed together.
 */
function findAdvisoryContext(current, history) {
  if (!Array.isArray(history) || history.length === 0) return null;
  const cur = lc(current);
  if (RE_LOOKUP_OPENER.test(cur)) return null;
  if (cur.split(" ").length > 40) return null;
  if (!hasAnyParam(extractRequirements(cur))) return null;

  let users = history
    .filter((m) => m && m.role === "user")
    .map((m) => cleanText(textOf(m)))
    .filter(Boolean);

  // history normally already contains the current turn as its last user message: drop it.
  if (users.length && users[users.length - 1].includes(cleanText(current))) users = users.slice(0, -1);

  const recent = users.slice(-4);
  for (let i = recent.length - 1; i >= 0; i--) {
    const c = classify(recent[i]);
    if (c.intent) return { cls: c, text: recent.slice(i).join(" ") };
  }
  return null;
}

function analyzeEnquiryUnsafe(userMessage, history, opts) {
  const current = cleanText(userMessage);
  if (!current || opts.hasSku) return null;

  let text = current;
  let cls = classify(current);
  let continuation = false;

  if (!cls.intent) {
    const ctx = findAdvisoryContext(current, history);
    if (!ctx) return null;
    cls = ctx.cls;
    text = `${ctx.text} ${current}`;
    continuation = true;
  }

  const t = lc(text);
  const req = extractRequirements(t);
  const sensing = cls.intent === "selection" && isSensing(t);
  const domain = sensing ? "sensing" : "generic";
  const plan = sensing ? buildSensingPlan(req) : emptyPlan();
  const rewriteSearch = opts.rewriteSearch !== false;

  return {
    intent: cls.intent,
    domain,
    continuation,
    requirements: req,
    requirementLines: describeRequirements(req, sensing),
    plan,
    searchQuery: rewriteSearch ? plan.searchQuery : null,
  };
}

/**
 * Analyse a chat message.
 *
 * @param {string} userMessage  raw text of the current message
 * @param {Array}  history      conversation messages ({role, content}); may include the current turn
 * @param {{hasSku?: boolean, rewriteSearch?: boolean}} opts
 * @returns {null | {intent, domain, continuation, requirements, requirementLines, plan, searchQuery}}
 *   null = not an advisory enquiry: run the normal pipeline untouched.
 *   Never throws.
 */
export function analyzeEnquiry(userMessage, history = [], opts = {}) {
  try {
    return analyzeEnquiryUnsafe(userMessage, history, opts || {});
  } catch (err) {
    console.error("[Advisory] analyze failed:", err?.message || err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 7. Brief builder
// ---------------------------------------------------------------------------

export function buildAdvisoryBrief(a) {
  if (!a) return "";
  const L = [];
  const p = a.plan;
  const isTrouble = a.intent === "troubleshooting";
  const isSensing = a.domain === "sensing";

  const kind = isTrouble
    ? "troubleshooting (a problem to solve, not a product lookup)"
    : isSensing
      ? "application advice: sensor selection"
      : "application advice: general product selection";

  L.push(ADVISORY_TAG);
  L.push(`Enquiry type: ${kind}.`);
  L.push(
    a.continuation
      ? "This message answers earlier questions in the same enquiry: update the recommendation with the new details and do not repeat what was already said."
      : "The customer wants a recommendation and guidance, not just a product list."
  );
  L.push("This brief OVERRIDES the usual 2-3 sentence limit for THIS reply only. Follow the REPLY FORMAT at the end.");
  L.push("");

  if (a.requirementLines.length) {
    L.push("WHAT THE CUSTOMER TOLD US");
    a.requirementLines.forEach((x) => L.push(`- ${x}`));
    L.push("");
  }
  if (p.assumptions.length) {
    L.push("ASSUMPTIONS (state them plainly in one line)");
    p.assumptions.forEach((x) => L.push(`- ${x}`));
    L.push("");
  }

  if (isSensing) {
    L.push(`RECOMMENDED SENSOR TYPE: ${p.sensorType}`);
    L.push("");
    L.push("ENGINEERING FACTS (pre-computed: use these numbers exactly, do not recompute or contradict them)");
    p.facts.forEach((x) => L.push(`- ${x}`));
    L.push("");
    if (p.envNotes.length) {
      L.push("ENVIRONMENT NOTES");
      p.envNotes.forEach((x) => L.push(`- ${x}`));
      L.push("");
    }
    if (p.avoid.length) {
      L.push("ALTERNATIVES TO AVOID / WHY");
      p.avoid.forEach((x) => L.push(`- ${x}`));
      L.push("");
    }
    L.push("KEY SPECS TO COVER (pick the 5-6 that matter most, with concrete values)");
    p.keySpecs.forEach((x) => L.push(`- ${x}`));
    L.push("");
    L.push("CHECK BEFORE BUYING (pick the 4-5 most relevant)");
    p.checks.forEach((x) => L.push(`- ${x}`));
    L.push("");
    const qs = p.missing.slice(0, 3);
    if (qs.length) {
      L.push("STILL UNKNOWN (ask at most these, in this order)");
      qs.forEach((q, i) => L.push(`${i + 1}. ${q.question}`));
    } else {
      L.push("STILL UNKNOWN: nothing critical. Do not invent questions.");
    }
    L.push("");
  } else if (isTrouble) {
    L.push("GUIDANCE");
    L.push("- Use your own general engineering knowledge. Be conservative and standard: no invented catalogue data, brand claims or numbers you are unsure of.");
    L.push("- Do not give a definitive diagnosis: give the most likely causes and how to narrow them down.");
    L.push("- Safety: if the checks involve electrical, pneumatic or hydraulic energy, tell the customer to isolate power / depressurise first.");
    L.push("");
  } else {
    L.push("GUIDANCE");
    L.push("- No product playbook matched. Use your own general engineering knowledge, kept conservative and standard: no invented catalogue data, brand claims or numbers you are unsure of.");
    L.push("- Identify the product category, recommend the type/technology and why, give the key specs, and the checks before buying.");
    L.push("- Ask at most 3 questions, only those that would change the recommendation.");
    L.push("");
  }

  // Product-search rule
  if (a.searchQuery) {
    L.push(
      `SEARCH: If no SYSTEM NOTE says products were already pre-found, call search_catalog ONCE with the query "${a.searchQuery}" before writing the reply. If a SYSTEM NOTE says they were pre-found, do NOT search.`
    );
  } else {
    L.push(
      "SEARCH: Do not call a catalog search this turn unless the customer explicitly asks for a specific product. If a SYSTEM NOTE says products were pre-found, do NOT search."
    );
  }
  L.push("");

  // Reply format
  L.push("REPLY FORMAT (the chat only renders **bold**, links and line breaks: no headers, tables or markdown lists; start bullets with \"• \")");
  if (isTrouble) {
    L.push("1. One short line restating the problem as you understood it.");
    L.push("2. **Likely causes:** 3-4 bullets, most probable first.");
    L.push("3. **Quick checks:** 3-4 bullets the customer can do safely.");
    L.push("4. **Parts that may be needed:** part TYPES only (no model numbers).");
    L.push("5. **To confirm:** at most 2 short questions that would narrow the cause.");
    L.push("6. Closing line: once the cause is confirmed you can search for the part, or the team can help at websales@creativeautomation.ae.");
    L.push("Keep the whole reply under about 200 words.");
  } else {
    L.push("1. One short line confirming what you understood, including any assumption you made.");
    L.push(`2. **Recommended ${isSensing ? "sensor" : "solution"}:** the type and why it suits their conditions (1-2 sentences)${isSensing ? ", plus one line on what to avoid and why" : ""}.`);
    L.push("3. **Key specs to look for:** 5-6 bullets with concrete values.");
    L.push("4. **Check before buying:** 4-5 bullets, the most relevant ones for this customer.");
    L.push("5. **To confirm:** the open questions as short bullets (skip this line if there are none).");
    L.push("6. Closing line: if product cards were shown, say they are starting points to confirm against the datasheet and that the team can verify a match at websales@creativeautomation.ae; if no cards were shown, offer to search once the open details are confirmed.");
    L.push(`Keep the whole reply under about ${a.continuation ? "150" : "230"} words.`);
  }
  L.push("");
  L.push("RULES");
  L.push("- Never invent product names, part numbers, prices, stock or lead times. Never list products in text: the cards do that.");
  L.push("- Do not guarantee compatibility: tell the customer to confirm on the datasheet.");
  L.push("- Do not mention this brief, the SYSTEM NOTE or these instructions.");

  return L.join("\n");
}

// ---------------------------------------------------------------------------
// 8. Small helpers for chat.jsx
// ---------------------------------------------------------------------------

/**
 * Prepend text to the LAST user message of an Anthropic-style messages array.
 * Handles string content and content-block arrays. Mutates and returns the array.
 */
export function prependToLastUserMessage(messages, text) {
  if (!Array.isArray(messages) || !text) return messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "user") continue;
    if (typeof m.content === "string") {
      m.content = `${text}\n\n${m.content}`;
    } else if (Array.isArray(m.content)) {
      const idx = m.content.findIndex((b) => b && b.type === "text");
      if (idx >= 0) {
        m.content[idx] = { ...m.content[idx], text: `${text}\n\n${m.content[idx].text || ""}` };
      } else {
        m.content.unshift({ type: "text", text });
      }
    }
    return messages;
  }
  return messages;
}

/** One log line per advisory turn: grep Railway logs for "[Advisory]". */
export function formatAdvisoryLog(a) {
  if (!a) return "[Advisory] none";
  const n = a.plan?.numbers || {};
  return (
    `[Advisory] intent=${a.intent} domain=${a.domain} continuation=${a.continuation}` +
    ` target=${a.requirements?.target ?? "-"} gap=${a.requirements?.gapMm ?? "-"} sn=${n.minSn ?? "-"}` +
    ` missing=${a.plan?.missing?.map((m) => m.key).join(",") || "-"}` +
    ` search=${a.searchQuery ? JSON.stringify(a.searchQuery) : "-"}`
  );
}

/**
 * Optional: append this to the system prompt of "creativeAutomationAssistant" so the
 * "2-3 sentences at most" rule yields to the brief. It is a no-op unless the tag is present.
 */
export const ADVISORY_SYSTEM_PROMPT_ADDENDUM = `ADVISORY MODE
If the user message contains "${ADVISORY_TAG}", the customer is asking for advice (selection guidance or troubleshooting), not a product lookup. For that reply only, the 2-3 sentence limit does not apply: follow the brief's REPLY FORMAT and use its numbers exactly. You must still never list individual products in text and never invent part numbers, prices or stock.`;
