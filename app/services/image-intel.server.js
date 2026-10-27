// app/services/image-intel.server.js — v1.2
//
// PHOTO SEARCH: the customer attaches a photo of a part or its nameplate; we read the brand,
// part number and product type from it and hand that text to the normal search pipeline
// (smartSearch → SKU path / Algolia), so photo enquiries get the same cards as typed ones.
//
//   parseImagePayload()   — validates the upload (base64, real JPEG/PNG/WebP/GIF bytes, size cap)
//   analyzeProductImage() — one Claude vision call with a JSON schema; never throws, null on failure
//   buildImageSearchText()— analysis → search text ("Siemens 3RT2026-1BB40 contactor")
//   buildPhotoMarker()    — what we store in the DB instead of the image ("[Photo: …]")
//   buildPhotoNote()      — [PHOTO ANALYSIS] note placed in the last user turn for Claude
//   compareProductImages()— one vision call scoring how much each catalogue photo looks like the
//                           customer's photo (visual verification for photo-search.server.js)
//   createRateLimiter()   — per-conversation + global caps (vision calls cost more than text)
//
// The image itself is never stored: the DB keeps the marker text, so follow-up turns still
// know what was identified. Env (all optional):
//   IMAGE_UPLOAD=off                kill switch (the widget hides nothing; the API answers 400)
//   IMAGE_INTEL_MODEL               default claude-opus-5-5
//   IMAGE_INTEL_TIMEOUT_MS          default 25000
//   IMAGE_COMPARE_MODEL             default IMAGE_INTEL_MODEL
//   IMAGE_COMPARE_TIMEOUT_MS        default 25000
//   IMAGE_MAX_BYTES                 default 3932160 (3.75 MB decoded = 5 MB base64, the API limit)
//   IMAGE_MAX_PER_CONVERSATION_HOUR default 8
//   IMAGE_MAX_PER_MINUTE            default 30 (all conversations together)

import Anthropic from "@anthropic-ai/sdk";

export const IMAGE_INTEL_VERSION = "1.2.0";
export const PHOTO_NOTE_TAG = "[PHOTO ANALYSIS — NOT FROM USER]";

function intEnv(name, fallback) {
  const n = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const MAX_IMAGE_BYTES = intEnv("IMAGE_MAX_BYTES", 3932160);
const ANALYSIS_TIMEOUT_MS = intEnv("IMAGE_INTEL_TIMEOUT_MS", 25000);
const COMPARE_TIMEOUT_MS = intEnv("IMAGE_COMPARE_TIMEOUT_MS", 25000);
const MAX_COMPARE = 8;
const MAX_PART_NUMBERS = 3;
const MAX_SPECS = 6;
const MAX_QUERIES = 6;
const MAX_TERMS = 4;

export function isImageUploadEnabled() {
  return String(process.env.IMAGE_UPLOAD || "on").toLowerCase() !== "off";
}

// ─── Upload validation ─────────────────────────────────────────────────

/** Detect the real image type from the first bytes. The browser's claim is not trusted. */
export function sniffImageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.toString("ascii", 0, 4) === "GIF8") return "image/gif";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Accepts { data, media_type } (data may be raw base64 or a data: URL) or a data: URL string.
 * Returns { ok: true, image: { mediaType, data, bytes } } or { ok: false, status, error }.
 */
export function parseImagePayload(raw, { maxBytes = MAX_IMAGE_BYTES } = {}) {
  let data = typeof raw === "string" ? raw : raw?.data;
  if (typeof data !== "string" || !data) return { ok: false, status: 400, error: "Image data is missing" };

  const dataUrl = /^data:([\w/+.-]+);base64,/i.exec(data);
  if (dataUrl) data = data.slice(dataUrl[0].length);
  data = data.replace(/\s+/g, "");

  // Cheap size check before decoding anything.
  const approxBytes = Math.floor((data.length * 3) / 4);
  if (approxBytes > maxBytes) {
    return { ok: false, status: 413, error: `Image is too large (max ${Math.floor(maxBytes / 1048576)} MB)` };
  }
  if (!BASE64_RE.test(data)) return { ok: false, status: 400, error: "Image data is not valid base64" };

  const buf = Buffer.from(data, "base64");
  const mediaType = sniffImageType(buf);
  if (!mediaType) return { ok: false, status: 415, error: "Only JPEG, PNG, WebP or GIF photos are supported" };

  return { ok: true, image: { mediaType, data, bytes: buf.length } };
}

// ─── Rate limiting ─────────────────────────────────────────────────────

/** Sliding-window counter per key. In-memory: one Railway instance, resets on deploy. */
export function createRateLimiter({ max, windowMs, now = () => Date.now() }) {
  const hits = new Map();
  return {
    allow(key) {
      const t = now();
      const recent = (hits.get(key) || []).filter((ts) => t - ts < windowMs);
      if (recent.length >= max) {
        hits.set(key, recent);
        return false;
      }
      recent.push(t);
      hits.set(key, recent);
      if (hits.size > 5000) {
        for (const [k, list] of hits) if (!list.some((ts) => t - ts < windowMs)) hits.delete(k);
      }
      return true;
    },
  };
}

const perConversation = createRateLimiter({ max: intEnv("IMAGE_MAX_PER_CONVERSATION_HOUR", 8), windowMs: 60 * 60 * 1000 });
const globalLimiter = createRateLimiter({ max: intEnv("IMAGE_MAX_PER_MINUTE", 30), windowMs: 60 * 1000 });

/** True if this conversation may send another photo now. */
export function allowImageUpload(conversationId) {
  return perConversation.allow(String(conversationId || "anon")) && globalLimiter.allow("all");
}

// ─── Vision call ───────────────────────────────────────────────────────

const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    is_product_photo: {
      type: "boolean",
      description: "True if the photo shows an industrial product, part, nameplate, label or packaging.",
    },
    brand: { type: "string", description: "Manufacturer as printed or shown by its logo. Empty if not identifiable." },
    part_numbers: {
      type: "array",
      items: { type: "string" },
      description: "Orderable part / order / type numbers exactly as printed, most likely first. No serial numbers, dates, certificate or batch numbers.",
    },
    brand_guess: {
      type: "string",
      description: "If no brand is printed: the manufacturer the design most likely comes from (housing colour, shape, logo style), e.g. 'IFM' for an orange IFM-style housing. Used only to search, never shown as fact. Empty if you have no real idea.",
    },
    product_type: { type: "string", description: "2-4 word product type, e.g. 'contactor', 'inductive proximity sensor', 'pneumatic cylinder'." },
    function: { type: "string", description: "What the part is used for, in catalogue words, e.g. 'valve position feedback on quarter-turn actuators'. Empty if unclear." },
    color: { type: "string", description: "Main housing colour, e.g. 'orange', 'grey'." },
    shape: { type: "string", description: "Body shape, e.g. 'rectangular block', 'cylindrical threaded barrel'." },
    connector: { type: "string", description: "Connection type, e.g. 'M12 connector', 'M8 connector', 'flying cable', 'screw terminals'." },
    mounting: { type: "string", description: "Mounting style, e.g. 'two slotted holes', 'threaded body with nuts', 'DIN rail'." },
    key_specs: {
      type: "array",
      items: { type: "string" },
      description: "Ratings printed on the part, e.g. '24 V DC', 'IP67', '32 A', 'M12'.",
    },
    visible_text: { type: "string", description: "Other legible text that helps identify the product, max 200 characters." },
    search_queries: {
      type: "array",
      items: { type: "string" },
      description: "4-6 catalogue search queries, most specific first, 2-6 words each. Order: brand (or brand_guess) + part number if read; brand or brand_guess + the catalogue product name (e.g. 'IFM dual inductive valve sensor'); the product name alone; type + key visual / connector traits (e.g. 'rectangular inductive sensor M12'); the broad type.",
    },
    distinctive_terms: {
      type: "array",
      items: { type: "string" },
      description: "Up to 4 short designations a correct catalogue product must also show, e.g. 'M23', '17 pin', 'female', '5/2', '32 mm bore'. Only what the photo clearly shows.",
    },
    confidence: { type: "string", enum: ["high", "medium", "low"], description: "How sure you are of brand and part number." },
    notes: { type: "string", description: "Short note for the sales assistant, e.g. 'label partly cut off' or 'photo is blurry'." },
  },
  required: [
    "is_product_photo", "brand", "brand_guess", "part_numbers", "product_type", "function",
    "color", "shape", "connector", "mounting", "key_specs", "visible_text",
    "search_queries", "distinctive_terms", "confidence", "notes",
  ],
  additionalProperties: false,
};

const ANALYSIS_SYSTEM = `You read photos that customers send to Creative Automation, an industrial automation supplier (sensors, pneumatics, circuit breakers, drives, PLCs, connectors, measurement and test equipment).

Identify the product so the shop can search its catalogue:
- Copy part numbers character by character, exactly as printed (keep dashes, dots, slashes and spaces inside the code). Never complete or guess characters you cannot read; leave a code out rather than invent one.
- Prefer the orderable code (often labelled "Order No.", "Art.-Nr.", "Cat. No.", "Type", "Model", "MLFB", "P/N"). Leave out serial numbers, production dates, batch and certificate numbers.
- Brand: use the printed name or logo. Do not infer a brand from the product's look alone.
- brand_guess is different: when nothing is printed, say which manufacturer the design most likely comes from (housing colour, form factor, logo style). It is only used to search the catalogue.
- Never give up on an unlabelled part: describe it the way a catalogue names it (by function, e.g. "dual inductive valve sensor", "quarter-turn valve position sensor"), plus its visual traits (colour, shape, connector, mounting).
- Search queries: write them the way an industrial catalogue titles products (type + size / series designation + key variant), most specific first and a broader one last. Read the designation from the part itself (thread or body size like M8/M12/M23, pin count, port configuration like 5/2, bore and stroke) — when it is clearly visible, even without a label.
- Distinctive terms: the few designations that separate the right product from similar ones (an M12 connector is not an M23 connector). Leave out generic words like "industrial" or "connector".
- If the photo is not of a product (a person, a room, a screenshot of unrelated content), set is_product_photo to false and leave the other fields empty.`;

let _client;
function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 1 });
  return _client;
}

function cleanString(v, max = 120) {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function uniqueStrings(list, { min, max }) {
  const seen = new Set();
  return (Array.isArray(list) ? list : [])
    .map((v) => cleanString(v, max))
    .filter((v) => v.length >= min)
    .filter((v) => {
      const k = v.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

/** Clamp and de-duplicate model output so the rest of the pipeline can trust its shape. */
export function normalizeAnalysis(raw) {
  if (!raw || typeof raw !== "object") return null;
  const seen = new Set();
  const partNumbers = (Array.isArray(raw.part_numbers) ? raw.part_numbers : [])
    .map((p) => cleanString(p, 40))
    .filter((p) => p.length >= 3 && /\d/.test(p) && /[A-Za-z0-9]/.test(p))
    .filter((p) => {
      const k = p.toUpperCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, MAX_PART_NUMBERS);
  const confidence = ["high", "medium", "low"].includes(raw.confidence) ? raw.confidence : "low";
  return {
    isProductPhoto: raw.is_product_photo !== false,
    brand: cleanString(raw.brand, 60),
    brandGuess: cleanString(raw.brand_guess, 40),
    function: cleanString(raw.function, 120),
    color: cleanString(raw.color, 40),
    shape: cleanString(raw.shape, 60),
    connector: cleanString(raw.connector, 60),
    mounting: cleanString(raw.mounting, 60),
    partNumbers,
    productType: cleanString(raw.product_type, 60),
    keySpecs: (Array.isArray(raw.key_specs) ? raw.key_specs : []).map((s) => cleanString(s, 40)).filter(Boolean).slice(0, MAX_SPECS),
    visibleText: cleanString(raw.visible_text, 200),
    searchQueries: uniqueStrings(raw.search_queries, { min: 3, max: 80 }).slice(0, MAX_QUERIES),
    distinctiveTerms: uniqueStrings(raw.distinctive_terms, { min: 1, max: 24 }).slice(0, MAX_TERMS),
    confidence,
    notes: cleanString(raw.notes, 200),
  };
}

/**
 * One vision call. Returns a normalized analysis, or null if the call failed or was refused —
 * the chat then still sends the photo to the main Claude call, which can describe it itself.
 */
export async function analyzeProductImage(image, { caption = "", client = getClient(), timeoutMs = ANALYSIS_TIMEOUT_MS } = {}) {
  if (!image?.data || !image?.mediaType) return null;
  const t0 = Date.now();
  const model = process.env.IMAGE_INTEL_MODEL || "claude-opus-5-5";
  try {
    const response = await client.beta.messages.create(
      {
        model,
        max_tokens: 8000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium", format: { type: "json_schema", schema: ANALYSIS_SCHEMA } },
        system: ANALYSIS_SYSTEM,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } },
              {
                type: "text",
                text: caption
                  ? `The customer wrote with the photo: "${caption.slice(0, 500)}"\nIdentify the product in the photo.`
                  : "Identify the product in the photo.",
              },
            ],
          },
        ],
      },
      { timeout: timeoutMs }
    );

    if (response.stop_reason === "refusal") {
      console.warn(`[ImageIntel] Refused (${response.stop_details?.category || "no category"}) | ${Date.now() - t0}ms`);
      return null;
    }
    if (response.stop_reason === "max_tokens") {
      console.warn(`[ImageIntel] Hit max_tokens | ${Date.now() - t0}ms`);
      return null;
    }
    const text = (response.content || []).filter((b) => b?.type === "text").map((b) => b.text).join("");
    const analysis = normalizeAnalysis(JSON.parse(text));
    console.log(
      `[ImageIntel] ${model} | ${Date.now() - t0}ms | product=${analysis?.isProductPhoto} brand="${analysis?.brand}" ` +
        `parts=[${analysis?.partNumbers.join(", ")}] type="${analysis?.productType}" guess="${analysis?.brandGuess}" ` +
        `function="${analysis?.function}" traits="${[analysis?.color, analysis?.shape, analysis?.connector, analysis?.mounting].filter(Boolean).join(" / ")}" confidence=${analysis?.confidence} ` +
        `queries=${JSON.stringify(analysis?.searchQueries)} terms=${JSON.stringify(analysis?.distinctiveTerms)}`
    );
    return analysis;
  } catch (error) {
    if (error instanceof SyntaxError) {
      console.warn(`[ImageIntel] Response was not valid JSON | ${Date.now() - t0}ms`);
    } else if (error instanceof Anthropic.APIError) {
      console.warn(`[ImageIntel] API error ${error.status ?? "?"}: ${error.message} | ${Date.now() - t0}ms`);
    } else {
      console.warn(`[ImageIntel] Failed: ${error?.message} | ${Date.now() - t0}ms`);
    }
    return null;
  }
}

// ─── Visual verification ───────────────────────────────────────────────

const COMPARE_SCHEMA = {
  type: "object",
  properties: {
    matches: {
      type: "array",
      items: {
        type: "object",
        properties: {
          candidate: { type: "integer", description: "Candidate number as labelled (1-based)." },
          visual_similarity: { type: "integer", description: "0-100: how much the catalogue photo looks like the customer's part (shape, colour, connector, mounting, markings). 100 = same product." },
          same_product_type: { type: "boolean", description: "True if it is the same kind of product." },
          likely_same_product: { type: "boolean", description: "True if it is very likely the exact same model." },
        },
        required: ["candidate", "visual_similarity", "same_product_type", "likely_same_product"],
        additionalProperties: false,
      },
    },
  },
  required: ["matches"],
  additionalProperties: false,
};

const COMPARE_SYSTEM = `You compare a customer's photo of an industrial part with catalogue product photos.
Score each candidate on what you can see: body shape and proportions, colour, connector, mounting holes, markings and labels. Two products of the same type but a different form factor (e.g. rectangular vs cylindrical, M8 vs M12) are not the same product. Score every candidate.`;

/** Smaller Shopify CDN renditions are plenty for comparison and keep the call fast. */
function compareImageUrl(url) {
  try {
    const u = new URL(url);
    if (/(^|\.)shopify\.com$/.test(u.hostname) || u.pathname.includes("/cdn/shop/")) u.searchParams.set("width", "400");
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * candidates: [{ title, imageUrl }] (max 8 used). Returns an array aligned with the candidates that
 * were sent — { visual, sameType, sameProduct } or null per candidate — or null if the call failed.
 */
export async function compareProductImages(image, candidates, { client = getClient(), timeoutMs = COMPARE_TIMEOUT_MS } = {}) {
  const list = (Array.isArray(candidates) ? candidates : []).slice(0, MAX_COMPARE);
  if (!image?.data || !image?.mediaType || !list.some((c) => c?.imageUrl)) return null;
  const t0 = Date.now();
  const model = process.env.IMAGE_COMPARE_MODEL || process.env.IMAGE_INTEL_MODEL || "claude-opus-5-5";
  const content = [
    { type: "text", text: "Customer photo:" },
    { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } },
  ];
  list.forEach((c, i) => {
    content.push({ type: "text", text: `Candidate ${i + 1}: ${String(c.title || "").slice(0, 120)}` });
    if (c.imageUrl) content.push({ type: "image", source: { type: "url", url: compareImageUrl(c.imageUrl) } });
    else content.push({ type: "text", text: "(no photo for this candidate — score it 0)" });
  });
  content.push({ type: "text", text: `Score all ${list.length} candidates against the customer photo.` });

  try {
    const response = await client.beta.messages.create(
      {
        model,
        max_tokens: 4000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low", format: { type: "json_schema", schema: COMPARE_SCHEMA } },
        system: COMPARE_SYSTEM,
        messages: [{ role: "user", content }],
      },
      { timeout: timeoutMs }
    );
    if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") {
      console.warn(`[ImageIntel] compare stopped (${response.stop_reason}) | ${Date.now() - t0}ms`);
      return null;
    }
    const text = (response.content || []).filter((b) => b?.type === "text").map((b) => b.text).join("");
    const parsed = JSON.parse(text);
    const out = list.map(() => null);
    for (const m of Array.isArray(parsed?.matches) ? parsed.matches : []) {
      const i = Number(m?.candidate) - 1;
      if (!Number.isInteger(i) || i < 0 || i >= list.length) continue;
      const visual = Math.max(0, Math.min(100, Math.round(Number(m.visual_similarity) || 0)));
      out[i] = { visual, sameType: m.same_product_type !== false, sameProduct: m.likely_same_product === true };
    }
    console.log(
      `[ImageIntel] compare ${model} | ${Date.now() - t0}ms | ` +
        list.map((c, i) => `${String(c.title || "").slice(0, 28)}=${out[i]?.visual ?? "?"}`).join(", ")
    );
    return out;
  } catch (error) {
    console.warn(`[ImageIntel] compare failed: ${error?.message} | ${Date.now() - t0}ms`);
    return null;
  }
}

// ─── Text builders (pure) ──────────────────────────────────────────────

/** Search text for smartSearch. A part number goes first so the router's SKU path picks it up. */
export function buildImageSearchText(analysis) {
  if (!analysis || !analysis.isProductPhoto) return "";
  if (analysis.partNumbers.length) {
    return [analysis.brand, analysis.partNumbers[0], analysis.productType].filter(Boolean).join(" ");
  }
  return [analysis.brand, analysis.productType].filter(Boolean).join(" ");
}

/**
 * Stored in the DB (and shown in history) instead of the image, e.g.
 * "[Photo: Siemens · 3RT2026-1BB40 · contactor]". "]" is stripped so the marker stays parseable.
 */
export function buildPhotoMarker(analysis) {
  const parts = analysis?.isProductPhoto
    ? [analysis.brand, analysis.partNumbers[0], analysis.productType].filter(Boolean).map((s) => s.replace(/[\[\]]/g, ""))
    : [];
  return parts.length ? `[Photo: ${parts.join(" · ")}]` : "[Photo]";
}

/**
 * Instructions for the main Claude call, placed before the customer's text.
 * `match` is the photo-search result ({ confidence, label, products }) or null if no search ran.
 */
export function buildPhotoNote(analysis, match = null) {
  if (!analysis) {
    return (
      `${PHOTO_NOTE_TAG} The customer attached a photo (shown above). Automatic reading of the photo failed, so look at it yourself. ` +
      `If you can read a brand and part number, search the catalogue with the exact part number. ` +
      `If not, say what you can see and ask for a sharp, well-lit photo of the nameplate or label. Never invent a part number.`
    );
  }
  if (!analysis.isProductPhoto) {
    return (
      `${PHOTO_NOTE_TAG} The customer attached a photo (shown above), but it does not seem to show a product or nameplate. ` +
      `Say briefly what you see and ask for a photo of the part or its label, or the part number as text. Do not search the catalogue for it.`
    );
  }
  const lines = [
    `${PHOTO_NOTE_TAG} The customer attached a photo (shown above). It was read automatically:`,
    `brand: ${analysis.brand || "not readable"}`,
    `part number(s): ${analysis.partNumbers.length ? analysis.partNumbers.join(", ") : "not readable"}`,
    `product type: ${analysis.productType || "unknown"}`,
  ];
  if (analysis.distinctiveTerms.length) lines.push(`identifying designations: ${analysis.distinctiveTerms.join(", ")}`);
  const traits = [analysis.color, analysis.shape, analysis.connector, analysis.mounting].filter(Boolean);
  if (traits.length) lines.push(`appearance: ${traits.join(", ")}`);
  if (analysis.function) lines.push(`likely use: ${analysis.function}`);
  if (analysis.keySpecs.length) lines.push(`ratings on the part: ${analysis.keySpecs.join(", ")}`);
  if (analysis.visibleText) lines.push(`other text: ${analysis.visibleText}`);
  lines.push(`reading confidence: ${analysis.confidence}${analysis.notes ? ` (${analysis.notes})` : ""}`);

  if (match) {
    const top = match.products?.[0];
    const shown = match.products?.length || 0;
    lines.push(
      `catalogue match: ${match.label} — confidence ${match.confidence}` +
        (top ? `; best card: "${top.title}"${top.sku ? ` (part number ${top.sku})` : ""}` : "") +
        `; ${shown} card(s) shown, ranked by how well they fit the photo.`
    );
    if (match.reasons?.length) lines.push(`why: ${match.reasons.join("; ")}`);
    lines.push(
      {
        high: "Say it matches and name the best card with its part number. Mention anything the photo can't confirm only if it matters.",
        medium:
          "Say these are likely matches, name the best one, and ask ONE question that would confirm it (e.g. pin count, size, brand or the part number on the label).",
        low: "Say these are only possible matches, not confirmed. Ask for the part number, a sharp photo of the nameplate, or the key specs.",
        none: shown
          ? "None of the shown cards is a confirmed match; they are only the closest catalogue products. Say what you could identify, say you couldn't confirm a match, name the closest card if it is plausible, and ask ONE question (part number, a nameplate photo, or the key spec that decides it)."
          : "No product in the catalogue fits this photo, and no cards are shown. Say what you could identify, say we don't list a match on the website, and ask for the part number, a nameplate photo or the key specs; offer websales@creativeautomation.ae.",
      }[match.confidence] || ""
    );
  } else {
    lines.push(
      analysis.confidence === "low" || !analysis.partNumbers.length
        ? "The reading is uncertain: check it against the photo, tell the customer what you could read, and ask for a sharper photo of the nameplate or the part number as text if it matters. Never invent a part number."
        : "Treat the part number as the customer's request. If the catalogue has no exact match, say so plainly before offering close matches."
    );
  }
  return lines.join("\n");
}

export default {
  isImageUploadEnabled,
  parseImagePayload,
  sniffImageType,
  allowImageUpload,
  createRateLimiter,
  analyzeProductImage,
  normalizeAnalysis,
  buildImageSearchText,
  buildPhotoMarker,
  buildPhotoNote,
  compareProductImages,
};
