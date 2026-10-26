import test from "node:test";
import assert from "node:assert/strict";
import {
  parseImagePayload,
  sniffImageType,
  normalizeAnalysis,
  buildImageSearchText,
  buildPhotoMarker,
  buildPhotoNote,
  createRateLimiter,
  analyzeProductImage,
  PHOTO_NOTE_TAG,
} from "../app/services/image-intel.server.js";

// 1x1 images, real bytes.
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0]).toString("base64");

// Same pattern as PHOTO_MARKER_RE in extensions/chat-bubble/assets/chat.js.
const WIDGET_MARKER_RE = /^\[Photo(?::\s*([^\]]*))?\]\s*/;

const NAMEPLATE = {
  is_product_photo: true,
  brand: " Siemens ",
  part_numbers: ["3RT2026-1BB40", "3rt2026-1bb40", "S/N 12", "AB"],
  product_type: "contactor",
  key_specs: ["24 V DC", "AC-3 25 A"],
  visible_text: "SIRIUS",
  confidence: "high",
  notes: "",
};

test("sniffs real image bytes", () => {
  assert.equal(sniffImageType(Buffer.from(PNG_1PX, "base64")), "image/png");
  assert.equal(sniffImageType(Buffer.from(JPEG_HEAD, "base64")), "image/jpeg");
  assert.equal(sniffImageType(Buffer.from("RIFF0000WEBPVP8 ", "ascii")), "image/webp");
  assert.equal(sniffImageType(Buffer.from("not an image at all")), null);
});

test("accepts raw base64 and data URLs, and trusts the bytes over the claimed type", () => {
  const raw = parseImagePayload({ data: PNG_1PX, media_type: "image/jpeg" });
  assert.equal(raw.ok, true);
  assert.equal(raw.image.mediaType, "image/png");
  assert.equal(raw.image.data, PNG_1PX);

  const url = parseImagePayload(`data:image/png;base64,${PNG_1PX}`);
  assert.equal(url.ok, true);
  assert.equal(url.image.data, PNG_1PX);
});

test("rejects missing, oversized, non-base64 and non-image uploads", () => {
  assert.equal(parseImagePayload(null).status, 400);
  assert.equal(parseImagePayload({ data: "" }).status, 400);
  assert.equal(parseImagePayload({ data: "@@@@not-base64@@@@" }).status, 400);
  assert.equal(parseImagePayload({ data: Buffer.from("hello world, plain text").toString("base64") }).status, 415);
  assert.equal(parseImagePayload({ data: PNG_1PX }, { maxBytes: 10 }).status, 413);
});

test("normalizeAnalysis trims, de-duplicates and drops non-codes", () => {
  const a = normalizeAnalysis(NAMEPLATE);
  assert.equal(a.brand, "Siemens");
  assert.deepEqual(a.partNumbers, ["3RT2026-1BB40", "S/N 12"]);
  assert.equal(a.confidence, "high");
  assert.equal(normalizeAnalysis(null), null);
  assert.equal(normalizeAnalysis({ confidence: "certain" }).confidence, "low");
});

test("search text puts the part number in, so the SKU path picks it up", () => {
  assert.equal(buildImageSearchText(normalizeAnalysis(NAMEPLATE)), "Siemens 3RT2026-1BB40 contactor");
  assert.equal(
    buildImageSearchText(normalizeAnalysis({ ...NAMEPLATE, part_numbers: [] })),
    "Siemens contactor"
  );
  assert.equal(buildImageSearchText(normalizeAnalysis({ ...NAMEPLATE, is_product_photo: false })), "");
  assert.equal(buildImageSearchText(null), "");
});

test("photo marker round-trips through the widget's history parser", () => {
  const marker = buildPhotoMarker(normalizeAnalysis(NAMEPLATE));
  assert.equal(marker, "[Photo: Siemens · 3RT2026-1BB40 · contactor]");
  const m = WIDGET_MARKER_RE.exec(`${marker} do you have it in stock?`);
  assert.equal(m[1], "Siemens · 3RT2026-1BB40 · contactor");
  assert.equal(buildPhotoMarker(null), "[Photo]");
  assert.equal(WIDGET_MARKER_RE.exec("[Photo] hi")[1], undefined);
  // A "]" in model output must not break the marker.
  assert.equal(buildPhotoMarker(normalizeAnalysis({ ...NAMEPLATE, brand: "ABB]x" })).split("]").length, 2);
});

test("photo note covers read, unreadable and failed photos", () => {
  const ok = buildPhotoNote(normalizeAnalysis(NAMEPLATE));
  assert.ok(ok.startsWith(PHOTO_NOTE_TAG));
  assert.match(ok, /3RT2026-1BB40/);
  assert.match(ok, /no exact match/i);

  const low = buildPhotoNote(normalizeAnalysis({ ...NAMEPLATE, confidence: "low" }));
  assert.match(low, /sharper photo/);

  assert.match(buildPhotoNote(normalizeAnalysis({ ...NAMEPLATE, is_product_photo: false })), /Do not search/);
  assert.match(buildPhotoNote(null), /failed/);
});

test("rate limiter allows max hits per window, per key", () => {
  let t = 0;
  const limiter = createRateLimiter({ max: 2, windowMs: 1000, now: () => t });
  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("a"), false);
  assert.equal(limiter.allow("b"), true);
  t = 1001;
  assert.equal(limiter.allow("a"), true);
});

function fakeClient(response) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        async create(params, options) {
          calls.push({ params, options });
          if (response instanceof Error) throw response;
          return response;
        },
      },
    },
  };
}

const IMAGE = { data: PNG_1PX, mediaType: "image/png" };

test("analyzeProductImage sends the image with a JSON schema and parses the reply", async () => {
  const client = fakeClient({
    stop_reason: "end_turn",
    content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify(NAMEPLATE) }],
  });
  const a = await analyzeProductImage(IMAGE, { caption: "price?", client });
  assert.deepEqual(a.partNumbers, ["3RT2026-1BB40", "S/N 12"]);

  const { params } = client.calls[0];
  assert.equal(params.messages[0].content[0].type, "image");
  assert.equal(params.messages[0].content[0].source.media_type, "image/png");
  assert.equal(params.output_config.format.type, "json_schema");
  assert.equal(params.fallbacks, "default");
  assert.equal(params.tool_choice, undefined);
  assert.match(params.messages[0].content[1].text, /price\?/);
});

test("analyzeProductImage returns null on refusal, bad JSON or API errors", async () => {
  assert.equal(await analyzeProductImage(IMAGE, { client: fakeClient({ stop_reason: "refusal", content: [] }) }), null);
  assert.equal(
    await analyzeProductImage(IMAGE, { client: fakeClient({ stop_reason: "end_turn", content: [{ type: "text", text: "{oops" }] }) }),
    null
  );
  assert.equal(await analyzeProductImage(IMAGE, { client: fakeClient(new Error("network down")) }), null);
  assert.equal(await analyzeProductImage(null, { client: fakeClient(new Error("unused")) }), null);
});

test("normalizeAnalysis keeps search queries and distinctive terms, de-duplicated and capped", () => {
  const a = normalizeAnalysis({
    ...NAMEPLATE,
    search_queries: ["M23 17 pin female connector", "m23 17 PIN female connector", "M23 connector", "x", "a b", "c d", "e f"],
    distinctive_terms: ["M23", "17 pin", "female", "straight", "IP67", ""],
  });
  assert.deepEqual(a.searchQueries, ["M23 17 pin female connector", "M23 connector", "a b", "c d"]);
  assert.deepEqual(a.distinctiveTerms, ["M23", "17 pin", "female", "straight"]);
  assert.deepEqual(normalizeAnalysis(NAMEPLATE).searchQueries, []);
});

test("photo note reports the catalogue match and asks on low / none", () => {
  const a = normalizeAnalysis({ ...NAMEPLATE, distinctive_terms: ["M23"] });
  const high = buildPhotoNote(a, { confidence: "high", label: "Exact part number match", products: [{ title: "Siemens Contactor", sku: "3RT2026-1BB40" }], reasons: ["the part number on the photo matches the catalogue"] });
  assert.match(high, /catalogue match: Exact part number match — confidence high/);
  assert.match(high, /part number 3RT2026-1BB40/);
  assert.match(high, /identifying designations: M23/);

  assert.match(buildPhotoNote(a, { confidence: "low", label: "Possible matches", products: [{ title: "x" }] }), /only possible matches/);
  const none = buildPhotoNote(a, { confidence: "none", label: "No good match", products: [] });
  assert.match(none, /no cards are shown/);
  assert.match(none, /websales@/);
});
