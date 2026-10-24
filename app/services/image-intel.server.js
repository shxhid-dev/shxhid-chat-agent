// app/services/image-intel.server.js — v1.0
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
//   createRateLimiter()   — per-conversation + global caps (vision calls cost more than text)
//
// The image itself is never stored: the DB keeps the marker text, so follow-up turns still
// know what was identified. Env (all optional):
//   IMAGE_UPLOAD=off                kill switch (the widget hides nothing; the API answers 400)
//   IMAGE_INTEL_MODEL               default claude-opus-5-5
//   IMAGE_INTEL_TIMEOUT_MS          default 25000
//   IMAGE_MAX_BYTES                 default 3932160 (3.75 MB decoded = 5 MB base64, the API limit)
//   IMAGE_MAX_PER_CONVERSATION_HOUR default 8
//   IMAGE_MAX_PER_MINUTE            default 30 (all conversations together)

import Anthropic from "@anthropic-ai/sdk";

export const IMAGE_INTEL_VERSION = "1.0.0";
export const PHOTO_NOTE_TAG = "[PHOTO ANALYSIS — NOT FROM USER]";

function intEnv(name, fallback) {
  const n = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const MAX_IMAGE_BYTES = intEnv("IMAGE_MAX_BYTES", 3932160);
const ANALYSIS_TIMEOUT_MS = intEnv("IMAGE_INTEL_TIMEOUT_MS", 25000);
const MAX_PART_NUMBERS = 3;
const MAX_SPECS = 6;

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
    product_type: { type: "string", description: "2-4 word product type, e.g. 'contactor', 'inductive proximity sensor', 'pneumatic cylinder'." },
    key_specs: {
      type: "array",
      items: { type: "string" },
      description: "Ratings printed on the part, e.g. '24 V DC', 'IP67', '32 A', 'M12'.",
    },
    visible_text: { type: "string", description: "Other legible text that helps identify the product, max 200 characters." },
    confidence: { type: "string", enum: ["high", "medium", "low"], description: "How sure you are of brand and part number." },
    notes: { type: "string", description: "Short note for the sales assistant, e.g. 'label partly cut off' or 'photo is blurry'." },
  },
  required: ["is_product_photo", "brand", "part_numbers", "product_type", "key_specs", "visible_text", "confidence", "notes"],
  additionalProperties: false,
};

const ANALYSIS_SYSTEM = `You read photos that customers send to Creative Automation, an industrial automation supplier (sensors, pneumatics, circuit breakers, drives, PLCs, connectors, measurement and test equipment).

Identify the product so the shop can search its catalogue:
- Copy part numbers character by character, exactly as printed (keep dashes, dots, slashes and spaces inside the code). Never complete or guess characters you cannot read; leave a code out rather than invent one.
- Prefer the orderable code (often labelled "Order No.", "Art.-Nr.", "Cat. No.", "Type", "Model", "MLFB", "P/N"). Leave out serial numbers, production dates, batch and certificate numbers.
- Brand: use the printed name or logo. Do not infer a brand from the product's look alone.
- If the photo is not of a product (a person, a room, a screenshot of unrelated content), set is_product_photo to false and leave the other fields empty.`;

let _client;
function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 1 });
  return _client;
}

function cleanString(v, max = 120) {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
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
    partNumbers,
    productType: cleanString(raw.product_type, 60),
    keySpecs: (Array.isArray(raw.key_specs) ? raw.key_specs : []).map((s) => cleanString(s, 40)).filter(Boolean).slice(0, MAX_SPECS),
    visibleText: cleanString(raw.visible_text, 200),
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
        `parts=[${analysis?.partNumbers.join(", ")}] type="${analysis?.productType}" confidence=${analysis?.confidence}`
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

/** Instructions for the main Claude call, placed before the customer's text. */
export function buildPhotoNote(analysis) {
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
  if (analysis.keySpecs.length) lines.push(`ratings on the part: ${analysis.keySpecs.join(", ")}`);
  if (analysis.visibleText) lines.push(`other text: ${analysis.visibleText}`);
  lines.push(`confidence: ${analysis.confidence}${analysis.notes ? ` (${analysis.notes})` : ""}`);
  lines.push(
    analysis.confidence === "low" || !analysis.partNumbers.length
      ? "The reading is uncertain: check it against the photo, tell the customer what you could read, and ask for a sharper photo of the nameplate or the part number as text if it matters. Never invent a part number."
      : "Treat the part number as the customer's request. If the catalogue has no exact match, say so plainly before offering close matches."
  );
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
};
