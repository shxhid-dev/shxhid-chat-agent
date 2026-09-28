// app/services/advisory.server.js — v1.1
//
// ADVISORY MODE for GENERAL ENQUIRIES
// e.g. "I need a sensor solution for detecting metal parts on a conveyor belt, about 5 mm
// away, 24V DC, dusty factory. Suggest the right sensor type, key specs, and what to check
// before buying."
//
// What it does (pure functions: no LLM call, no network, no DB, no dependencies):
//   1. IDENTIFY - decides whether a message is an application-advice / troubleshooting
//                 enquiry rather than a product, SKU, stock or order lookup.
//   2. CLARIFY  - extracts what the customer already told us (material, gap, voltage,
//                 environment...), works out what is still missing, and picks <=3 questions.
//   3. GROUND   - computes engineering numbers (e.g. inductive rated range Sn from the working
//                 gap) and builds an [ADVISORY BRIEF] that chat.jsx places in the last user
//                 message, so Claude answers with: recommended type, key specs, checks before
//                 buying, and questions to confirm.
//   4. ALIGN    - returns a search query that matches the ADVICE (e.g. "inductive proximity
//                 sensor 8 mm") so the product cards agree with the text, or tells chat.jsx to
//                 skip the pre-search when no product query fits yet.
//   5. FALLBACK - buildAdvisoryFallback() gives chat.jsx a deterministic answer if Claude fails.
//
// v1.1 (28 Sep 2026)
//   - Exposes skipPreSearch, questions and buildAdvisoryFallback() (used by chat.jsx v2.4).
//   - Follow-ups: each message is parsed separately and later answers override earlier ones
//     ("metal" then "aluminium" -> aluminium). A topic switch ("show me ...") ends the enquiry.
//   - Guards: order/account questions, "do you have / price" lookups and "fail-safe" are no
//     longer mistaken for advice or troubleshooting.
//   - Sensing: rated Sn vs working gap, "sensing distance" ambiguity, supply checks (AC, AC/DC,
//     out-of-range DC, 110/230 V with no AC/DC), throughput -> switching frequency, M12x1 bodies,
//     body-size sanity check, personnel-safety flag, inch/cm gaps.
//   - Troubleshooting: typical causes, safe checks and part types for cylinders, valves, sensors,
//     drives, motors and breakers.
//
// Nothing here changes the DB schema, env vars or package.json. English input only.

export const ADVISORY_VERSION = "1.1.0";
export const ADVISORY_TAG = "[ADVISORY BRIEF — NOT FROM USER]";

const MIN_SELECTION_SCORE = 3; // minimum classify() score for a selection enquiry
const LOOKUP_PENALTY = 2;      // "do you have / price" without an advice cue
const MAX_FOLLOWUP_WORDS = 40; // longer messages are never treated as follow-up answers
const MAX_LOOKBACK_TURNS = 4;  // user turns searched for the original enquiry
const MAX_QUESTIONS = 3;       // clarifying questions shown to Claude

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

function round1(n) {
  return Math.round(n * 10) / 10;
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

// Cues strong enough that a price/stock phrase in the same message does not cancel them.
const RE_ADVICE_STRONG =
  /\b(?:suggest\w*|recommend\w*|advi[cs]e\w*|guidance|right|best|suitable|appropriate|what\s+(?:type|kind|sort)\s+of|which\s+type|how\s+(?:do\s+|can\s+|should\s+|to\s+)(?:i\s+|we\s+)?(?:choose|select|pick|size|specify)|before\s+(?:buying|purchasing|ordering)|key\s+specs?|what\s+(?:to|should\s+i|do\s+i)\s+(?:check|look\s+for|consider))\b/i;

const RE_FRAMING =
  /\b(?:need|needs|needed|looking\s+for|looking\s+to|want|wants|require|requires|required|planning|installing|designing)\b/i;

const RE_PURPOSE =
  /\b(?:detect(?:ing|ion|or|ors)?|sens(?:e|ing)|measur(?:e|ing|ement)|monitor(?:ing)?|count(?:ing)?|control(?:ling)?|position(?:ing)?|protect(?:ing|ion)?|regulat(?:e|ing)|prevent(?:ing)?|sort(?:ing)?|lift(?:ing)?|pump(?:ing)?|convey(?:ing)?|automat(?:e|ing|ion)|eliminat(?:e|ing)|reduc(?:e|ing)|solv(?:e|ing))\b/i;

const RE_PROCESS =
  /\b(?:conveyors?|belts?|assembly\s+line|production\s+line|packag(?:e|ing)\s+line|packing\s+line|machine|machines|machinery|factory|factories|plant|workshop|robots?|palleti[sz]\w*|warehouse|press|furnace)\b/i;

const RE_NUMERIC_SPEC =
  /\b\d+(?:\.\d+)?\s*(?:mm|cm|kw|hp|bar|psi|vdc|vac|v|ma|hz|khz|rpm|°\s*c|nm|l\/min|kg)\b/i;

const RE_TROUBLE_CUE =
  /\b(?:leak(?:s|ing|age|ed)?|not\s+working|stopped\s+working|won'?t\s+(?:start|work|turn|run|close|open|switch|detect)|doesn'?t\s+(?:work|detect|switch|start)|not\s+(?:detecting|switching|starting)|fault(?:s|y)?|fail(?:s|ed|ing|ure|ures)?(?![- ]?safe)|trip(?:s|ping|ped)?|overheat(?:s|ing|ed)?|over[- ]heat(?:s|ing|ed)?|noisy|erratic|intermittent(?:ly)?|burn(?:t|ing|ed)?|damaged|error\s+code|alarm\s+code|jam(?:s|med|ming)?|stuck|false\s+(?:trigger(?:s|ing)?|signals?|detections?)|nuisance\s+trip(?:s|ping)?|drift(?:s|ing)?|vibrat(?:es|ing))\b/i;

const RE_TROUBLE_GATE =
  /\b(?:why|how\s+(?:do\s+|can\s+|to\s+|should\s+)(?:i\s+|we\s+)?(?:fix|stop|solve|prevent|repair|troubleshoot|diagnose)|what\s+causes|what(?:'s|\s+is)\s+wrong|troubleshoot\w*|diagnos\w*|my|our|help)\b/i;

// A message that opens like a plain product lookup is never treated as a follow-up,
// and it ends an earlier advisory thread (topic switch).
const RE_LOOKUP_OPENER =
  /^(?:show|list|find|search|do\s+you\s+(?:have|stock|sell|carry)|price|quote|how\s+much|can\s+i\s+(?:buy|order)|i\s+want\s+to\s+(?:buy|order)|add\s+to\s+cart|order|buy)\b/i;

// Price / stock phrases anywhere in the message.
const RE_STOCK_PHRASE =
  /\b(?:do\s+you\s+(?:have|stock|sell|carry|supply)|have\s+you\s+got|in\s+stock|availability|price|prices|pricing|how\s+much|quot(?:e|ation)|lead\s+time)\b/i;

// Order / account / shop questions: never advisory.
const RE_COMMERCE =
  /\b(?:(?:my|our)\s+(?:order|orders|delivery|shipment|parcel|invoice|payment|refund|account|cart|basket)|order\s+(?:status|number|no|id)|track(?:ing)?\s+(?:my|our)\s+order|refund|return\s+(?:policy|request)|log\s?in|sign\s?in|password|coupon|discount\s+code)\b/i;

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

// Product names that contain environment words ("heat shrink", "hot melt") are not environments.
function envText(t) {
  return t.replace(/\bheat[- ]?(?:shrink|sink)s?\b|\bhot[- ]?melt\b/g, " ");
}

function hasEnv(t) {
  const e = envText(t);
  return Object.values(ENV_PATTERNS).some((r) => r.test(e));
}

/**
 * Classify ONE message on its own.
 * Returns { intent: "selection" | "troubleshooting" | null, score }.
 *
 * Scoring (selection): select-cue 2 (or solution-cue 1) + framing 1 + purpose verb 1
 * + process context 1 + environment 1 + numeric spec 1, minus LOOKUP_PENALTY for a
 * price/stock phrase without a strong advice cue. Needs >= MIN_SELECTION_SCORE.
 */
function classify(text) {
  const t = lc(text);
  if (!t || t.length < 12) return { intent: null, score: 0 };
  if (RE_COMMERCE.test(t)) return { intent: null, score: 0 };

  const selectCue = RE_SELECT_CUE.test(t);
  const solutionCue = RE_SOLUTION_CUE.test(t);
  const lookupish = RE_STOCK_PHRASE.test(t) && !RE_ADVICE_STRONG.test(t);

  if (!selectCue && !lookupish && RE_TROUBLE_CUE.test(t) && (RE_TROUBLE_GATE.test(t) || solutionCue)) {
    return { intent: "troubleshooting", score: 3 };
  }

  let score = 0;
  if (selectCue) score += 2;
  else if (solutionCue) score += 1;
  if (RE_FRAMING.test(t)) score += 1;
  if (RE_PURPOSE.test(t)) score += 1;
  if (RE_PROCESS.test(t)) score += 1;
  if (hasEnv(t)) score += 1;
  if (RE_NUMERIC_SPEC.test(t)) score += 1;
  if (lookupish) score -= LOOKUP_PENALTY;

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

// Detecting PEOPLE (personnel protection) needs safety-rated devices.
const RE_SAFETY =
  /\b(?:personnel|operators?|workers?|people|persons?|humans?|hands?|fingers?|body\s+parts?|safety\s+(?:functions?|sensors?|guards?|light\s+curtains?|devices?)|machine\s+guard(?:ing)?|guarding)\b/;

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
    /\b(?:width|length|thickness|diameter|dia|size|height)\s*(?:of|is|=|:|about|approx(?:imately)?)?\s*(\d+(?:\.\d+)?)\s*(mm|cm)\b/
  );
  if (m) return { label: m[0].trim(), num: m[1] };
  m = t.match(
    /\b(?:small|tiny|thin|miniature|large|big|heavy)\s+(?:(?:metal|steel|iron)\s+)?(?:parts?|components?|pieces?|items?|bolts?|screws?|nuts?|washers?|sheets?)\b/
  );
  if (m) return { label: m[0], num: null };
  return null;
}

// Rated sensing distance the customer quotes ("Sn 8 mm", "rated range 8 mm").
const RE_RATED_SN = [
  /\bsn\s*(?:=|:|of|is)?\s*(\d+(?:\.\d+)?)\s*mm\b/,
  /\brated\s+(?:sensing\s+)?(?:range|distance)\s*(?:of|is|=|:)?\s*(\d+(?:\.\d+)?)\s*mm\b/,
  /(\d+(?:\.\d+)?)\s*mm\s+rated\s+(?:sensing\s+)?(?:range|distance)\b/,
];

function detectRatedSn(t) {
  for (const re of RE_RATED_SN) {
    const m = t.match(re);
    if (m) return { value: parseFloat(m[1]), text: m[0] };
  }
  return null;
}

const NUM = "(\\d+(?:\\.\\d+)?)";
const LEN_UNIT = "(mm|cm|inch(?:es)?)";
const QUAL = "(?:of|is|=|:|about|approx(?:imately)?|around|up\\s+to)?";

const RE_GAP_AFTER = new RegExp(
  NUM +
    "\\s*" +
    LEN_UNIT +
    "\\s*(?:away|gap|distance|clearance|range|apart|above|below|standoff|stand-off|from\\s+(?:the\\s+)?(?:belt|sensor|surface|part|parts|target|face|object|objects))\\b"
);
const RE_GAP_SENSING_BEFORE = new RegExp(
  "\\b(?:sensing\\s+(?:range|distance)|range)\\s*" + QUAL + "\\s*" + NUM + "\\s*" + LEN_UNIT + "\\b"
);
const RE_GAP_SENSING_AFTER = new RegExp(NUM + "\\s*" + LEN_UNIT + "\\s+sensing\\s+(?:range|distance)\\b");
const RE_GAP_BEFORE = new RegExp(
  "\\b(?:distance|gap|clearance|stand-?off)\\s*" + QUAL + "\\s*" + NUM + "\\s*" + LEN_UNIT + "\\b"
);

function toMm(n, unit) {
  const v = parseFloat(n);
  if (unit === "cm") return round1(v * 10);
  if (unit && unit.startsWith("inch")) return round1(v * 25.4);
  return v;
}

/**
 * Working gap between sensor face and part, in mm.
 * kind: "explicit" ("5 mm away", "gap 5 mm"), "sensingRange" ("sensing distance 5 mm": could also
 * be the rated Sn of an old sensor), "lone" (the only mm figure in the message), or null.
 */
function detectGap(t, partSize) {
  let m = t.match(RE_GAP_AFTER);
  if (m) return { value: toMm(m[1], m[2]), kind: "explicit" };
  m = t.match(RE_GAP_SENSING_BEFORE) || t.match(RE_GAP_SENSING_AFTER);
  if (m) return { value: toMm(m[1], m[2]), kind: "sensingRange" };
  m = t.match(RE_GAP_BEFORE);
  if (m) return { value: toMm(m[1], m[2]), kind: "explicit" };

  const all = [...t.matchAll(/(\d+(?:\.\d+)?)\s*mm\b/g)]
    .map((x) => x[1])
    .filter((n) => !partSize || n !== partSize.num);
  if (all.length === 1) return { value: parseFloat(all[0]), kind: "lone" };

  return { value: null, kind: null };
}

const VOLT_TYPE = "(ac\\s*\\/\\s*dc|dc\\s*\\/\\s*ac|dc|ac|uc)";
const RE_VOLT_RANGE = new RegExp(
  "\\b(\\d{1,3}(?:\\.\\d+)?)\\s*(?:-|–|to)\\s*(\\d{1,3}(?:\\.\\d+)?)\\s*v(?:olts?)?(?:\\s*[-_]?\\s*" + VOLT_TYPE + ")?\\b"
);
const RE_VOLT_SINGLE = new RegExp(
  "\\b(\\d{1,3}(?:\\.\\d+)?)\\s*v(?:olts?)?(?:\\s*[-_]?\\s*" + VOLT_TYPE + ")?\\b"
);
const RE_VOLT_PREFIX = new RegExp("\\b" + VOLT_TYPE + "\\s*(\\d{1,3}(?:\\.\\d+)?)\\s*v\\b");

function normVoltType(s) {
  if (!s) return null;
  const x = s.replace(/\s/g, "").toUpperCase();
  if (x === "AC/DC" || x === "DC/AC" || x === "UC") return "AC/DC";
  return x; // "AC" | "DC"
}

function detectVoltage(t) {
  let m = t.match(RE_VOLT_RANGE);
  if (m) return { value: parseFloat(m[2]), min: parseFloat(m[1]), type: normVoltType(m[3]) };
  m = t.match(RE_VOLT_SINGLE);
  if (m) return { value: parseFloat(m[1]), min: null, type: normVoltType(m[2]) };
  m = t.match(RE_VOLT_PREFIX);
  if (m) return { value: parseFloat(m[2]), min: null, type: normVoltType(m[1]) };
  return null;
}

function voltageLabel(v) {
  const n = v.min != null ? `${v.min}-${v.value}` : `${v.value}`;
  return `${n} V${v.type ? " " + v.type : ""}`;
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
  // "M12 connector / plug / 4-pin" is a connector size, not the sensor body. "M12x1" is a body.
  const m = t.match(
    /(?<!connector\s)\bm(8|12|18|30)(?:x\d+(?:\.\d+)?)?\b(?!\s*(?:connector|plug|socket|cable|pigtail|\d[- ]?pin))/
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

const COUNT_NOUNS = "(?:parts?|pcs|pieces|items|units|boxes|bottles|cans|products)";

function detectSpeed(t) {
  const m = t.match(
    new RegExp(
      "(\\d+(?:\\.\\d+)?)\\s*(?:m\\/s|m\\/min|mm\\/s|ft\\/min|" +
        COUNT_NOUNS +
        "\\s*(?:per|\\/)\\s*(?:min(?:ute)?|sec(?:ond)?|s|hour|hr|h)\\b)"
    )
  );
  return m ? m[0].trim() : null;
}

/** Parts per second from "600 parts per minute", "2 pcs/s", "7200 boxes per hour". */
function detectPartsPerSecond(t) {
  const m = t.match(
    new RegExp(
      "(\\d+(?:\\.\\d+)?)\\s*" + COUNT_NOUNS + "\\s*(?:per|\\/)\\s*(min(?:ute)?|sec(?:ond)?|s|hour|hr|h)\\b"
    )
  );
  if (!m) return null;
  const n = parseFloat(m[1]);
  const u = m[2];
  const div = /^min/.test(u) ? 60 : /^(?:hour|hr|h)$/.test(u) ? 3600 : 1;
  const pps = n / div;
  return pps > 0 ? Math.round(pps * 100) / 100 : null;
}

function detectTempC(t) {
  const m = t.match(/(-?\d{1,3})\s*(?:°\s*c|deg(?:rees)?\s*c(?:elsius)?|celsius)\b/);
  return m ? parseInt(m[1], 10) : null;
}

function detectEnv(t, tempC) {
  const e = envText(t);
  const out = [];
  for (const [key, re] of Object.entries(ENV_PATTERNS)) {
    if (re.test(e)) out.push(key);
  }
  if (tempC != null && tempC >= 70 && !out.includes("hot")) out.push("hot");
  if (tempC != null && tempC <= -10 && !out.includes("cold")) out.push("cold");
  return out;
}

/** Parse ONE lower-cased message. */
function extractRequirements(t) {
  const rated = detectRatedSn(t);
  const tt = rated ? t.replace(rated.text, " ") : t; // "Sn 8 mm" is not the working gap
  const beltInfo = detectBelt(tt);
  const partSize = detectPartSize(tt);
  const gap = detectGap(tt, partSize);
  const tempC = detectTempC(tt);
  return {
    target: detectTarget(beltInfo.stripped),
    belt: beltInfo.belt,
    beltWord: beltInfo.word,
    gapMm: gap.value,
    gapKind: gap.kind,
    ratedSn: rated ? rated.value : null,
    partSize: partSize ? partSize.label : null,
    voltage: detectVoltage(tt),
    ip: detectIp(tt),
    output: detectOutput(tt),
    mounting: detectMounting(tt),
    bodySize: detectBodySize(tt),
    mountEnv: detectMountEnv(tt),
    speed: detectSpeed(tt),
    partsPerSecond: detectPartsPerSecond(tt),
    tempC,
    env: detectEnv(tt, tempC),
    dustKnown: RE_DUST_KNOWN.test(tt),
    safety: RE_SAFETY.test(tt),
  };
}

function hasAnyParam(r) {
  return Boolean(
    r.target ||
      r.gapMm != null ||
      r.ratedSn != null ||
      r.voltage ||
      r.env.length ||
      r.output ||
      r.mounting ||
      r.belt ||
      r.partSize ||
      r.speed ||
      r.partsPerSecond != null ||
      r.ip ||
      r.bodySize ||
      r.mountEnv
  );
}

const OVERRIDE_KEYS = [
  "target",
  "belt",
  "beltWord",
  "ratedSn",
  "partSize",
  "voltage",
  "ip",
  "output",
  "mounting",
  "bodySize",
  "mountEnv",
  "speed",
  "partsPerSecond",
  "tempC",
];

/** Later messages override earlier ones; environments accumulate. */
function mergeRequirements(base, next) {
  const out = { ...base };
  for (const k of OVERRIDE_KEYS) {
    if (next[k] != null) out[k] = next[k];
  }
  // A generic "metal" never downgrades a specific metal given earlier.
  if (next.target === "metal" && METAL_TARGETS.has(base.target) && base.target !== "metal") {
    out.target = base.target;
  }
  // A lone mm figure in a follow-up (often the part size) never overrides a stated gap.
  if (next.gapMm != null && (base.gapMm == null || next.gapKind !== "lone")) {
    out.gapMm = next.gapMm;
    out.gapKind = next.gapKind;
  }
  out.env = [...new Set([...(base.env || []), ...(next.env || [])])];
  out.dustKnown = Boolean(base.dustKnown || next.dustKnown);
  out.safety = Boolean(base.safety || next.safety);
  return out;
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

/** Reliable working gap (mm) for a rated Sn, per material. */
export function maxGapFor(sn) {
  return {
    ferrous: round1(sn * OPERATING_FRACTION * REDUCTION.ferrous),
    stainless: round1(sn * OPERATING_FRACTION * REDUCTION.stainless),
    nonFerrous: round1(sn * OPERATING_FRACTION * REDUCTION.nonFerrous),
  };
}

const METAL_TARGETS = new Set(["ferrous", "stainless", "nonFerrous", "mixed", "metal"]);

function baseMaterialKey(target) {
  if (target === "nonFerrous" || target === "mixed") return "nonFerrous";
  if (target === "stainless") return "stainless";
  return "ferrous"; // ferrous, or generic "metal" (steel assumed until confirmed)
}

const MATERIAL_NAMES = {
  ferrous: "steel",
  stainless: "stainless steel",
  nonFerrous: "non-ferrous metal (aluminium/brass/copper)",
};

// ---------------------------------------------------------------------------
// 5. Sensing plans (what Claude is told)
// ---------------------------------------------------------------------------

const SAFETY_NOTE =
  "Detecting people or body parts for protection needs safety-rated devices (e.g. safety light curtains or safety switches certified to IEC 61496 / ISO 13849-1 at the required PL). Standard proximity or photoelectric sensors must not be used as the safety function. Recommend a risk assessment and offer engineering review via websales@creativeautomation.ae.";

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

function supplyNotes(v) {
  const N = [];
  if (!v) return N;
  const label = voltageLabel(v);
  if (v.type === "AC") {
    N.push(
      "AC supply: standard 3-wire DC sensors will not work on it. Use 2-wire AC or universal AC/DC sensors, and check their leakage current against the PLC or relay input they drive."
    );
  } else if (v.type === "AC/DC") {
    N.push(
      "Universal AC/DC (2-wire) sensors suit this supply; check leakage current and minimum load current against the input they drive."
    );
  } else if (v.type == null && v.value >= 90) {
    N.push(
      `${v.value} V was given without AC/DC: that is almost certainly mains AC. Standard 3-wire sensors need 10-30 V DC, so confirm the supply before choosing.`
    );
  } else if (v.value < 10) {
    N.push(`${label} is below the usual 10-30 V DC range of standard sensors: look for a low-voltage version or use a 24 V DC supply.`);
  } else if (v.value > 30) {
    N.push(`${label} is above the usual 10-30 V DC range of standard sensors: look for a wide-range DC version and confirm on the datasheet.`);
  }
  return N;
}

function askSupplyIfAmbiguous(req, ask) {
  const v = req.voltage;
  if (v && v.type == null && v.value >= 90) {
    ask("supplyType", `Is your ${v.value} V supply AC or DC? (Standard 3-wire sensors need 10-30 V DC.)`);
  }
}

function addThroughputFact(plan, req, inductive) {
  const pps = req.partsPerSecond;
  if (pps == null) return;
  plan.numbers.partsPerSecond = pps;
  plan.facts.push(
    `Throughput: about ${pps} parts/s, so the switching frequency must comfortably exceed ${pps} Hz (aim for ${round1(pps * 2)} Hz or more). ` +
      (inductive
        ? "DC inductive sensors are typically rated from about 100 Hz (large bodies) to a few kHz (small bodies), so this is rarely the limit: confirm on the datasheet."
        : "Check the response time / switching frequency on the datasheet.")
  );
}

function gapAssumptions(plan, req) {
  if (req.gapMm == null) return;
  if (req.gapKind === "lone") {
    plan.assumptions.push(`The ${req.gapMm} mm figure was read as the sensor-to-part gap. Ask the customer to correct it if wrong.`);
  } else if (req.gapKind === "sensingRange") {
    plan.assumptions.push(
      `"Sensing range/distance ${req.gapMm} mm" was read as the working gap the customer needs. If it is the rated Sn of an existing sensor, the reliable gap is only about ${round1(req.gapMm * OPERATING_FRACTION)} mm on steel.`
    );
  }
}

function addMountingFacts(plan, req, sn) {
  let mode = null;
  if (req.mounting) mode = req.mounting;
  else if (req.mountEnv === "metal") mode = "flush";
  else if (req.mountEnv === "free") mode = "nonFlush";

  const f = bodiesFor(sn, "flush");
  const n = bodiesFor(sn, "nonFlush");
  plan.numbers.bodies = { flush: f, nonFlush: n, mode };
  const fmt = (a) => (a.length ? a.join(" / ") : "none in standard catalogues");
  const caveat = " (typical catalogue values; they vary by manufacturer: confirm on the datasheet)";

  if (mode === "flush") {
    plan.facts.push(
      `Mounting: flush (shielded) suits mounting in or next to metal but has the shortest range. At Sn ${sn} mm typical bodies: ${fmt(f)}${caveat}.`
    );
  } else if (mode === "nonFlush") {
    plan.facts.push(
      `Mounting: non-flush (unshielded) gives roughly 1.5-2x the range of flush for the same body but needs a metal-free zone around the sensing head. At Sn ${sn} mm typical bodies: ${fmt(n)}${caveat}.`
    );
  } else {
    plan.facts.push(
      `Flush vs non-flush is not decided yet. Flush (shielded) can sit in or next to metal but has the shortest range: at Sn ${sn} mm typical bodies ${fmt(f)}. Non-flush (unshielded) needs a metal-free zone around the head: typical bodies ${fmt(n)}${caveat}.`
    );
  }

  if (req.bodySize) {
    const okF = f.includes(req.bodySize);
    const okN = n.includes(req.bodySize);
    if (!okF && !okN) {
      plan.facts.push(
        `The ${req.bodySize} body the customer mentioned typically does not reach Sn ${sn} mm (flush or non-flush): suggest a larger body or mounting closer to the part.`
      );
    } else if (mode === "flush" && !okF) {
      plan.facts.push(
        `The ${req.bodySize} body typically reaches Sn ${sn} mm only as non-flush, which needs a metal-free zone around the head.`
      );
    }
  }
}

function buildSensingPlan(req) {
  const plan = emptyPlan();
  const gap = req.gapMm;
  const vt = req.voltage?.type ?? null;
  const ask = (key, question) => plan.missing.push({ key, question });

  // ---------- Metal targets -> inductive ----------
  if (METAL_TARGETS.has(req.target)) {
    plan.sensorType =
      vt === "AC"
        ? "Inductive proximity sensor (2-wire AC or universal AC/DC version)"
        : "Inductive proximity sensor (3-wire DC)";
    plan.facts.push(
      "Inductive sensors detect metal only, have no moving parts, and are unaffected by non-conductive dust, dirt and ambient light: the standard choice for metal parts on a conveyor."
    );

    const base = baseMaterialKey(req.target);
    const matName = MATERIAL_NAMES[base];
    const ratedStd = req.ratedSn != null ? nextStandardSn(req.ratedSn) ?? req.ratedSn : null;

    if (gap != null) {
      const byMat = {
        ferrous: requiredSn(gap, "ferrous"),
        stainless: requiredSn(gap, "stainless"),
        nonFerrous: requiredSn(gap, "nonFerrous"),
      };
      const minSn = byMat[base];
      plan.numbers = { gapMm: gap, minSn, byMaterial: byMat, baseMaterial: base };

      if (minSn == null) {
        plan.facts.push(
          `A ${gap} mm working gap on ${matName} needs more than the largest standard inductive range (about 40 mm rated).` +
            (base !== "ferrous" && byMat.ferrous != null
              ? ` A "factor-1" (all-metal) sensor would need about Sn ${byMat.ferrous} mm.`
              : "") +
            " Otherwise mount the sensor closer, or consider photoelectric or ultrasonic sensing."
        );
        ask(
          "gapTooLarge",
          `Can the sensor be mounted closer than ${gap} mm? (That gap is beyond standard inductive sensors for this material.)`
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

        if (ratedStd != null) {
          plan.facts.push(
            ratedStd < minSn
              ? `The customer mentioned Sn ${req.ratedSn} mm, but a ${gap} mm gap on ${matName} needs at least Sn ${minSn} mm: point this out.`
              : `The customer's Sn ${req.ratedSn} mm is enough for a ${gap} mm gap on ${matName}.`
          );
        }

        const sn = ratedStd != null && ratedStd >= minSn ? ratedStd : minSn;
        plan.numbers.searchSn = sn;
        addMountingFacts(plan, req, sn);
        plan.searchQuery = [req.bodySize, "inductive proximity sensor", `${sn} mm`].filter(Boolean).join(" ");
      }
    } else if (ratedStd != null) {
      const mg = maxGapFor(req.ratedSn);
      plan.numbers = { ratedSn: req.ratedSn, minSn: ratedStd, searchSn: ratedStd, maxGap: mg, baseMaterial: base };
      plan.facts.push(
        `Rated Sn ${req.ratedSn} mm gives a reliable working gap of up to about ${mg.ferrous} mm on mild steel, ${mg.stainless} mm on stainless steel and ${mg.nonFerrous} mm on aluminium/brass/copper (80% rule with typical reduction factors).`
      );
      addMountingFacts(plan, req, ratedStd);
      plan.searchQuery = [req.bodySize, "inductive proximity sensor", `${ratedStd} mm`].filter(Boolean).join(" ");
      ask("gap", "What gap (mm) will there be between the sensor face and the part? (This confirms the rated range is enough.)");
    } else {
      plan.searchQuery = [req.bodySize, "inductive proximity sensor"].filter(Boolean).join(" ");
      ask("gap", "What gap (mm) will there be between the sensor face and the part?");
    }

    gapAssumptions(plan, req);
    plan.facts.push(
      "Rated Sn assumes a target at least as large as the sensing face (about 12 mm for M12, 18 mm for M18, 30 mm for M30) and at least 1 mm thick mild steel; smaller or thinner parts reduce the effective range."
    );
    addThroughputFact(plan, req, true);

    plan.envNotes = [...supplyNotes(req.voltage), ...envNotesMetal(req.env)];

    plan.avoid.push(
      "Photoelectric: dust and oil film on the lens cause gradual signal loss and false triggers; shiny or mixed-finish metal also reflects inconsistently."
    );
    plan.avoid.push("Capacitive: reacts to dust build-up and humidity and has no advantage for metal targets.");
    if (gap != null && gap <= 30) {
      plan.avoid.push("Ultrasonic: has a blind zone of typically several cm, so it cannot work at this short range.");
    }

    const n = plan.numbers;
    let snSpec = "Rated sensing distance Sn sized so the working gap is at most ~80% of Sn";
    if (n.searchSn != null && gap != null) {
      snSpec = `Rated sensing distance Sn: at least ${n.minSn} mm (working gap ${gap} mm kept within ~80% of Sn)`;
    } else if (n.searchSn != null && n.maxGap) {
      snSpec = `Rated sensing distance Sn ${n.searchSn} mm (reliable up to about ${n.maxGap.ferrous} mm on steel)`;
    }
    plan.keySpecs.push(
      snSpec,
      "Flush (shielded) vs non-flush (unshielded), based on what surrounds the sensor",
      "Body size: M12 or M18 are typical on conveyors; M30 for longer range",
      vt === "AC"
        ? "Supply: 2-wire AC or universal AC/DC version rated for the actual supply; check leakage current and load current"
        : "Supply 10-30 V DC, 3-wire; output PNP or NPN to match the PLC input; NO or NC as the logic needs",
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

    // Questions, in priority order (the brief shows the first MAX_QUESTIONS).
    if (req.target === "metal")
      ask(
        "material",
        "Are the parts steel/iron, or aluminium/brass/copper? (Non-ferrous metals need roughly 2-3x the rated range.)"
      );
    askSupplyIfAmbiguous(req, ask);
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
    if (!req.speed && req.partsPerSecond == null)
      ask("speed", "What are the belt speed and the spacing between parts? (This sets the switching frequency needed.)");
    if (!req.output)
      ask(
        "output",
        vt === "AC"
          ? "What will the sensor switch (a PLC input or a relay/contactor coil), and at what voltage?"
          : "Does your PLC input expect PNP or NPN, and do you prefer an M12 connector or a cable?"
      );
  }

  // ---------- Non-metal targets -> photoelectric ----------
  else if (req.target === "nonMetal") {
    plan.sensorType = "Photoelectric sensor (diffuse with background suppression, or through-beam / retro-reflective)";
    plan.facts.push(
      "Inductive sensors cannot detect non-metallic objects, so they are not suitable here.",
      "Diffuse (proximity) photoelectric sensors detect the object directly with no reflector, typically from a few cm to about a metre. Background-suppression models ignore the belt behind the object, which matters on conveyors.",
      "Retro-reflective and through-beam types reach further and tolerate dirt better. Use polarised retro-reflective or through-beam for clear, glossy or transparent objects."
    );
    gapAssumptions(plan, req);
    addThroughputFact(plan, req, false);
    plan.avoid.push(
      "Capacitive: can detect non-metals through thin walls at very short range (mm to about 30 mm), but is sensitive to dust and humidity.",
      "Ultrasonic: copes with clear or varied surfaces but has a blind zone of typically several cm and a larger body."
    );
    plan.envNotes = [...supplyNotes(req.voltage), ...envNotesNonMetal(req.env)];
    plan.keySpecs.push(
      "Sensing principle: diffuse with background suppression, or through-beam / retro-reflective",
      gap != null
        ? `Rated sensing range comfortably above the ${gap} mm working distance (dust, and dark or small objects, reduce it)`
        : "Sensing range with margin (excess gain), because dust reduces the signal over time",
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
    ask("objectDetail", "What exactly are the objects (material, colour, clear or glossy?) and roughly how big are they?");
    askSupplyIfAmbiguous(req, ask);
    if (gap == null) ask("gap", "At what distance will the sensor sit from the objects?");
    if (!req.speed && req.partsPerSecond == null) ask("speed", "What are the belt speed and the spacing between objects?");
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
    plan.envNotes = [...supplyNotes(req.voltage)];
    if (req.env.includes("hazardous"))
      plan.envNotes.push("Explosive atmosphere: needs ATEX/IECEx-certified sensors. Flag for sales/engineering review.");
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
    askSupplyIfAmbiguous(req, ask);
    if (!req.output) ask("output", "Does your PLC input expect PNP or NPN?");
  }

  if (!req.voltage) plan.assumptions.push("Supply not stated: assuming 24 V DC (the most common).");

  return plan;
}

// ---------------------------------------------------------------------------
// 6. Troubleshooting catalogue (general starting points, not diagnoses)
// ---------------------------------------------------------------------------

const TROUBLE_COMPONENTS = [
  {
    key: "cylinder",
    re: /\b(?:cylinders?|actuators?)\b/,
    label: "pneumatic cylinder",
    causes: [
      "Worn or damaged piston seal (air bypasses inside: weak force, slow or drifting stroke)",
      "Worn rod seal or wiper, or a scored/bent piston rod (air escapes at the rod)",
      "Loose or damaged fittings, tubing or end-cap seals",
      "The valve, not the cylinder, leaking (air blowing continuously from the valve exhaust)",
    ],
    checks: [
      "Lock out machine motion first; with low, safe pressure applied, spray soapy water on the rod, end caps and fittings to find the leak",
      "Pressurise one side at a time: continuous air from the opposite port or the valve exhaust points to the piston seal or the valve",
      "Inspect the rod for scoring, dents or bending, and check alignment/side load on the rod",
    ],
    parts: ["Seal/repair kit for the exact cylinder model", "Fittings and tubing", "Replacement cylinder (if the rod or barrel is damaged)"],
  },
  {
    key: "valve",
    re: /\b(?:valves?|solenoids?|coils?)\b/,
    label: "solenoid valve",
    causes: [
      "Coil burnt out or wrong coil voltage",
      "Dirt or debris in the spool or seat (poor air filtration)",
      "Supply pressure below the valve's minimum operating pressure (pilot-operated valves)",
      "Worn internal seals causing leakage from the exhaust",
    ],
    checks: [
      "Isolate power and air first",
      "Check the coil voltage rating against the supply and measure coil resistance",
      "Check supply pressure and the filter/regulator condition",
      "Try the manual override: if the valve shifts manually, the fault is electrical",
    ],
    parts: ["Coil", "Valve repair kit or replacement valve", "Filter/regulator"],
  },
  {
    key: "sensor",
    re: /\b(?:sensors?|proximity|prox|photo[- ]?eyes?|photoelectric)\b/,
    label: "sensor",
    causes: [
      "Target outside the reliable range (gap too large, or a smaller or non-ferrous target)",
      "Loose bracket or vibration changing the gap",
      "Debris or metal build-up on the sensing face (or a dirty lens on photoelectric sensors)",
      "Wiring: PNP/NPN mismatch, a damaged cable, or electrical noise from nearby motor cables",
      "Supply voltage out of range",
    ],
    checks: [
      "Watch the sensor LED as the part passes, to separate sensor faults from PLC or wiring faults",
      "Measure the actual gap and compare it with ~80% of the rated range",
      "Clean the sensing face or lens and check the bracket",
      "Check the supply voltage and route the cable away from power cables",
    ],
    parts: ["Replacement sensor (same type, range and output)", "Connector cable", "Mounting bracket"],
  },
  {
    key: "drive",
    re: /\b(?:vfds?|inverters?|drives?)\b/,
    label: "variable frequency drive (VFD)",
    causes: [
      "Overcurrent: acceleration too fast, mechanical overload, or a motor/cable fault",
      "Overvoltage: deceleration too fast on a high-inertia load (may need a braking resistor)",
      "Overheating: blocked fans or filters, or high ambient temperature in the panel",
      "Incorrect parameters (motor data, current limit)",
    ],
    checks: [
      "Note the exact fault code and look it up in the drive manual",
      "Isolate power and wait for the DC bus to discharge before opening the drive",
      "Check fans, filters and panel ventilation",
      "Check the motor and cable insulation",
    ],
    parts: ["Braking resistor", "Cooling fan or panel filter", "Replacement drive of the correct rating"],
  },
  {
    key: "motor",
    re: /\bmotors?\b/,
    label: "electric motor",
    causes: [
      "Mechanical overload or a jammed load",
      "Worn bearings (noise, vibration, heat)",
      "Supply problem: a missing phase or voltage imbalance",
      "Blocked cooling (dirty fins or a damaged fan)",
    ],
    checks: [
      "Isolate and lock out power first",
      "Measure the supply voltage on all phases and the running current against the nameplate",
      "Turn the shaft by hand (power off) to feel for bearing roughness",
      "Check the overload relay setting against the nameplate current",
    ],
    parts: ["Bearings", "Overload relay or motor protection breaker", "Replacement motor"],
  },
  {
    key: "protection",
    re: /\b(?:mcbs?|mccbs?|rcds?|rccbs?|elcbs?|breakers?|contactors?|overload\s+relays?)\b/,
    label: "circuit breaker / contactor",
    causes: [
      "A genuine overload or short circuit downstream",
      "Earth leakage (RCD/RCCB tripping) from damaged insulation or moisture",
      "Breaker rating or trip curve too low for the load's inrush current",
      "Loose terminals causing heating",
    ],
    checks: [
      "Isolate and lock out before inspecting",
      "Measure the load current against the breaker rating",
      "Have a qualified electrician insulation-test the circuit",
      "Check terminals for discolouration",
    ],
    parts: ["Breaker with the correct rating and trip curve", "Contactor or overload relay", "Terminals"],
  },
];

function detectTroubleComponent(t) {
  const c = TROUBLE_COMPONENTS.find((x) => x.re.test(t));
  if (!c) return null;
  const { re, ...rest } = c;
  return rest;
}

// ---------------------------------------------------------------------------
// 7. Public API
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
    if (req.gapMm != null) {
      const note =
        req.gapKind === "lone"
          ? " (assumed: the only mm figure given)"
          : req.gapKind === "sensingRange"
            ? ' (customer wrote "sensing range/distance": read as the gap)'
            : "";
      L.push(`Working gap: ${req.gapMm} mm${note}`);
    }
    if (req.ratedSn != null) L.push(`Rated Sn mentioned: ${req.ratedSn} mm`);
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
  if (req.safety) L.push("Mentions people/operators or guarding: personnel safety may be involved");
  return L;
}

/**
 * Follow-up support: if this message is not an enquiry by itself but answers one asked in the
 * last few user turns, return the message segments (original enquiry ... current message).
 * A lookup or order question in between ends the thread.
 */
function findAdvisoryContext(current, history) {
  if (!Array.isArray(history) || history.length === 0) return null;
  const cur = lc(current);
  if (RE_LOOKUP_OPENER.test(cur) || RE_COMMERCE.test(cur)) return null;
  if (cur.split(" ").length > MAX_FOLLOWUP_WORDS) return null;
  if (!hasAnyParam(extractRequirements(cur))) return null;

  const curClean = cleanText(current);
  let users = history
    .filter((m) => m && m.role === "user")
    .map((m) => cleanText(textOf(m)))
    .filter(Boolean);

  // history normally already contains the current turn as its last user message: drop it.
  if (users.length && users[users.length - 1].includes(curClean)) users = users.slice(0, -1);

  const recent = users.slice(-MAX_LOOKBACK_TURNS);
  for (let i = recent.length - 1; i >= 0; i--) {
    const c = classify(recent[i]);
    if (c.intent) return { cls: c, segments: [...recent.slice(i), curClean] };
    const u = lc(recent[i]);
    if (RE_LOOKUP_OPENER.test(u) || RE_COMMERCE.test(u)) return null; // topic changed
  }
  return null;
}

function analyzeEnquiryUnsafe(userMessage, history, opts) {
  const current = cleanText(userMessage);
  if (!current || opts.hasSku) return null;

  let segments = [current];
  let cls = classify(current);
  let continuation = false;

  if (!cls.intent) {
    const ctx = findAdvisoryContext(current, history);
    if (!ctx) return null;
    cls = ctx.cls;
    segments = ctx.segments;
    continuation = true;
  }

  const t = lc(segments.join(" "));
  const req = segments.map((s) => extractRequirements(lc(s))).reduce((acc, r) => mergeRequirements(acc, r));
  const sensing = cls.intent === "selection" && isSensing(t);
  const domain = sensing ? "sensing" : cls.intent === "troubleshooting" ? "troubleshooting" : "generic";
  const plan = sensing ? buildSensingPlan(req) : emptyPlan();
  const trouble = cls.intent === "troubleshooting" ? detectTroubleComponent(t) : null;
  const rewriteSearch = opts.rewriteSearch !== false;

  return {
    version: ADVISORY_VERSION,
    intent: cls.intent,
    score: cls.score,
    domain,
    continuation,
    requirements: req,
    requirementLines: describeRequirements(req, sensing),
    plan,
    trouble,
    questions: plan.missing.slice(0, MAX_QUESTIONS),
    searchQuery: rewriteSearch ? plan.searchQuery : null,
    // true = no product query fits yet (troubleshooting, unknown target, gap beyond inductive)
    skipPreSearch: cls.intent === "troubleshooting" || (sensing && !plan.searchQuery),
  };
}

/**
 * Analyse a chat message.
 *
 * @param {string} userMessage  raw text of the current message
 * @param {Array}  history      conversation messages ({role, content}); may include the current turn
 * @param {{hasSku?: boolean, rewriteSearch?: boolean}} opts
 * @returns {null | object}  null = not an advisory enquiry: run the normal pipeline untouched.
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
// 8. Brief builder
// ---------------------------------------------------------------------------

export function buildAdvisoryBrief(a) {
  if (!a) return "";
  const L = [];
  const p = a.plan || emptyPlan();
  const req = a.requirements || {};
  const isTrouble = a.intent === "troubleshooting";
  const isSensing = a.domain === "sensing";
  const bullets = (arr) => arr.forEach((x) => L.push(`- ${x}`));

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

  if (a.requirementLines?.length) {
    L.push("WHAT THE CUSTOMER TOLD US");
    bullets(a.requirementLines);
    L.push("");
  }
  if (p.assumptions.length) {
    L.push("ASSUMPTIONS (state them plainly in one line)");
    bullets(p.assumptions);
    L.push("");
  }
  if (req.safety) {
    L.push("SAFETY (say this clearly if the sensor is meant to protect people)");
    L.push(`- ${SAFETY_NOTE}`);
    L.push("");
  }

  if (isSensing) {
    L.push(`RECOMMENDED SENSOR TYPE: ${p.sensorType}`);
    L.push("");
    L.push("ENGINEERING FACTS (pre-computed: use these numbers exactly, do not recompute or contradict them)");
    bullets(p.facts);
    L.push("");
    if (p.envNotes.length) {
      L.push("ENVIRONMENT & SUPPLY NOTES");
      bullets(p.envNotes);
      L.push("");
    }
    if (p.avoid.length) {
      L.push("ALTERNATIVES TO AVOID / WHY");
      bullets(p.avoid);
      L.push("");
    }
    L.push("KEY SPECS TO COVER (pick the 5-6 that matter most, with concrete values)");
    bullets(p.keySpecs);
    L.push("");
    L.push("CHECK BEFORE BUYING (pick the 4-5 most relevant)");
    bullets(p.checks);
    L.push("");
    const qs = a.questions || p.missing.slice(0, MAX_QUESTIONS);
    if (qs.length) {
      L.push("STILL UNKNOWN (ask at most these, in this order)");
      qs.forEach((q, i) => L.push(`${i + 1}. ${q.question}`));
    } else {
      L.push("STILL UNKNOWN: nothing critical. Do not invent questions.");
    }
    L.push("");
  } else if (isTrouble) {
    const tc = a.trouble;
    if (tc) {
      L.push(`TYPICAL CAUSES (${tc.label}) - general starting points: order them by what the customer described; this is not a diagnosis`);
      bullets(tc.causes);
      L.push("");
      L.push("SAFE CHECKS");
      bullets(tc.checks);
      L.push("");
      L.push("PART TYPES THAT MAY BE NEEDED (types only, no model numbers)");
      bullets(tc.parts);
      L.push("");
    }
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
  L.push('REPLY FORMAT (the chat only renders **bold**, links and line breaks: no headers, tables or markdown lists; start bullets with "• ")');
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
    L.push(
      `2. **Recommended ${isSensing ? "sensor" : "solution"}:** the type and why it suits their conditions (1-2 sentences)${
        isSensing ? ", plus one line on what to avoid and why" : ""
      }.`
    );
    L.push("3. **Key specs to look for:** 5-6 bullets with concrete values.");
    L.push("4. **Check before buying:** 4-5 bullets, the most relevant ones for this customer.");
    L.push("5. **To confirm:** the open questions as short bullets (skip this line if there are none).");
    L.push(
      "6. Closing line: if product cards were shown, say they are starting points to confirm against the datasheet and that the team can verify a match at websales@creativeautomation.ae; if no cards were shown, offer to search once the open details are confirmed."
    );
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
// 9. Deterministic fallback (used by chat.jsx if Claude fails or returns nothing)
// ---------------------------------------------------------------------------

export function buildAdvisoryFallback(a) {
  if (!a) return "";
  const p = a.plan || emptyPlan();
  const contact = "Please try again in a moment, or email websales@creativeautomation.ae and the team will help.";
  const qs = (a.questions || p.missing.slice(0, MAX_QUESTIONS)).map((q) => `• ${q.question}`);

  if (a.intent === "troubleshooting") {
    const L = ["I couldn't finish my answer just now."];
    if (a.trouble) {
      L.push(`**Common causes (${a.trouble.label}):**\n` + a.trouble.causes.slice(0, 3).map((c) => `• ${c}`).join("\n"));
    }
    L.push("Please isolate power (and air or hydraulic pressure) before checking anything.");
    L.push(contact);
    return L.join("\n\n");
  }

  if (a.domain === "sensing" && p.sensorType && !p.sensorType.startsWith("Depends")) {
    const L = [`**Recommended sensor:** ${p.sensorType}.`];
    const n = p.numbers || {};
    if (n.minSn != null && n.gapMm != null) {
      L.push(`Choose a rated sensing distance (Sn) of at least ${n.minSn} mm so your ${n.gapMm} mm working gap stays within about 80% of Sn.`);
    } else if (n.searchSn != null && n.maxGap) {
      L.push(`A rated Sn of ${n.searchSn} mm is reliable up to about ${n.maxGap.ferrous} mm on steel.`);
    }
    if (a.requirements?.safety) L.push(SAFETY_NOTE);
    if (qs.length) L.push("**To confirm:**\n" + qs.join("\n"));
    L.push(contact);
    return L.join("\n\n");
  }

  const L = ["I couldn't finish my answer just now."];
  if (qs.length) L.push("To recommend the right product, could you tell me:\n" + qs.join("\n"));
  L.push(contact);
  return L.join("\n\n");
}

// ---------------------------------------------------------------------------
// 10. Small helpers for chat.jsx
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
  const r = a.requirements || {};
  const n = a.plan?.numbers || {};
  const gapKind = r.gapKind && r.gapKind !== "explicit" ? `(${r.gapKind})` : "";
  return (
    `[Advisory] v=${a.version} intent=${a.intent} domain=${a.domain} score=${a.score} continuation=${a.continuation}` +
    ` target=${r.target ?? "-"} gap=${r.gapMm ?? "-"}${gapKind} sn=${n.minSn ?? "-"}` +
    ` component=${a.trouble?.key ?? "-"}` +
    ` missing=${a.plan?.missing?.map((m) => m.key).join(",") || "-"}` +
    ` search=${a.searchQuery ? JSON.stringify(a.searchQuery) : "-"} skipPreSearch=${a.skipPreSearch}`
  );
}

/**
 * Optional: append this to the system prompt of "creativeAutomationAssistant" so the
 * "2-3 sentences at most" rule yields to the brief. It is a no-op unless the tag is present.
 */
export const ADVISORY_SYSTEM_PROMPT_ADDENDUM = `ADVISORY MODE
If the user message contains "${ADVISORY_TAG}", the customer is asking for advice (selection guidance or troubleshooting), not a product lookup. For that reply only, the 2-3 sentence limit does not apply: follow the brief's REPLY FORMAT and use its numbers exactly. You must still never list individual products in text and never invent part numbers, prices or stock.`;
