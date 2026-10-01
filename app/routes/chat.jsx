// app/routes/chat.jsx
/**
 * Chat API Route — v2.6 (1 Oct 2026)
 *
 * CHANGES (v2.6) — from the 30 Sep logs and the router v6 / Algolia v4 release:
 *   1. Relevance filter uses the router's corrected query (smart.effectiveQuery) instead of the raw
 *      customer text. 30 Sep: the typo "switchgare" dropped 10/10 cards.
 *   2. Router-guarded result types (algolia_category / algolia_multi / algolia_relaxed) skip the term
 *      filter. The router already requires the product noun in each title; a term filter on
 *      "switchgear" would hide every breaker/contactor card.
 *   3. The "only accessories" downgrade is skipped when the customer asked for accessories.
 *   4. catalog-fallback.server.js is optional: breaker, discovery-error and accessory checks have
 *      inline fallbacks, and every call into it is try/catch-wrapped.
 *   5. CATALOG_TOOL_MODE now defaults to "local": Claude's search_catalog runs through the tuned
 *      local pipeline (smartSearch). "auto" = UCP first, local on failure (v2.5). "ucp" = UCP only.
 *      When served locally, Claude sees a clean search_catalog schema (no UCP "meta" field).
 *   6. If MCP returned no catalog tool (UCP down / connect timeout), a local search_catalog tool is
 *      injected so Claude can still search.
 *   7. Router hints (category mix, "we don't list the FRP version", …) now also reach Claude on the
 *      tool path (_search_note), not just in the pre-pass SYSTEM NOTE.
 *   8. Parallel catalog searches in one Claude response share one product grid (merged,
 *      interleaved, ≤10) instead of the second grid replacing the first.
 *   9. Per-turn search memo (identical queries reuse the result) and a per-turn search cap
 *      (CHAT_MAX_CATALOG_SEARCHES, default 3).
 *  10. All tool results for one assistant message go into ONE user message, and every tool_use
 *      always gets a tool_result, even if the handler crashes.
 *  11. Turn budget (CHAT_TURN_BUDGET_MS, default 60000): no new Claude call after it.
 *  12. Empty-reply guard also covers "cards shown, but no text".
 *  13. Defensive: SSE sends never throw; missing tool arrays, empty tool responses and invalid
 *      history conversation_ids are handled; [ImageDebug] logs only with DEBUG_IMAGES=1.
 *
 * CHANGES (v2.5 / v2.5.1 — 29 Sep 2026):
 *   - UCP circuit breaker + local fallback for search_catalog; hide other UCP tools while the
 *     breaker is open; Storefront last-resort term filter; accessory-only flag; zero-result hint
 *     keeps the customer's qualifiers.
 * CHANGES (v2.4 — 28 Sep 2026):
 *   - Advisory mode (kill switch ADVISORY_MODE=off); SKU detector skips IP ratings, supply specs and
 *     M-thread sizes; safe stored-history parsing; history cap; tool loop only on "tool_use";
 *     empty-reply guard; request validation; parallel MCP connect; APP_PROXY_SIGNATURE_MODE;
 *     ALLOWED_ORIGINS.
 * CHANGES (v2.1–v2.3):
 *   - search_catalog + legacy search_shop_catalog; extractSearchQuery never JSON.stringify.
 */

const CHAT_VERSION = "2.6";

// Pre-search paths whose results may be off-target. For these the catalog search tool stays
// available so Claude can recover / be honest. Router v6 types algolia_category, algolia_multi
// and algolia_relaxed are HIGH on purpose (not listed).
const LOW_CONFIDENCE_PATHS = new Set([
  "sku_storefront_fallback",
  "sku_nosep_fallback",
  "storefront_search_last_resort",
  "algolia_search_weak",   // relevance floor judged hits off-target
  "algolia_brand_missing", // customer asked for a brand we don't carry
]);

// Router v6 already guarantees relevance for these (product noun in every title it keeps,
// per-item honesty hints). The chat-side term filter must not run on them.
const ROUTER_GUARDED_TYPES = new Set(["algolia_category", "algolia_multi", "algolia_relaxed"]);

const CATALOG_SEARCH_TOOL_NAMES = new Set(["search_shop_catalog", "search_catalog", "search_products"]);

function isCatalogSearchTool(toolName) {
  return CATALOG_SEARCH_TOOL_NAMES.has(String(toolName || "").toLowerCase());
}

// ─── Tunables (all optional env vars) ──────────────────────────────────
function intEnv(name, fallback) {
  const n = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const MAX_MESSAGE_CHARS = intEnv("CHAT_MAX_MESSAGE_CHARS", 4000);
const MAX_HISTORY_MESSAGES = intEnv("CHAT_MAX_HISTORY", 12);
const MAX_CATALOG_SEARCHES = intEnv("CHAT_MAX_CATALOG_SEARCHES", 3);
const TURN_BUDGET_MS = intEnv("CHAT_TURN_BUDGET_MS", 60000);
const ADVISORY_ENABLED = String(process.env.ADVISORY_MODE || "on").toLowerCase() !== "off";
const DEBUG_IMAGES = process.env.DEBUG_IMAGES === "1";
const MAX_CARDS = 10;
const MAX_TOOL_LOOPS = 6;
const SALES_EMAIL = "websales@creativeautomation.ae";

/**
 * CATALOG_TOOL_MODE:
 *   local (default) — Claude's catalog searches run through smartSearch (router v6 + Algolia v4).
 *   auto            — UCP first; local on UCP failure; circuit breaker after discovery errors.
 *   ucp             — UCP only (no local fallback).
 */
function catalogToolMode() {
  const raw = String(process.env.CATALOG_TOOL_MODE || "").trim().toLowerCase();
  return raw === "auto" || raw === "ucp" || raw === "local" ? raw : "local";
}

// The customer explicitly asked for accessories / spares → don't flag accessory-only results.
const ACCESSORY_QUERY_RE =
  /\b(accessor(?:y|ies)|spares?|spare\s+parts?|brackets?|mounting|kits?|seals?|cables?|connectors?|sockets?|holders?|covers?)\b/i;
const ACCESSORY_TITLE_RE = /\baccessor(?:y|ies)\b|\bspare\s+parts?\b|\bmounting\s+brackets?\b/i;

// Clean catalog tool for local serving (no UCP "meta" argument to confuse Claude).
const LOCAL_CATALOG_TOOL = {
  name: "search_catalog",
  description:
    "Search the Creative Automation product catalogue. Pass a short product query (2-6 words, keep sizes, " +
    "brand and type), or an exact part number on its own.",
  input_schema: {
    type: "object",
    properties: {
      catalog: {
        type: "object",
        properties: {
          query: { type: "string", description: "Product query or exact part number" },
        },
        required: ["query"],
      },
    },
    required: ["catalog"],
  },
};

// ─── catalog-fallback.server.js (optional) + inline fallbacks ───────────

// Used when catalog-fallback.server.js is missing or doesn't export a usable breaker.
const inlineUcpBreaker = {
  openUntil: 0,
  reason: null,
  cooldownMs: intEnv("UCP_BREAKER_MS", 10 * 60 * 1000),
  isOpen() {
    return Date.now() < this.openUntil;
  },
  trip(reason) {
    this.openUntil = Date.now() + this.cooldownMs;
    this.reason = reason || "discovery error";
  },
};

let _cfModule; // undefined = not loaded yet; null = unavailable
async function loadCatalogFallback() {
  if (_cfModule !== undefined) return _cfModule;
  try {
    _cfModule = await import("../services/catalog-fallback.server.js");
  } catch (e) {
    console.warn(`[Chat] catalog-fallback module unavailable (${e.message}) — using inline fallbacks`);
    _cfModule = null;
  }
  return _cfModule;
}

function ucpBreaker(cf) {
  const b = cf?.ucpBreaker;
  return b && typeof b.isOpen === "function" && typeof b.trip === "function" ? b : inlineUcpBreaker;
}
function breakerIsOpen(cf) {
  try {
    return !!ucpBreaker(cf).isOpen();
  } catch (e) {
    return false;
  }
}
function breakerTrip(cf, reason) {
  try {
    ucpBreaker(cf).trip(reason);
  } catch (e) {
    console.warn(`[Chat] breaker trip failed: ${e.message}`);
  }
}
function breakerInfo(cf) {
  const b = ucpBreaker(cf);
  return {
    reason: b.reason || "discovery error",
    minutes: Math.max(1, Math.round((Number(b.cooldownMs) || 600000) / 60000)),
  };
}
function isUcpDiscoveryError(cf, text) {
  try {
    if (typeof cf?.isUcpDiscoveryError === "function" && cf.isUcpDiscoveryError(text)) return true;
  } catch (e) { /* fall through to the inline check */ }
  return /profile_unreachable|UCP discovery failed|"code"\s*:\s*-32001|agent profile/i.test(String(text || ""));
}
function ucpErrorCode(cf, text) {
  try {
    if (typeof cf?.ucpErrorCode === "function") {
      const c = cf.ucpErrorCode(text);
      if (c) return String(c);
    }
  } catch (e) { /* fall through */ }
  const m = /"code"\s*:\s*"([a-z_]+)"/i.exec(String(text || ""));
  return m ? m[1] : String(text || "").slice(0, 160);
}
function isAccessoryTitle(cf, title) {
  try {
    if (typeof cf?.isAccessoryTitle === "function") return !!cf.isAccessoryTitle(title);
  } catch (e) { /* fall through */ }
  return ACCESSORY_TITLE_RE.test(String(title || ""));
}

/**
 * Term filter + accessory check. Never throws; on any problem the products are returned unchanged.
 *   query      — the CORRECTED query (router effectiveQuery), not the raw customer text
 *   searchType — router result type; router-guarded types skip the term filter
 */
function refineSafely(cf, products, query, searchType) {
  const list = Array.isArray(products) ? products : [];
  const asksAccessories = ACCESSORY_QUERY_RE.test(String(query || ""));
  const out = {
    products: list,
    dropped: 0,
    terms: [],
    accessoryOnly: !asksAccessories && list.length > 0 && list.every((p) => isAccessoryTitle(cf, p?.title)),
  };
  if (!list.length) return out;
  if (ROUTER_GUARDED_TYPES.has(searchType) || typeof cf?.refineProducts !== "function") return out;
  try {
    const r = cf.refineProducts(list, query, searchType);
    if (!r || !Array.isArray(r.products)) return out;
    return {
      products: r.products,
      dropped: Number(r.dropped) || Math.max(0, list.length - r.products.length),
      terms: Array.isArray(r.terms) ? r.terms : [],
      accessoryOnly: !asksAccessories && !!r.accessoryOnly,
    };
  } catch (e) {
    console.warn(`[Chat] refineProducts failed (${e.message}) — keeping results unfiltered`);
    return out;
  }
}

// ─── Small helpers ─────────────────────────────────────────────────────

/**
 * Extract the plain-text query string from catalog search tool args.
 *   search_shop_catalog (old): { query: "solenoid valve" }
 *   search_catalog (new/UCP):  { catalog: { query: "solenoid valve" } }
 * CRITICAL: NEVER fall back to JSON.stringify(toolArgs).
 */
function extractSearchQuery(toolArgs) {
  if (!toolArgs) return null;
  if (toolArgs?.catalog?.query && typeof toolArgs.catalog.query === "string") return toolArgs.catalog.query.trim() || null;
  if (toolArgs?.query && typeof toolArgs.query === "string") return toolArgs.query.trim() || null;
  if (toolArgs?.searchQuery && typeof toolArgs.searchQuery === "string") return toolArgs.searchQuery.trim() || null;
  if (toolArgs?.q && typeof toolArgs.q === "string") return toolArgs.q.trim() || null;
  if (typeof toolArgs === "string") return toolArgs.trim() || null;
  return null; // NEVER JSON.stringify
}

function safeHostname(urlLike) {
  try {
    return urlLike ? new URL(urlLike).hostname : null;
  } catch (e) {
    return null; // e.g. Origin: "null" from sandboxed iframes
  }
}

const CONVERSATION_ID_RE = /^[\w.\-:]{1,128}$/;

function normalizeConversationId(id) {
  if (typeof id === "string" && CONVERSATION_ID_RE.test(id)) return id;
  const uuid = globalThis.crypto?.randomUUID?.();
  return `conv_${uuid || Date.now()}`;
}

/** Only treat stored content as structured if it parses to an array of content blocks. */
function parseStoredContent(raw) {
  if (typeof raw !== "string") return raw;
  try {
    const parsed = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((b) => b && typeof b === "object" && typeof b.type === "string")
    ) {
      return parsed;
    }
    return raw;
  } catch (e) {
    return raw;
  }
}

/** Keep the last `max` messages; the API needs the first turn to be a user turn. */
function capHistory(messages, max) {
  if (!Array.isArray(messages) || messages.length <= max) return messages;
  const trimmed = messages.slice(-max);
  while (trimmed.length > 1 && trimmed[0].role !== "user") trimmed.shift();
  return trimmed;
}

function errorText(err) {
  if (!err) return "";
  const data = typeof err.data === "string" ? err.data : err.data ? JSON.stringify(err.data) : "";
  return [err.message, data].filter(Boolean).join(" ");
}

function normQueryKey(q) {
  return String(q || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function productKey(p) {
  return p?.id || p?.handle || p?.title || null;
}

function dedupeProducts(list) {
  const seen = new Set();
  const out = [];
  for (const p of Array.isArray(list) ? list : []) {
    const k = productKey(p);
    if (!p || !k || seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

/** Merge two result lists fairly (a1, b1, a2, b2, …), de-duplicated, capped. */
function interleaveProducts(a, b, max) {
  const out = [];
  const seen = new Set();
  const add = (p) => {
    const k = productKey(p);
    if (!p || !k || seen.has(k) || out.length >= max) return;
    seen.add(k);
    out.push(p);
  };
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len && out.length < max; i++) {
    add(a[i]);
    add(b[i]);
  }
  return out;
}

/**
 * Detect SKU-like tokens in a user message.
 * Used to annotate the Claude message so it searches the exact code first.
 */
function detectSkuTokens(message) {
  if (!message || typeof message !== "string") return [];
  const skuRegex = /\b([A-Z0-9]{2,}[-\.\/][A-Z0-9][\w\-\.\/]*|[A-Z]{1,4}\d[\w\-\.\/]{2,}|\d{1,4}[A-Z]{1,5}[\w\-\.\/]{2,})\b/gi;
  const matches = [];
  const seen = new Set();
  let m;
  while ((m = skuRegex.exec(message)) !== null) {
    const token = m[1].toUpperCase().replace(/\.$/, "");
    if (token.length < 4) continue;
    if (!/\d/.test(token) || !/[A-Z]/i.test(token)) continue;
    // Pure electrical/spec tokens: "24VDC", "18MM", "24V", "100A", "5W"
    if (/^\d+(?:MM|CM|VDC|VAC|V|A|W|KW|HP)$/i.test(token)) continue;
    // Dimension+unit tokens: "2INCH", "2IN", "3FT", "4FEET"
    if (/^\d+(?:\.\d+)?(?:INCH|INCHES|IN|FT|FEET|FOOT|KM)$/i.test(token)) continue;
    // Thread/pipe-standard tokens used as dimensions: "38NPT", "12BSP"
    if (/^\d+(?:NPT|BSP|BSPP|BSPT)$/i.test(token)) continue;
    // IP ratings ("IP69K", "IP67/IP69K") and supply specs ("24V-DC", "DC24V", "12-24VDC")
    if (/^IP\d{2}K?(?:[-\/]IP\d{2}K?)*$/i.test(token)) continue;
    if (/^\d+(?:\.\d+)?V[-\/]?(?:DC|AC)$/i.test(token)) continue;
    if (/^(?:DC|AC)[-\/]?\d+(?:\.\d+)?V?$/i.test(token)) continue;
    if (/^\d+(?:\.\d+)?[-\/]\d+(?:\.\d+)?V(?:DC|AC)?$/i.test(token)) continue;
    // Thread/body sizes ("M12X1", "M18X1.5")
    if (/^M\d{1,2}X\d+(?:\.\d+)?$/i.test(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    matches.push(token);
  }
  return matches;
}

/**
 * Connect to the three MCP servers in parallel; one failing server does not block the others.
 * MCP_PARALLEL_CONNECT=0 restores the old sequential behaviour.
 */
async function connectMcpServers(mcpClient) {
  const jobs = [
    { name: "ucp", key: "ucp", run: () => mcpClient.connectToUcpCatalogServer() },
    { name: "storefront", key: "sf", run: () => mcpClient.connectToStorefrontServer() },
    { name: "customer", key: "cu", run: () => mcpClient.connectToCustomerServer() },
  ];
  const out = { ucp: [], sf: [], cu: [] };
  const record = (job, value) => {
    out[job.key] = Array.isArray(value) ? value : [];
  };

  if (process.env.MCP_PARALLEL_CONNECT === "0") {
    for (const job of jobs) {
      try {
        record(job, await job.run());
      } catch (e) {
        console.warn(`[Chat] MCP ${job.name} connect failed: ${e.message}`);
      }
    }
    return out;
  }

  const settled = await Promise.allSettled(jobs.map((job) => Promise.resolve().then(job.run)));
  settled.forEach((res, i) => {
    if (res.status === "fulfilled") record(jobs[i], res.value);
    else console.warn(`[Chat] MCP ${jobs[i].name} connect failed: ${res.reason?.message || res.reason}`);
  });
  return out;
}

// ─── Opt-in hardening ──────────────────────────────────────────────────

/**
 * Verify the Shopify app-proxy signature: HMAC-SHA256 (hex) over the sorted "key=value" query
 * parameters (values of repeated keys joined with ","), concatenated without separators, keyed with
 * the app's client secret. The body is not signed.
 */
async function verifyAppProxySignature(request) {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) return { ok: false, reason: "SHOPIFY_API_SECRET missing" };

  const url = new URL(request.url);
  const signature = url.searchParams.get("signature");
  if (!signature) return { ok: false, reason: "no signature param" };

  const grouped = new Map();
  for (const [key, value] of url.searchParams.entries()) {
    if (key === "signature") continue;
    grouped.set(key, grouped.has(key) ? `${grouped.get(key)},${value}` : value);
  }
  const message = [...grouped.entries()].map(([k, v]) => `${k}=${v}`).sort().join("");

  const { createHmac, timingSafeEqual } = await import("node:crypto");
  const digest = createHmac("sha256", secret).update(message).digest("hex");
  const a = Buffer.from(digest);
  const b = Buffer.from(signature);
  const ok = a.length === b.length && timingSafeEqual(a, b);
  return { ok, reason: ok ? null : "signature mismatch" };
}

/** APP_PROXY_SIGNATURE_MODE: "off" (default) | "log" | "enforce". */
async function checkAppProxySignature(request) {
  const mode = String(process.env.APP_PROXY_SIGNATURE_MODE || "off").toLowerCase();
  if (mode !== "log" && mode !== "enforce") return { allowed: true };

  let ok = false;
  let reason = "unknown";
  try {
    const result = await verifyAppProxySignature(request);
    ok = result.ok;
    reason = result.reason;
  } catch (e) {
    reason = `error: ${e.message}`;
  }
  if (ok) return { allowed: true };

  console.warn(
    `[Security] App-proxy signature check failed (${reason}) | mode=${mode} | ${request.method} ${new URL(request.url).pathname}`
  );
  return { allowed: mode !== "enforce" };
}

function unauthorizedResponse(request) {
  return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: getCorsHeaders(request) });
}

// ─── Routes ────────────────────────────────────────────────────────────

export async function loader({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getCorsHeaders(request) });
  }

  const url = new URL(request.url);

  if (url.searchParams.has("history") && url.searchParams.has("conversation_id")) {
    const sig = await checkAppProxySignature(request);
    if (!sig.allowed) return unauthorizedResponse(request);
    const convId = url.searchParams.get("conversation_id");
    if (!CONVERSATION_ID_RE.test(convId || "")) {
      return new Response(JSON.stringify({ messages: [], error: "Invalid conversation_id" }), {
        status: 400,
        headers: getCorsHeaders(request),
      });
    }
    return handleHistoryRequest(request, convId);
  }

  if (url.searchParams.has("stream") || request.headers.get("Accept")?.includes("text/event-stream")) {
    const sig = await checkAppProxySignature(request);
    if (!sig.allowed) return unauthorizedResponse(request);
    return handleChatRequest(request);
  }

  return new Response(JSON.stringify({ status: "ok", message: "Chat API is running", version: CHAT_VERSION }), {
    status: 200,
    headers: getCorsHeaders(request),
  });
}

export async function action({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getCorsHeaders(request) });
  }
  const sig = await checkAppProxySignature(request);
  if (!sig.allowed) return unauthorizedResponse(request);
  return handleChatRequest(request);
}

async function handleHistoryRequest(request, conversationId) {
  try {
    const dbMod = await import("../db.server");
    const messages = await dbMod.getConversationHistory(conversationId);

    const cleanedMessages = (Array.isArray(messages) ? messages : []).map((msg) => {
      let parsedContent = msg.content;
      try {
        const parsed = JSON.parse(msg.content);
        if (Array.isArray(parsed)) parsedContent = parsed;
      } catch (e) {
        parsedContent = msg.content;
      }
      return { id: msg.id, role: msg.role, content: parsedContent, contentType: msg.contentType, createdAt: msg.createdAt };
    });

    return new Response(JSON.stringify({ messages: cleanedMessages }), {
      headers: { ...getCorsHeaders(request), "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error fetching history:", error);
    return new Response(JSON.stringify({ messages: [], error: "Could not load history" }), {
      status: 500,
      headers: { ...getCorsHeaders(request), "Content-Type": "application/json" },
    });
  }
}

async function handleChatRequest(request) {
  try {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers: getCorsHeaders(request) });
    }

    const rawMessage = body?.message;
    if (typeof rawMessage !== "string" || !rawMessage.trim()) {
      return new Response(JSON.stringify({ error: "Missing message" }), { status: 400, headers: getCorsHeaders(request) });
    }
    let userMessage = rawMessage.trim();
    if (userMessage.length > MAX_MESSAGE_CHARS) {
      console.warn(`[Chat] Message truncated from ${userMessage.length} to ${MAX_MESSAGE_CHARS} chars`);
      userMessage = userMessage.slice(0, MAX_MESSAGE_CHARS);
    }

    const visitorId = body.visitor_id;
    const fingerprintId = body.fingerprint_id;
    const conversationId = normalizeConversationId(body.conversation_id);
    const promptType = typeof body.prompt_type === "string" && body.prompt_type ? body.prompt_type : "standardAssistant";

    const dbMod = await import("../db.server");
    const { saveMessage, getConversationHistory, storeCustomerAccountUrls, getCustomerAccountUrls: getCustomerAccountUrlsFromDb } = dbMod;
    const posthogMod = await import("../services/posthog.server");
    const ChatEvents = posthogMod.ChatEvents;
    const streamMod = await import("../services/streaming.server");
    const createSseStream = streamMod.createSseStream;
    const claudeMod = await import("../services/claude.server");
    const createClaudeService = claudeMod.createClaudeService;
    const toolMod = await import("../services/tool.server");
    const createToolService = toolMod.createToolService;
    const MCPClientMod = await import("../mcp-client");
    const MCPClient = MCPClientMod.default ?? MCPClientMod;

    const reqUrl = new URL(request.url);
    const shopFromProxy = reqUrl.searchParams.get("shop");
    const shopFromBody = body.shop_domain || null;
    const origin = request.headers.get("Origin");
    const shopFromOrigin = safeHostname(origin);
    const shopDomain = shopFromProxy || shopFromBody || shopFromOrigin || process.env.SHOPIFY_STORE_DOMAIN || null;

    if (!shopDomain) console.warn("[Chat] Could not resolve shop domain from request");

    const trackingId = visitorId || fingerprintId || conversationId;
    try { ChatEvents?.messageSent?.(trackingId, { conversationId, shopDomain, messageLength: userMessage.length }); } catch (e) {}

    const responseStream = createSseStream(async (stream) => {
      await handleChatSession({
        request, userMessage, conversationId, promptType, stream,
        visitorId, fingerprintId, shopDomain,
        helpers: { saveMessage, getConversationHistory, getCustomerAccountUrlsFromDb, storeCustomerAccountUrls, ChatEvents, createClaudeService, createToolService, MCPClient },
      });
    });

    return new Response(responseStream, { headers: getSseHeaders(request) });
  } catch (error) {
    console.error("Error in chat request handler:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: getCorsHeaders(request),
    });
  }
}

async function handleChatSession({ request, userMessage, conversationId, promptType, stream, visitorId, fingerprintId, shopDomain, helpers }) {
  const startTime = Date.now();
  const { saveMessage, getConversationHistory, getCustomerAccountUrlsFromDb, storeCustomerAccountUrls, ChatEvents, createClaudeService, createToolService, MCPClient } = helpers;

  // SSE sends must never throw (the client may have gone away).
  const send = (msg) => {
    try {
      stream.sendMessage(msg);
    } catch (e) { /* client disconnected */ }
  };
  const track = (fn, data) => {
    try { ChatEvents?.[fn]?.(visitorId || fingerprintId || conversationId, data); } catch (e) {}
  };

  send({ type: "id", conversation_id: conversationId });
  console.log(`[Chat] New request | conversation=${conversationId} | shop=${shopDomain} | v${CHAT_VERSION}`);

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("[Chat] ANTHROPIC_API_KEY missing");
    send({ type: "error", error: "Anthropic API key not configured." });
    return;
  }

  // ── Per-turn state (hoisted so the catch block can see it) ──────────
  let productsSentToFrontend = false;
  let advisory = null;      // analyzeEnquiry() result, or null for normal enquiries
  let advisoryMod = null;   // services/advisory.server.js
  let fullResponseText = "";
  let loopCount = 0;        // 0 = pre-pass, 1..n = Claude calls
  let catalogSearches = 0;
  let localCatalogTool = false; // Claude's search_catalog is served locally this turn
  let gridLoop = -1;            // loop that produced the products currently shown
  let gridProducts = [];
  const localSearchMemo = new Map();

  const cf = await loadCatalogFallback();
  const catalogMode = catalogToolMode();

  const getAdvisoryFallback = () => {
    try {
      return advisory && advisoryMod?.buildAdvisoryFallback ? advisoryMod.buildAdvisoryFallback(advisory) : "";
    } catch (e) {
      return "";
    }
  };

  const sendFallbackText = (text) => {
    fullResponseText += text;
    send({ type: "chunk", chunk: text });
    send({ type: "message_complete" });
    Promise.resolve(
      saveMessage(conversationId, "assistant", text, { contentType: "TEXT", responseTimeMs: Date.now() - startTime, shopDomain, visitorId })
    ).catch((err) => console.error("[Chat] Error saving fallback message:", err?.message));
  };

  /**
   * Show product cards. Searches made inside the same Claude response (parallel tool calls) are
   * merged into one grid; a later Claude call or the pre-pass replaces it.
   */
  const showProducts = (products, { merge = false } = {}) => {
    const list = dedupeProducts(products);
    if (!list.length) return [];
    const shown =
      merge && gridLoop === loopCount && gridProducts.length
        ? interleaveProducts(gridProducts, list, MAX_CARDS)
        : list.slice(0, MAX_CARDS);
    gridLoop = loopCount;
    gridProducts = shown;
    send({ type: "product_results", products: shown });
    productsSentToFrontend = true;
    return shown;
  };

  // ── Tool-result hints (shared by the UCP path and the local path) ───
  const buildStopHint = (shown, { lowConfidence = false, accessoryOnly = false, searchNote = "" } = {}) =>
    JSON.stringify({
      products: shown.slice(0, 3).map((p) => ({ id: p.id, title: p.title, sku: p.sku || null, price: p.price || null })),
      total_count: shown.length,
      ...(searchNote ? { _search_note: String(searchNote).slice(0, 800) } : {}),
      _display_note:
        (accessoryOnly
          ? "IMPORTANT: every result is an ACCESSORY or spare part (see the titles), not a main product. If the customer asked for the main product, say plainly that these are accessories and do not present them as the product itself. "
          : lowConfidence
            ? "These results may NOT fully match the request: compare the titles with what the customer asked and be honest about any mismatch. "
            : "") +
        (searchNote ? "Follow _search_note: it says exactly what these cards are. " : "") +
        (advisory
          ? `${shown.length} product card(s) are now displayed to the user. Do NOT search again. Now write your reply in the REPLY FORMAT from the ADVISORY BRIEF (it overrides the one-short-response rule).`
          : `${shown.length} product card(s) are now displayed to the user. Do NOT search again. Write one short response acknowledging the results.`),
    });

  const buildZeroHint = (searchQuery) =>
    JSON.stringify({
      products: [],
      total_count: 0,
      _system_hint: advisory
        ? `Zero products found for "${searchQuery}". Do NOT search again. Write your reply in the REPLY FORMAT from the ADVISORY BRIEF, say no matching products were found in the catalogue for now, and offer ${SALES_EMAIL}.`
        : `Zero products found for "${searchQuery}". You may try ONE more search only for the SAME product with corrected spelling, keeping every key qualifier the customer gave (material, brand, type — e.g. keep "FRP"). Do NOT search for a different product category and do not offer products from other categories as a match. If still zero, tell the customer we don't currently list this item on the website (never that we don't supply it) and offer ${SALES_EMAIL} for sourcing or a quote.`,
    });

  const buildLimitHint = () =>
    JSON.stringify({
      products: [],
      total_count: 0,
      _system_hint: `Search limit reached for this message. Do NOT search again. Answer with what is already shown; for anything not found, say it isn't listed on the website and offer ${SALES_EMAIL}.`,
    });

  /** Serve a catalog search from our own pipeline. Identical queries in one turn share the result. */
  const runLocalCatalogSearch = (query, reason) => {
    const key = normQueryKey(query);
    if (localSearchMemo.has(key)) {
      console.log(`[Chat] Local catalog search memo hit for "${query}"`);
      return localSearchMemo.get(key);
    }
    const job = (async () => {
      const t0 = Date.now();
      try {
        const { smartSearch } = await import("../services/search-router.server.js");
        const smart = await smartSearch(query, shopDomain, []);
        const searchType = smart?.searchType || "none";
        const effective = smart?.effectiveQuery || smart?.query || query;
        let products = Array.isArray(smart?.products) ? smart.products : [];
        let accessoryOnly = false;
        if (products.length) {
          const before = products.length;
          const r = refineSafely(cf, products, effective, searchType);
          if (r.dropped > 0) {
            console.log(`[Chat] Relevance filter (${searchType}) dropped ${r.dropped}/${before} for "${effective}" (terms: ${r.terms.join(",")})`);
          }
          if (r.accessoryOnly) console.log(`[Chat] Only accessories found for "${query}" — flagged to Claude`);
          products = r.products;
          accessoryOnly = r.accessoryOnly;
        }
        products = products.slice(0, MAX_CARDS);
        console.log(`[Chat] Local catalog search (${reason}) q="${query}" → ${products.length} products (${searchType}) | ${Date.now() - t0}ms`);
        return {
          products,
          searchType,
          accessoryOnly,
          lowConfidence: LOW_CONFIDENCE_PATHS.has(searchType) || accessoryOnly,
          searchNote: products.length ? smart?.systemHint || "" : "",
        };
      } catch (e) {
        console.warn(`[Chat] Local catalog search failed (${reason}) q="${query}": ${e.message}`);
        return { products: [], searchType: "error", accessoryOnly: false, lowConfidence: true, searchNote: "" };
      }
    })();
    localSearchMemo.set(key, job);
    return job;
  };

  let conversationHistory = [];
  let currentAssistantMessage = null;

  // Push the pending assistant message (with its tool_use blocks) before any tool_result.
  const flushAssistant = () => {
    if (currentAssistantMessage) {
      conversationHistory.push({ role: currentAssistantMessage.role, content: currentAssistantMessage.content });
      currentAssistantMessage = null;
    }
  };
  // All tool_results answering one assistant message go into ONE user message.
  const pushToolResult = (block) => {
    const last = conversationHistory[conversationHistory.length - 1];
    if (
      last &&
      last.role === "user" &&
      Array.isArray(last.content) &&
      last.content.length > 0 &&
      last.content.every((b) => b?.type === "tool_result")
    ) {
      last.content.push(block);
    } else {
      conversationHistory.push({ role: "user", content: [block] });
    }
  };

  try {
    // ── Customer account URLs (5 s cap) ─────────────────────────────
    let mcpApiUrl = null;
    try {
      const urlResult = await Promise.race([
        getCustomerAccountUrls(shopDomain, conversationId, { getCustomerAccountUrlsFromDb, storeCustomerAccountUrls }),
        new Promise((resolve) => setTimeout(() => resolve({ mcpApiUrl: null }), 5000)),
      ]);
      mcpApiUrl = urlResult?.mcpApiUrl || null;
    } catch (e) {
      console.warn("[Chat] Failed to get customer account URLs:", e.message);
    }

    const claudeService = createClaudeService();
    const toolService = createToolService();
    const mcpClient = new MCPClient(shopDomain, conversationId, null, mcpApiUrl);

    // ── MCP connect (parallel, 8 s cap) ─────────────────────────────
    let storefrontMcpTools = [], customerMcpTools = [], ucpMcpTools = [];
    try {
      const connectStart = Date.now();
      const mcpResult = await Promise.race([
        connectMcpServers(mcpClient),
        new Promise((resolve) => setTimeout(() => resolve(null), 8000)),
      ]);
      if (mcpResult) {
        ucpMcpTools = mcpResult.ucp;
        storefrontMcpTools = mcpResult.sf;
        customerMcpTools = mcpResult.cu;
        console.log(
          `[Chat] MCP connect | ucp=${ucpMcpTools.length} storefront=${storefrontMcpTools.length} ` +
          `customer=${customerMcpTools.length} | ${Date.now() - connectStart}ms`
        );
      } else {
        console.warn("[Chat] MCP connect timed out after 8000ms");
      }
    } catch (error) {
      console.warn("[Chat] MCP connection failed:", error.message);
    }

    // Tool arrays must always be arrays from here on.
    mcpClient.tools = Array.isArray(mcpClient.tools) ? mcpClient.tools : [];
    mcpClient.ucpTools = Array.isArray(mcpClient.ucpTools) ? mcpClient.ucpTools : [];
    mcpClient.storefrontTools = Array.isArray(mcpClient.storefrontTools) ? mcpClient.storefrontTools : [];
    console.log(`Connected to MCP: ${mcpClient.tools.length} tools`);

    const mcpCatalogTool = mcpClient.tools.find((t) => isCatalogSearchTool(t?.name));
    if (mcpCatalogTool) {
      console.log(`[Chat] MCP catalog-search tool: "${mcpCatalogTool.name}"`);
      console.log(`[Chat] catalog tool input_schema keys: [${Object.keys(mcpCatalogTool.input_schema?.properties || {}).join(", ")}]`);
    }

    // ── Catalog serving decision ────────────────────────────────────
    const ucpOpen = breakerIsOpen(cf);
    if (catalogMode !== "ucp" && ucpOpen) {
      // UCP rejects every call while the agent profile is broken: hide the non-search UCP tools.
      const otherNames = new Set([...storefrontMcpTools, ...customerMcpTools].map((t) => t?.name));
      const hidden = new Set(
        mcpClient.ucpTools.filter((t) => !isCatalogSearchTool(t?.name) && !otherNames.has(t?.name)).map((t) => t.name)
      );
      if (hidden.size > 0) {
        mcpClient.ucpTools = mcpClient.ucpTools.filter((t) => !hidden.has(t?.name));
        mcpClient.tools = mcpClient.tools.filter((t) => !hidden.has(t?.name));
        console.warn(`[Chat] UCP circuit open (${breakerInfo(cf).reason}) — catalog search served locally; hid ${hidden.size} other UCP tools`);
      }
    }
    if (catalogMode !== "ucp" && (catalogMode === "local" || ucpOpen || !mcpCatalogTool)) {
      // Serve search_catalog locally with a clean schema (replaces the UCP definition, if any).
      mcpClient.tools = [...mcpClient.tools.filter((t) => !isCatalogSearchTool(t?.name)), LOCAL_CATALOG_TOOL];
      localCatalogTool = true;
      console.log(
        `[Chat] search_catalog served locally (${catalogMode === "local" ? "CATALOG_TOOL_MODE=local" : ucpOpen ? "UCP circuit open" : "no catalog tool from MCP"})`
      );
    } else if (!mcpCatalogTool) {
      console.warn(`[Chat] WARNING: No catalog-search tool available (CATALOG_TOOL_MODE=ucp). Tools: ${mcpClient.tools.map((t) => t?.name).join(", ")}`);
    }

    // ── Save + load history ─────────────────────────────────────────
    try {
      await saveMessage(conversationId, "user", userMessage, { shopDomain, visitorId });
    } catch (dbError) {
      console.error("[Chat] Failed to save user message:", dbError.message);
    }

    try {
      const dbMessages = await getConversationHistory(conversationId);
      conversationHistory = (Array.isArray(dbMessages) ? dbMessages : []).map((m) => ({
        role: m.role,
        content: parseStoredContent(m.content),
      }));
    } catch (historyError) {
      console.error("[Chat] Failed to get history:", historyError.message);
    }

    const lastMsg = conversationHistory[conversationHistory.length - 1];
    if (!lastMsg || lastMsg.role !== "user" || lastMsg.content !== userMessage) {
      conversationHistory.push({ role: "user", content: userMessage });
    }

    const detectedSkus = detectSkuTokens(userMessage);

    // ── Advisory analysis (raw history, before any annotation) ──────
    if (ADVISORY_ENABLED) {
      try {
        advisoryMod = await import("../services/advisory.server.js");
        advisory = advisoryMod.analyzeEnquiry(userMessage, conversationHistory, { hasSku: detectedSkus.length > 0 });
        if (advisory) console.log(advisoryMod.formatAdvisoryLog(advisory));
      } catch (advisoryErr) {
        console.warn(`[Chat] Advisory analysis failed: ${advisoryErr.message}`);
        advisory = null;
      }
    }

    // ── SKU annotation (Claude only; the DB keeps the original) ─────
    if (detectedSkus.length > 0) {
      const skuList = detectedSkus.slice(0, 3).join('", "');
      const annotation = `[SYSTEM: The user's message contains product code(s): "${skuList}". MANDATORY: Your FIRST search query MUST be the exact code "${detectedSkus[0]}" — no category words, no brand name, no dimensions added. Only broaden the search if the exact code returns zero results.]`;
      const lastIdx = conversationHistory.length - 1;
      if (conversationHistory[lastIdx]?.role === "user" && typeof conversationHistory[lastIdx].content === "string") {
        conversationHistory[lastIdx] = { role: "user", content: `${annotation}\n\n${conversationHistory[lastIdx].content}` };
      }
      console.log(`[Chat] SKU annotation injected: ${detectedSkus.join(", ")}`);
    }

    // ── Smart-search pre-pass ───────────────────────────────────────
    let smartResult = null;
    let systemNote = null;

    if (advisory?.skipPreSearch) {
      console.log("[Chat] Advisory: search pre-pass skipped (no product query fits this enquiry yet)");
    } else {
      try {
        const { smartSearch } = await import("../services/search-router.server.js");
        const historyForSearch = conversationHistory.slice(-6);
        const searchInput = advisory?.searchQuery || userMessage;
        if (advisory?.searchQuery) {
          console.log(`[Chat] Advisory search query: "${advisory.searchQuery}" (customer wrote: "${userMessage.slice(0, 80)}")`);
        }
        let smart = await smartSearch(searchInput, shopDomain, historyForSearch);

        if (smart && Array.isArray(smart.products) && smart.products.length > 0) {
          // v2.6: filter with the router's CORRECTED query, never the raw (possibly misspelled) text.
          const effective = smart.effectiveQuery || smart.query || searchInput;
          const before = smart.products.length;
          const r = refineSafely(cf, smart.products, effective, smart.searchType);
          if (r.dropped > 0) {
            console.log(`[Chat] Relevance filter (${smart.searchType}) dropped ${r.dropped}/${before} pre-found products (terms: ${r.terms.join(",")})`);
          }
          if (r.products.length === 0) {
            systemNote =
              `[SYSTEM NOTE — NOT FROM USER] A catalog search for this message found NO matching products (only unrelated items, which were hidden). ` +
              `Do NOT call the catalog search again for this request, and do not show or suggest products from other categories as a match. ` +
              `Tell the customer honestly that we don't currently list this item on the website (never that we don't supply it), and offer ${SALES_EMAIL} for sourcing or a quote. ` +
              (advisory ? `Follow the ADVISORY BRIEF's reply format for the rest of the reply.` : `Reply in 1-3 sentences.`);
            console.log("[Chat] Pre-pass: no relevant products — no-match note added");
            smart = null;
          } else if (r.accessoryOnly) {
            console.log(`[Chat] Pre-pass: only accessories found for "${String(searchInput).slice(0, 60)}" — treated as low confidence`);
            smart = {
              ...smart,
              products: r.products,
              searchType: LOW_CONFIDENCE_PATHS.has(smart.searchType) ? smart.searchType : "algolia_search_weak",
              systemHint: `${smart.systemHint || ""} All results are ACCESSORIES or spare parts, not the main product: say so plainly.`,
            };
          } else {
            smart = { ...smart, products: r.products };
          }
        }

        if (smart && Array.isArray(smart.products) && smart.products.length > 0) {
          const shown = showProducts(smart.products);
          smartResult = { ...smart, products: shown };
          console.log(`[Chat] SmartSearch pre-found ${shown.length} products (${smart.searchType})`);

          const summary = shown.slice(0, 8).map((p) => ({ title: p.title, vendor: p.vendor, price: p.price, sku: p.sku }));
          const isLowConfidence = LOW_CONFIDENCE_PATHS.has(smart.searchType);
          const replyInstruction = advisory
            ? `An [ADVISORY BRIEF] follows below: its REPLY FORMAT overrides the 1-3 sentence limit for this reply. `
            : `Write ONE short conversational reply (1-3 sentences). `;
          systemNote =
            `[SYSTEM NOTE — NOT FROM USER] Products have already been pre-found for this query and product cards are ALREADY DISPLAYED. ` +
            `${smart.systemHint || ""} ` +
            (isLowConfidence
              ? `These results may NOT fully match the request. Compare the titles/vendors below with what the customer asked ` +
                `(brand, bore, stroke, size, output type). Be honest about any mismatch. You may call the catalog search ONCE ` +
                `with a better query if needed. `
              : `Do NOT call search_catalog (or any catalog search tool) again — the results are already shown. ` +
                `If the titles below do not match a spec or brand the customer asked for, say so honestly. `) +
            replyInstruction +
            `Pre-found product summary: ${JSON.stringify(summary)}`;
        }
      } catch (smartErr) {
        console.warn(`[Chat] SmartSearch pre-pass failed: ${smartErr.message}`);
      }
    }

    // ── Compose the last user turn: SYSTEM NOTE → ADVISORY BRIEF → message ──
    let advisoryBrief = "";
    if (advisory && advisoryMod) {
      try {
        advisoryBrief = advisoryMod.buildAdvisoryBrief(advisory);
      } catch (e) {
        console.warn(`[Chat] buildAdvisoryBrief failed: ${e.message}`);
      }
    }
    if (systemNote || advisoryBrief) {
      const lastIdx = conversationHistory.length - 1;
      if (conversationHistory[lastIdx]?.role === "user" && typeof conversationHistory[lastIdx].content === "string") {
        conversationHistory[lastIdx] = {
          role: "user",
          content: [systemNote, advisoryBrief, `User message: ${conversationHistory[lastIdx].content}`].filter(Boolean).join("\n\n"),
        };
      }
    }

    // ── Strip catalog-search tools after a HIGH-CONFIDENCE pre-pass ─
    if (smartResult) {
      if (LOW_CONFIDENCE_PATHS.has(smartResult.searchType)) {
        console.log(`[Chat] Products pre-found via LOW-CONFIDENCE path (${smartResult.searchType}) — keeping catalog tools available so Claude can recover.`);
      } else {
        const before = mcpClient.tools.length;
        mcpClient.storefrontTools = mcpClient.storefrontTools.filter((t) => !isCatalogSearchTool(t?.name));
        mcpClient.ucpTools = mcpClient.ucpTools.filter((t) => !isCatalogSearchTool(t?.name));
        mcpClient.tools = mcpClient.tools.filter((t) => !isCatalogSearchTool(t?.name));
        console.log(`[Chat] Products pre-found via HIGH-CONFIDENCE path (${smartResult.searchType || "unknown"}) — stripped catalog tools (${before} → ${mcpClient.tools.length} tools).`);
      }
    }

    if (conversationHistory.length > MAX_HISTORY_MESSAGES) {
      const before = conversationHistory.length;
      conversationHistory = capHistory(conversationHistory, MAX_HISTORY_MESSAGES);
      console.log(`[Chat] History capped ${before} → ${conversationHistory.length} messages`);
    }

    // ── Claude loop ─────────────────────────────────────────────────
    let finalMessage = null;
    let stopReason = null;

    while (loopCount < MAX_TOOL_LOOPS) {
      if (loopCount > 0 && Date.now() - startTime > TURN_BUDGET_MS) {
        console.warn(`[Chat] Turn budget ${TURN_BUDGET_MS}ms exceeded after ${loopCount} Claude call(s) — ending turn`);
        break;
      }
      loopCount++;
      currentAssistantMessage = null;
      console.log(`[Chat] Claude call #${loopCount} | history=${conversationHistory.length} messages`);

      finalMessage = await claudeService.streamConversation(
        { messages: conversationHistory, promptType, tools: mcpClient.tools },
        {
          onText: (textDelta) => {
            if (typeof textDelta !== "string") return;
            fullResponseText += textDelta;
            send({ type: "chunk", chunk: textDelta });
          },

          onMessage: async (message) => {
            currentAssistantMessage = message;
            let textContent = "";
            if (Array.isArray(message?.content)) {
              textContent = message.content.filter((b) => b?.type === "text").map((b) => b.text).join("\n\n");
            } else if (typeof message?.content === "string") {
              textContent = message.content;
            }
            const responseTime = Date.now() - startTime;
            if (textContent.trim()) {
              Promise.resolve(
                saveMessage(conversationId, message.role, textContent, { contentType: "TEXT", responseTimeMs: responseTime, shopDomain, visitorId })
              ).catch((err) => console.error("[Chat] Error saving assistant message:", err?.message));
            }
            track("messageReceived", { conversationId, responseTimeMs: responseTime, contentLength: textContent.length });
            send({ type: "message_complete" });
          },

          onToolUse: async (content) => {
            const toolName = content?.name;
            const toolArgs = content?.input;
            const toolUseId = content?.id;
            let resultPushed = false;

            try {
              flushAssistant();
              console.log(`[Chat] Tool use: ${toolName} (id=${toolUseId})`);

              const thinkingStates = {
                search_shop_catalog: "Searching products...",
                search_catalog: "Searching products...",
                search_products: "Searching products...",
                update_cart: "Adding to cart...",
                get_cart: "Checking availability...",
                get_product: "Looking up product...",
                get_product_details: "Looking up product details...",
              };
              send({ type: "thinking_state", state: thinkingStates[toolName] || "Thinking..." });
              send({ type: "tool_use", tool_name: toolName });
              track("toolCalled", { conversationId, toolName, toolArgs });

              const isCatalogSearch = isCatalogSearchTool(toolName);
              const searchQuery = isCatalogSearch ? extractSearchQuery(toolArgs) : null; // never JSON.stringify
              if (isCatalogSearch) {
                catalogSearches++;
                if (!searchQuery) console.warn(`[Chat] Could not extract searchQuery from toolArgs: ${JSON.stringify(toolArgs)}`);
                else console.log(`[Chat] Extracted searchQuery: "${searchQuery}"`);
              }

              let toolUseResponse = null;
              let localResult = null;
              const canUseLocal = isCatalogSearch && !!searchQuery && catalogMode !== "ucp";

              if (isCatalogSearch && catalogSearches > MAX_CATALOG_SEARCHES) {
                console.warn(`[Chat] Catalog search limit (${MAX_CATALOG_SEARCHES}) reached — not searching "${searchQuery}"`);
                toolUseResponse = { content: [{ type: "text", text: buildLimitHint() }] };
              } else if (isCatalogSearch && !searchQuery) {
                toolUseResponse = {
                  content: [{
                    type: "text",
                    text: JSON.stringify({
                      products: [],
                      total_count: 0,
                      _system_hint: 'No query was given. Call search_catalog with {"catalog":{"query":"<2-6 word product query or exact part number>"}}.',
                    }),
                  }],
                };
              } else if (canUseLocal && (localCatalogTool || breakerIsOpen(cf))) {
                const reason = catalogMode === "local" ? "mode_local" : breakerIsOpen(cf) ? "ucp_circuit_open" : "local_tool";
                localResult = await runLocalCatalogSearch(searchQuery, reason);
              } else {
                try {
                  toolUseResponse = await mcpClient.callTool(toolName, toolArgs);
                } catch (toolError) {
                  console.error(`[Chat] Tool call failed: ${toolName}`, toolError?.message, "args:", JSON.stringify(toolArgs));
                  toolUseResponse = { error: { type: "tool_error", message: toolError?.message, data: toolError?.message } };
                }
                if (!toolUseResponse || typeof toolUseResponse !== "object") {
                  toolUseResponse = { error: { type: "tool_error", message: "Empty tool response", data: "Empty tool response" } };
                }

                if (canUseLocal && toolUseResponse.error) {
                  const errText = errorText(toolUseResponse.error);
                  if (isUcpDiscoveryError(cf, errText)) {
                    breakerTrip(cf, ucpErrorCode(cf, errText));
                    console.warn(
                      `[Chat] UCP circuit OPEN for ${breakerInfo(cf).minutes} min (agent profile / discovery error). Fix: set UCP_AGENT_PROFILE to a reachable profile.`
                    );
                  }
                  console.warn(`[Chat] UCP catalog search failed — falling back to local search for "${searchQuery}"`);
                  localResult = await runLocalCatalogSearch(searchQuery, "ucp_error");
                }
              }

              if (localResult) {
                let hintText;
                if (localResult.products.length > 0) {
                  const shown = showProducts(localResult.products, { merge: true });
                  console.log(`[Search] Sending ${shown.length} products to frontend for: "${searchQuery}" (local)`);
                  hintText = buildStopHint(shown, {
                    lowConfidence: localResult.lowConfidence,
                    accessoryOnly: localResult.accessoryOnly,
                    searchNote: localResult.searchNote,
                  });
                } else {
                  console.log(`[Search] Zero results for: "${searchQuery}" (local)`);
                  hintText = buildZeroHint(searchQuery);
                }
                toolUseResponse = { content: [{ type: "text", text: hintText }] };
              } else if (isCatalogSearch && searchQuery && toolUseResponse && !toolUseResponse.error && catalogSearches <= MAX_CATALOG_SEARCHES) {
                // UCP path (CATALOG_TOOL_MODE=ucp, or auto with a healthy UCP).
                if (DEBUG_IMAGES) {
                  try {
                    const rawText = toolUseResponse?.content?.[0]?.text;
                    const rawData = rawText ? JSON.parse(rawText) : null;
                    const firstProduct = (rawData?.products || rawData?.items || rawData?.results || [])[0];
                    if (firstProduct) {
                      console.log(`[ImageDebug] First product keys: [${Object.keys(firstProduct).join(", ")}]`);
                      console.log(`[ImageDebug] media[0]: ${Array.isArray(firstProduct.media) && firstProduct.media[0] ? JSON.stringify(firstProduct.media[0]).substring(0, 500) : "none"}`);
                    }
                  } catch (debugErr) {
                    console.warn("[ImageDebug] Could not parse product for debug:", debugErr.message);
                  }
                }

                let products = [];
                try {
                  products = toolService.processProductSearchResult(toolUseResponse, shopDomain, userMessage, searchQuery) || [];
                } catch (e) {
                  console.warn(`[Chat] processProductSearchResult failed: ${e.message}`);
                }
                if (products.length > 0) {
                  const r = refineSafely(cf, products, searchQuery, "ucp_search");
                  const shown = showProducts(r.products.length ? r.products : products, { merge: true });
                  console.log(`[Search] Sending ${shown.length} products to frontend for: "${searchQuery}"`);
                  toolUseResponse.content = [{ type: "text", text: buildStopHint(shown, { accessoryOnly: r.accessoryOnly }) }];
                } else {
                  console.log(`[Search] Zero results for: "${searchQuery}"`);
                  toolUseResponse.content = [{ type: "text", text: buildZeroHint(searchQuery) }];
                }
              }

              if (toolName === "update_cart" && toolUseResponse && !toolUseResponse.error) {
                try {
                  const { checkoutUrl, cart } = toolService.processCartUpdateResult(toolUseResponse) || {};
                  if (checkoutUrl) send({ type: "cart_updated", checkout_url: checkoutUrl, cart });
                  else console.warn("[Chat] update_cart succeeded but no checkout URL found");
                } catch (e) {
                  console.warn(`[Chat] processCartUpdateResult failed: ${e.message}`);
                }
              }

              flushAssistant();
              if (toolUseResponse?.error) {
                const errPayload = toolUseResponse.error.data || toolUseResponse.error;
                pushToolResult({ type: "tool_result", tool_use_id: toolUseId, content: JSON.stringify({ error: errPayload }), is_error: true });
                resultPushed = true;
                send({ type: "tool_error", tool_name: toolName, error: errPayload });
              } else {
                let toolResultContent;
                try {
                  if (Array.isArray(toolUseResponse?.content)) {
                    toolResultContent =
                      toolUseResponse.content.filter((c) => c && c.type === "text" && c.text).map((c) => c.text).join("\n") || "No content returned";
                  } else if (typeof toolUseResponse?.content === "string") {
                    toolResultContent = toolUseResponse.content;
                  } else {
                    toolResultContent = JSON.stringify(toolUseResponse?.content ?? "No content returned");
                  }
                } catch (e) {
                  toolResultContent = "Tool returned data successfully";
                }
                pushToolResult({ type: "tool_result", tool_use_id: toolUseId, content: toolResultContent });
                resultPushed = true;
              }
              send({ type: "new_message" });
            } catch (handlerErr) {
              // Every tool_use MUST get a tool_result, or the next Claude call fails.
              console.error(`[Chat] onToolUse crashed for ${toolName}: ${handlerErr?.message}`);
              if (!resultPushed) {
                flushAssistant();
                pushToolResult({
                  type: "tool_result",
                  tool_use_id: toolUseId,
                  content: JSON.stringify({ error: "The tool failed. Do not retry it; answer with what you have or offer " + SALES_EMAIL + "." }),
                  is_error: true,
                });
              }
            }
          },

          onContentBlock: (contentBlock) => {
            if (contentBlock?.type === "text") send({ type: "content_block_complete", content_block: contentBlock });
          },
        }
      );

      flushAssistant();

      stopReason = finalMessage?.stop_reason ?? null;
      console.log(`[Chat] Claude call #${loopCount} done | stop_reason=${stopReason}`);

      if (stopReason !== "tool_use") {
        if (stopReason && stopReason !== "end_turn") console.warn(`[Chat] Unexpected stop_reason=${stopReason}; ending turn`);
        break;
      }
    }

    if (loopCount >= MAX_TOOL_LOOPS && stopReason === "tool_use") console.warn(`[Chat] Hit max tool loop limit (${MAX_TOOL_LOOPS})`);

    // ── Empty-reply guard: never end a turn with nothing to read ────
    if (!fullResponseText.trim()) {
      const fallback = getAdvisoryFallback();
      if (fallback) {
        console.warn("[Chat] Empty reply from Claude — sending advisory fallback");
        sendFallbackText(fallback);
      } else if (productsSentToFrontend) {
        console.warn("[Chat] Empty reply from Claude but cards are shown — sending short fallback");
        sendFallbackText(`Here are the closest matches I found — tap a card for details. For anything not listed, email ${SALES_EMAIL} and the team will help.`);
      } else {
        console.warn("[Chat] Empty reply from Claude and no products — sending generic fallback");
        sendFallbackText(`Sorry, I couldn't put a reply together just now. Please try again, or email ${SALES_EMAIL} and the team will help.`);
      }
    }

    send({ type: "end_turn" });
    console.log(`[Chat] Response complete | ${Date.now() - startTime}ms | claude_calls=${loopCount} catalog_searches=${catalogSearches}`);
  } catch (error) {
    console.error("[Chat] Error in chat session:", error?.message);
    track("errorOccurred", { conversationId, error: error?.message });

    const advisoryFallback = !fullResponseText.trim() ? getAdvisoryFallback() : "";
    if (advisoryFallback) {
      sendFallbackText(advisoryFallback);
      send({ type: "end_turn" });
    } else if (productsSentToFrontend && !fullResponseText.trim()) {
      sendFallbackText("I found several products matching your request. You can browse them above.");
      send({ type: "end_turn" });
    } else if (fullResponseText.trim()) {
      send({ type: "end_turn" });
    } else {
      send({ type: "error", error: "Failed to get response. Please try again." });
    }
  }
}

async function getCustomerAccountUrls(conversationIdOrDomain, conversationId, dbHelpers) {
  try {
    const existing = await dbHelpers.getCustomerAccountUrlsFromDb(conversationId);
    if (existing) return existing;
    if (!conversationIdOrDomain) return { mcpApiUrl: null };

    const hostname = conversationIdOrDomain.includes(".") ? conversationIdOrDomain : new URL(conversationIdOrDomain).hostname;
    const fetchWithTimeout = (url, ms = 4000) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ms);
      return fetch(url, { signal: controller.signal })
        .then((r) => r.json())
        .catch(() => ({}))
        .finally(() => clearTimeout(timer));
    };

    const [mcpResponse, openidResponse] = await Promise.all([
      fetchWithTimeout(`https://${hostname}/.well-known/customer-account-api`),
      fetchWithTimeout(`https://${hostname}/.well-known/openid-configuration`),
    ]);

    const response = {
      mcpApiUrl: mcpResponse?.mcp_api || null,
      authorizationUrl: openidResponse?.authorization_endpoint || null,
      tokenUrl: openidResponse?.token_endpoint || null,
    };

    await Promise.resolve(dbHelpers.storeCustomerAccountUrls({ conversationId, ...response })).catch((e) => console.warn("Failed to store URLs:", e));
    return response;
  } catch (error) {
    console.error("Error getting customer MCP API URL:", error);
    return { mcpApiUrl: null };
  }
}

// ─── CORS / SSE headers ────────────────────────────────────────────────

/**
 * ALLOWED_ORIGINS unset  -> legacy behaviour: reflect any Origin (with credentials).
 * ALLOWED_ORIGINS set    -> only listed hostnames (and their subdomains) get CORS headers.
 */
function isOriginAllowed(origin) {
  const list = String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (list.length === 0) return true;
  const host = safeHostname(origin)?.toLowerCase();
  return !!host && list.some((h) => host === h || host.endsWith(`.${h}`));
}

function corsOriginHeaders(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return { "Access-Control-Allow-Origin": "*" };
  if (!isOriginAllowed(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
}

function getCorsHeaders(request) {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, X-Shopify-Shop-Id",
    "Access-Control-Max-Age": "86400",
    ...corsOriginHeaders(request),
  };
}

function getSseHeaders(request) {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, X-Shopify-Shop-Id",
    ...corsOriginHeaders(request),
  };
}
