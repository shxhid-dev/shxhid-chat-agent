// app/services/advisory-sizing.server.js — v1.0 (27 Nov 2026)
//
// Two more advisory playbooks next to sensor selection (advisory.server.js):
//   cylinder — pneumatic / hydraulic cylinder sizing from the load, pressure and direction
//   drive    — variable frequency drive selection from motor power, supply and load type
//
// Used only for messages advisory.server.js has already classified as a selection enquiry, so
// plain product lookups ("do you have a 5.5 kW VFD") never reach this file. Pure functions, no
// imports, no network. Plans use the same shape as the sensing plan.

const G = 9.81;

// ─── Shared ─────────────────────────────────────────────────────────────

function emptyPlan() {
  return {
    sensorType: null,
    recommendation: null,
    facts: [],
    envNotes: [],
    avoid: [],
    keySpecs: [],
    checks: [],
    missing: [],
    assumptions: [],
    inputs: [],
    searchQuery: null,
    numbers: {},
  };
}

function num(m, i = 1) {
  return m ? parseFloat(String(m[i]).replace(",", ".")) : null;
}

function fmt(n, digits = 0) {
  if (n == null || !Number.isFinite(n)) return "?";
  const f = Math.pow(10, digits);
  return String(Math.round(n * f) / f);
}

// ─── Domain detection ───────────────────────────────────────────────────

const RE_CYLINDER = /\b(?:cylinders?|linear\s+actuators?)\b/;
const RE_VFD =
  /\b(?:vfds?|vsds?|inverters?|variable\s+(?:frequency|speed)\s+drives?|frequency\s+(?:converters?|inverters?|drives?)|ac\s+drives?|motor\s+drives?)\b/;
const RE_NOT_MOTOR_INVERTER = /\b(?:solar|pv|photovoltaic|ups|battery|batteries|grid[- ]tie|off[- ]grid)\b/;

/** "cylinder" | "drive" | null for a lower-cased selection enquiry. */
export function detectSizingDomain(t) {
  const s = String(t || "");
  if (RE_VFD.test(s) && !RE_NOT_MOTOR_INVERTER.test(s)) return "drive";
  if (RE_CYLINDER.test(s) && !/\b(?:gas\s+cylinders?|oxygen|lpg|cylinder\s+head|lock\s+cylinders?)\b/.test(s)) return "cylinder";
  return null;
}

/** True if a follow-up message carries a sizing detail ("6 bar", "50 kg", "3 phase", "7.5 kW"). */
export function hasSizingParam(t) {
  const s = String(t || "");
  return (
    RE_FORCE.test(s) || RE_MASS.test(s) || RE_PRESSURE.test(s) || RE_STROKE_A.test(s) || RE_STROKE_B.test(s) ||
    RE_KW.test(s) || RE_HP.test(s) || RE_PHASE_1.test(s) || RE_PHASE_3.test(s)
  );
}

// ─── Cylinder sizing ────────────────────────────────────────────────────

// ISO 6432 (8-25 mm) and ISO 15552 (32-320 mm) bores, with the usual piston-rod diameter.
const ISO_BORES = [8, 10, 12, 16, 20, 25, 32, 40, 50, 63, 80, 100, 125, 160, 200, 250, 320];
const ROD_FOR_BORE = { 8: 4, 10: 4, 12: 6, 16: 6, 20: 8, 25: 10, 32: 12, 40: 16, 50: 20, 63: 20, 80: 25, 100: 25, 125: 32, 160: 40, 200: 40, 250: 50, 320: 63 };
const DEFAULT_PNEUMATIC_BAR = 6;
// Load ratio: share of the theoretical force a cylinder should be asked to deliver.
// Moving loads need margin for friction and acceleration; clamping/holding can use more.
const LOAD_RATIO = { moving: 0.5, static: 0.7 };

const RE_FORCE = /(\d+(?:[.,]\d+)?)\s*(kn|n|newtons?)\b/;
const RE_MASS = /(\d+(?:[.,]\d+)?)\s*(kg|kgs|kilos?|kilograms?|tonnes?|tons?)\b/;
const RE_PRESSURE = /(\d+(?:[.,]\d+)?)\s*(bar|psi|mpa)\b/;
const RE_STROKE_A = /(\d+(?:[.,]\d+)?)\s*mm\s+(?:stroke|travel)\b/;
const RE_STROKE_B = /\b(?:stroke|travel)\s*(?:length\s*)?(?:of|is|=|:|about)?\s*(\d+(?:[.,]\d+)?)\s*mm\b/;

/** Pushing force (N) of a bore (mm) at a pressure (bar). */
export function pushForceN(boreMm, bar) {
  return (bar / 10) * (Math.PI / 4) * boreMm * boreMm;
}

/** Pulling force (N): the rod takes away part of the piston area. */
export function pullForceN(boreMm, bar) {
  const rod = ROD_FOR_BORE[boreMm] ?? boreMm * 0.3;
  return (bar / 10) * (Math.PI / 4) * (boreMm * boreMm - rod * rod);
}

/** Smallest standard bore whose force (push or pull) reaches requiredN, or null if none does. */
export function standardBoreFor(requiredN, bar, { pull = false } = {}) {
  for (const b of ISO_BORES) {
    const f = pull ? pullForceN(b, bar) : pushForceN(b, bar);
    if (f >= requiredN) return b;
  }
  return null;
}

function readCylinder(t) {
  const force = RE_FORCE.exec(t);
  const mass = RE_MASS.exec(t);
  const pressure = RE_PRESSURE.exec(t);
  const stroke = RE_STROKE_A.exec(t) || RE_STROKE_B.exec(t);

  let loadN = null;
  let loadText = null;
  if (force) {
    loadN = num(force) * (/^kn$/.test(force[2]) ? 1000 : 1);
    loadText = `${fmt(loadN)} N`;
  } else if (mass) {
    const kg = num(mass) * (/^(?:tonnes?|tons?)$/.test(mass[2]) ? 1000 : 1);
    loadN = kg * G;
    loadText = `${fmt(kg, 1)} kg (≈ ${fmt(loadN)} N)`;
  }

  let bar = null;
  if (pressure) {
    const v = num(pressure);
    bar = pressure[2] === "psi" ? v * 0.0689476 : pressure[2] === "mpa" ? v * 10 : v;
  }

  return {
    loadN,
    loadText,
    bar,
    strokeMm: stroke ? Math.round(num(stroke)) : null,
    hydraulic: /\bhydraulic\b/.test(t),
    singleActing: /\b(?:single[- ]acting|spring[- ]return)\b/.test(t),
    pull: /\b(?:pull(?:s|ing)?|retract(?:s|ing|ion)?\s+(?:force|load)|on\s+the\s+return(?:\s+stroke)?)\b/.test(t),
    lifting: /\b(?:lift(?:s|ing)?|rais(?:e|es|ing)|vertical(?:ly)?|hoist(?:s|ing)?)\b/.test(t),
    holding: /\b(?:clamp(?:s|ing)?|hold(?:s|ing)?|press(?:es|ing)?|grip(?:s|ping)?)\b/.test(t),
  };
}

export function buildCylinderPlan(t) {
  const plan = emptyPlan();
  const ask = (key, question) => plan.missing.push({ key, question });
  const c = readCylinder(String(t || ""));
  const kind = c.hydraulic ? "hydraulic" : "pneumatic";
  const acting = c.singleActing ? "single-acting (spring return)" : "double-acting";

  if (c.loadText) plan.inputs.push(`Load: ${c.loadText}${c.lifting ? ", lifted vertically" : ""}${c.holding ? ", clamped/held" : ""}`);
  if (c.bar != null) plan.inputs.push(`Supply pressure: ${fmt(c.bar, 1)} bar`);
  if (c.strokeMm != null) plan.inputs.push(`Stroke: ${c.strokeMm} mm`);
  if (c.pull) plan.inputs.push("The force is needed on the pull (retract) stroke");

  let bar = c.bar;
  if (bar == null && !c.hydraulic) {
    bar = DEFAULT_PNEUMATIC_BAR;
    plan.assumptions.push(`Supply pressure not given: ${DEFAULT_PNEUMATIC_BAR} bar assumed (typical factory air). Lower pressure needs a bigger bore.`);
  }

  plan.recommendation = `${acting[0].toUpperCase()}${acting.slice(1)} ${kind} cylinder`;
  plan.numbers = { loadN: c.loadN, pressureBar: bar, strokeMm: c.strokeMm };

  if (c.loadN == null) {
    ask("load", "What load must the cylinder move or hold (kg or N), and is it lifted vertically or moved horizontally?");
  }
  if (bar == null) {
    ask("pressure", "What hydraulic working pressure (bar) is available?");
  }

  if (c.loadN != null && bar != null) {
    if (c.loadText && !c.lifting && !RE_FORCE.test(String(t || ""))) {
      plan.assumptions.push("Horizontal move: the full weight is used as the force (conservative; sliding or rolling friction is usually much lower).");
    }
    const ratio = c.holding && !c.lifting ? LOAD_RATIO.static : LOAD_RATIO.moving;
    const requiredN = c.loadN / ratio;
    const minBore = Math.sqrt((4 * requiredN) / (Math.PI * (bar / 10)));
    const bore = standardBoreFor(requiredN, bar, { pull: c.pull });
    plan.numbers = { ...plan.numbers, requiredN: Math.round(requiredN), minBoreMm: Math.round(minBore * 10) / 10, boreMm: bore };

    plan.facts.push(
      `Force to design for: ${fmt(c.loadN)} N load ÷ load ratio ${ratio} = ${fmt(requiredN)} N theoretical force ` +
        `(${ratio === LOAD_RATIO.static ? "clamping/holding: 70% of the theoretical force" : "moving load: keep it at about 50% to cover friction and acceleration"}).`
    );
    if (bore) {
      const push = pushForceN(bore, bar);
      const pull = pullForceN(bore, bar);
      plan.facts.push(
        `At ${fmt(bar, 1)} bar the piston needs at least ${fmt(minBore, 1)} mm bore${c.pull ? " (pull stroke: the rod area is lost, so the next size may be needed)" : ""} → standard bore ${bore} mm.`
      );
      plan.facts.push(
        `A ${bore} mm bore at ${fmt(bar, 1)} bar gives about ${fmt(push)} N pushing and ${fmt(pull)} N pulling (rod ${ROD_FOR_BORE[bore]} mm).`
      );
      if (c.singleActing) {
        plan.facts.push("Single-acting: the return spring takes part of the pushing force, so check the datasheet force at full stroke; it may need the next bore up.");
      }
      plan.recommendation = `${plan.recommendation}, ${bore} mm bore${c.strokeMm ? `, ${c.strokeMm} mm stroke` : ""}`;
      plan.searchQuery = `${kind} cylinder ${bore} mm bore${c.strokeMm ? ` ${c.strokeMm} mm stroke` : ""}`;
    } else {
      plan.facts.push(
        `No standard bore up to 320 mm reaches ${fmt(requiredN)} N at ${fmt(bar, 1)} bar. Options: higher pressure, two cylinders sharing the load, a mechanical advantage (lever), or ${c.hydraulic ? "a larger hydraulic cylinder" : "a hydraulic cylinder"}.`
      );
    }
  }

  if (c.strokeMm == null) ask("stroke", "What stroke (travel distance, mm) do you need?");
  ask("mounting", "How will it be mounted (foot, front/rear flange, rear clevis/pivot, trunnion), and is there any side load on the rod?");

  plan.keySpecs.push(
    "Bore and stroke (bore from the force calculation above; stroke to the travel needed)",
    c.hydraulic ? "Rated working pressure of the cylinder and seals (above the system pressure)" : "Operating pressure range (typically 1-10 bar)",
    "Standard: ISO 6432 round body for 8-25 mm bores, ISO 15552 profile/tie-rod for 32-320 mm (interchangeable between brands)",
    "Mounting style and rod-end thread / accessory (clevis, rod eye, floating joint)",
    "Cushioning: adjustable end cushioning for fast or heavy loads",
    "Magnetic piston if position sensors (reed or magneto-resistive) are needed",
    "Port size (larger bores need larger ports and valve flow for speed)"
  );
  plan.checks.push(
    "Side load: cylinders take axial load only; use a guided cylinder or external guides if the load is offset or slides",
    "Long push strokes: check the rod buckling limit on the datasheet for the stroke and load",
    "Speed: the valve, tubing and fittings must flow enough air; cushioning or shock absorbers for fast heavy loads",
    "Lifting: what happens on air loss (use a lock/brake or a pilot-operated check valve so the load cannot drop)",
    "Air quality: filtered and dry supply; lubrication per the manufacturer"
  );
  if (c.lifting) {
    plan.avoid.push("Do not rely on the cylinder alone to hold a raised load: on air loss it will drop. Add a rod lock or pilot-operated check valves.");
  }
  return plan;
}

// ─── Drive (VFD) selection ─────────────────────────────────────────────

const KW_SERIES = [0.18, 0.25, 0.37, 0.55, 0.75, 1.1, 1.5, 2.2, 3, 4, 5.5, 7.5, 11, 15, 18.5, 22, 30, 37, 45, 55, 75, 90, 110, 132, 160, 200, 250, 315, 355, 400, 450, 500];

const RE_KW = /(\d+(?:[.,]\d+)?)\s*kw\b/;
const RE_HP = /(\d+(?:[.,]\d+)?)\s*(?:hp|horse\s*power)\b/;
const RE_PHASE_1 = /\b(?:single[- ]?phase|1[- ]?ph(?:ase)?|one[- ]phase|1\s*~)\b/;
const RE_PHASE_3 = /\b(?:three[- ]?phase|3[- ]?ph(?:ase)?|3\s*~)\b/;
const RE_VOLT = /(\d{3})\s*v(?:ac)?\b/;
const RE_FLC = /(\d+(?:[.,]\d+)?)\s*(?:amps?|a)\b/;
const RE_VARIABLE_TORQUE = /\b(?:pumps?|pumping|fans?|blowers?|ventilat\w*|hvac|cooling\s+towers?|exhaust)\b/;
const RE_CONSTANT_TORQUE = /\b(?:conveyors?|mixers?|agitators?|crushers?|compressors?|extruders?|grinders?|mills?|presses?|positive\s+displacement|screw\s+pumps?|hoists?|cranes?|lifts?|elevators?|winch(?:es)?)\b/;
const RE_LIFTING = /\b(?:hoists?|cranes?|lifts?|elevators?|winch(?:es)?)\b/;

/** Smallest standard drive size (kW) at or above the motor power. */
export function nextDriveKw(kw) {
  return KW_SERIES.find((s) => s >= kw - 1e-9) ?? null;
}

function readDrive(t) {
  const kw = RE_KW.exec(t);
  const hp = RE_HP.exec(t);
  const volt = RE_VOLT.exec(t);
  const flc = RE_FLC.exec(t);
  const motorKw = kw ? num(kw) : hp ? num(hp) * 0.746 : null;
  const v = volt ? parseInt(volt[1], 10) : null;
  let phase = RE_PHASE_1.test(t) ? 1 : RE_PHASE_3.test(t) ? 3 : null;
  if (phase == null && v != null && v >= 380 && v <= 690) phase = 3; // 380-690 V supplies are three-phase
  const duty = RE_CONSTANT_TORQUE.test(t) ? "heavy" : RE_VARIABLE_TORQUE.test(t) ? "normal" : null;
  return {
    motorKw,
    fromHp: !kw && !!hp,
    hp: hp ? num(hp) : null,
    volts: v,
    phase,
    flcA: flc ? num(flc) : null,
    duty,
    lifting: RE_LIFTING.test(t),
    application: (RE_CONSTANT_TORQUE.exec(t) || RE_VARIABLE_TORQUE.exec(t) || [])[0] || null,
  };
}

export function buildDrivePlan(t, req = {}) {
  const plan = emptyPlan();
  const ask = (key, question) => plan.missing.push({ key, question });
  const d = readDrive(String(t || ""));

  if (d.motorKw != null) plan.inputs.push(`Motor: ${d.fromHp ? `${fmt(d.hp, 1)} hp (≈ ${fmt(d.motorKw, 2)} kW)` : `${fmt(d.motorKw, 2)} kW`}`);
  if (d.phase || d.volts) plan.inputs.push(`Supply: ${d.phase ? `${d.phase === 1 ? "single" : "three"}-phase` : ""}${d.phase && d.volts ? " " : ""}${d.volts ? `${d.volts} V` : ""}`);
  if (d.application) plan.inputs.push(`Application: ${d.application}`);
  if (d.flcA != null) plan.inputs.push(`Motor current: ${fmt(d.flcA, 1)} A`);

  const size = d.motorKw != null ? nextDriveKw(d.motorKw) : null;
  plan.numbers = { motorKw: d.motorKw != null ? Math.round(d.motorKw * 100) / 100 : null, driveKw: size, phase: d.phase, duty: d.duty };

  const dutyLabel = d.duty === "heavy" ? "heavy-duty (constant torque) rating" : d.duty === "normal" ? "normal-duty (variable torque) rating" : "rating";
  // Single-phase input drives stop at about 2.2-3 kW: above that the recommendation says so.
  const singlePhaseTooBig = d.phase === 1 && d.motorKw != null && d.motorKw > 2.2 + 1e-9;
  const phaseLabel = singlePhaseTooBig
    ? ""
    : d.phase === 1
      ? "Single-phase input"
      : d.phase === 3
        ? `Three-phase ${d.volts && d.volts < 300 ? "230 V class" : "400 V class"}`
        : "";
  plan.recommendation =
    `${phaseLabel ? `${phaseLabel} ` : ""}variable frequency drive${size ? `, ${dutyLabel} of at least ${size} kW` : ""}`.replace(/^v/, "V") +
    (singlePhaseTooBig ? " (needs a three-phase supply, or a derated three-phase drive on single phase)" : "");

  if (d.motorKw == null) {
    ask("power", "What is the motor power (kW or hp) and the full-load current on its nameplate?");
  } else {
    plan.facts.push(
      d.fromHp
        ? `${fmt(d.hp, 1)} hp ≈ ${fmt(d.motorKw, 2)} kW → next standard drive size ${size} kW.`
        : `Motor ${fmt(d.motorKw, 2)} kW → standard drive size ${size} kW${size !== d.motorKw ? " (next size up)" : ""}.`
    );
    plan.facts.push("Size on current, not only kW: the drive's rated output current must be at least the motor's nameplate full-load current.");
    const load = d.application ? `A ${d.application.replace(/s$/, "")}` : "This load";
    if (d.duty === "heavy") {
      const up = nextDriveKw(size + 0.01);
      plan.facts.push(
        `${load} is constant torque: use the drive's heavy-duty rating (typically 150% overload for 60 s). If a drive lists only a normal-duty rating, choose one size up (${up} kW).`
      );
    } else if (d.duty === "normal") {
      plan.facts.push(`${load} is variable torque (pump/fan): the normal-duty rating (about 110-120% overload) is enough, and PID control can hold pressure or flow.`);
    }
    if (d.phase === 1) {
      if (d.motorKw <= 2.2 + 1e-9) {
        plan.facts.push("Single-phase 230 V supply: use a 1-phase-in / 3-phase-out 230 V drive. The motor must be connected for 230 V three-phase (delta on a 230/400 V motor).");
      } else {
        plan.facts.push("Single-phase input drives are rarely made above about 2.2-3 kW. Options: a three-phase supply, or a three-phase drive derated on single phase (often to about half) — confirm with the manufacturer.");
      }
    }
    plan.searchQuery = `variable frequency drive ${size} kW`;
  }

  if (d.phase == null) ask("supply", "What is the supply: single-phase 230 V or three-phase 400 V (or other)?");
  if (d.duty == null) ask("load", "What does the motor drive (pump, fan, conveyor, mixer, compressor, hoist…)? Constant-torque loads need a heavy-duty rating.");
  if (d.flcA == null && d.motorKw != null) ask("current", "What full-load current (A) is on the motor nameplate? The drive's output current must cover it.");

  if (d.lifting) {
    plan.avoid.push("Hoists, cranes and lifts need a braking resistor (or regen unit), a drive with hoisting functions and mechanical-brake control. Treat it as a safety application and have it engineered.");
  }
  if ((req.tempC ?? 0) > 40) {
    plan.envNotes.push(`Ambient ${req.tempC} °C: most drives are rated to 40-50 °C; above that they must be derated or cooled. Check the derating curve.`);
  }
  if ((req.env || []).some((e) => ["wet", "dust", "chemical"].includes(e))) {
    plan.envNotes.push("Harsh environment: mount an IP20 drive in a ventilated cabinet, or choose an IP55/IP66 drive for the machine side.");
  }

  plan.keySpecs.push(
    "Rated power (kW) and rated output current (A), heavy-duty vs normal-duty rating",
    "Input: phases and voltage range (1-ph 200-240 V, 3-ph 380-480 V…)",
    "Overload capacity (e.g. 150% for 60 s heavy duty)",
    "Control mode: V/f for pumps and fans, sensorless vector for conveyors and high starting torque",
    "Built-in brake chopper (needed for fast stops and high inertia), EMC filter class (C2 for mixed sites)",
    "I/O and communication (analogue inputs, Modbus RTU/TCP, PROFINET, EtherNet/IP)",
    "Enclosure: IP20 for cabinets, IP55/IP66 for wall or machine mounting"
  );
  plan.checks.push(
    "Drive output current ≥ motor nameplate full-load current",
    "Long motor cables (over about 50-100 m): output reactor or dV/dt filter; use shielded motor cable",
    "Older motors: insulation suitable for VFD use (inverter-duty)",
    "Constant torque at low speed: standard motors overheat below about 50% speed; consider forced cooling",
    "Cabinet ventilation, ambient temperature and altitude derating",
    "Harmonics on the supply: AC line reactor or DC choke for larger drives"
  );
  return plan;
}

export default { detectSizingDomain, hasSizingParam, buildCylinderPlan, buildDrivePlan, pushForceN, pullForceN, standardBoreFor, nextDriveKw };
