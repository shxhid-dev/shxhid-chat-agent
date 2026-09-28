// app/routes/chat.jsx
/**
 * Chat API Route — v2.4
 *
 * CHANGES (v2.4 — Sep 28, 2026):
 *   ADVISORY MODE (general enquiries — "suggest the right sensor for ...", "solution for ...")
 *   - services/advisory.server.js identifies advice / troubleshooting enquiries, extracts what the
 *     customer already said, picks <=3 clarifying questions, computes engineering numbers, and builds
 *     an [ADVISORY BRIEF] that is placed in the LAST user message (in memory only, never saved).
 *   - The search pre-pass uses the advisory query (e.g. "inductive proximity sensor 8 mm" for a 5 mm
 *     gap) so product cards agree with the advice; it is skipped when no product query fits yet.
 *   - The SYSTEM NOTE, the tool "stop" hint and the zero-result hint no longer force a 1-3 sentence
 *     reply while advisory mode is active.
 *   - If Claude fails or returns nothing, a deterministic advisory fallback is streamed instead.
 *   - Kill switch: ADVISORY_MODE=off.
 *
 *   FIXES / HANDLING
 *   - SKU detector: IP ratings ("IP69K", "IP67/IP69K") and supply specs ("24V-DC", "12-24VDC")
 *     are no longer treated as product codes.
 *   - Stored history: JSON.parse result is only accepted if it is an array of content blocks, so
 *     messages like "123" or "true" no longer break turn order (they caused duplicate user turns).
 *   - History sent to Claude is capped (CHAT_MAX_HISTORY, default 12) and always starts on a user turn.
 *   - Tool loop continues only on stop_reason "tool_use" (was: anything but "end_turn").
 *   - Empty-reply guard: if Claude streams no text, the user still gets an answer.
 *   - Request validation: invalid JSON -> 400, non-string / empty message -> 400, message length cap
 *     (CHAT_MAX_MESSAGE_CHARS, default 4000), conversation_id sanitised, safe Origin parsing
 *     (Origin: "null" used to throw a 500).
 *   - MCP servers connect in parallel, one failing server no longer blocks the others, and per-server
 *     tool counts are logged. Kill switch: MCP_PARALLEL_CONNECT=0.
 *
 *   OPT-IN HARDENING (defaults keep today's behaviour)
 *   - APP_PROXY_SIGNATURE_MODE = off | log | enforce   (verifies Shopify app-proxy HMAC signature)
 *   - ALLOWED_ORIGINS = comma-separated hostnames       (CORS allowlist; unset = reflect any origin)
 *
 * CHANGES (v2.3 — May 1, 2026):
 *   - extractSearchQuery() now supports both schemas (primary fix):
 *       Old search_shop_catalog: { query: "..." }
 *       New search_catalog:      { catalog: { query: "..." } }
 *     NEVER falls back to JSON.stringify(toolArgs) — that breaks the relevance gate.
 *   - Added [ImageDebug] log that prints the RAW image fields of the first product
 *     returned by MCP, so the exact field paths are visible in production logs.
 *   - Added catalog tool input_schema keys log on connect for diagnostics.
 *
 * CHANGES (v2.2 — May 2026):
 *   - Same extractSearchQuery fix (first attempt, corrected in v2.3)
 *   - Fallback searches now use extractSearchQuery instead of raw JSON
 *
 * CHANGES (v2.1 — April 2026):
 *   - Accept both legacy search_shop_catalog and current search_catalog
 *   - Fallback drops 'context' param that caused "Invalid params" on new tool
 */

// Pre-search paths whose results may be off-target. For these the catalog
// search tool stays available so Claude can recover / be honest.
const LOW_CONFIDENCE_PATHS = new Set([
  'sku_storefront_fallback',
  'sku_nosep_fallback',
  'storefront_search_last_resort',
  'algolia_search_weak',      // relevance floor judged hits off-target
  'algolia_brand_missing',    // customer asked for a brand we don't carry
]);

const CATALOG_SEARCH_TOOL_NAMES = new Set([
  "search_shop_catalog",
  "search_catalog",
  "search_products",
]);

function isCatalogSearchTool(toolName) {
  return CATALOG_SEARCH_TOOL_NAMES.has(String(toolName || "").toLowerCase());
}

// ─── v2.4 tunables (all optional env vars) ─────────────────────────────
function intEnv(name, fallback) {
  const n = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const MAX_MESSAGE_CHARS = intEnv("CHAT_MAX_MESSAGE_CHARS", 4000);
const MAX_HISTORY_MESSAGES = intEnv("CHAT_MAX_HISTORY", 12);
const ADVISORY_ENABLED = String(process.env.ADVISORY_MODE || "on").toLowerCase() !== "off";

/**
 * Extract the plain-text query string from catalog search tool args.
 *
 * Shopify's Storefront MCP changed its schema in April 2026:
 *   search_shop_catalog (old): { query: "solenoid valve" }
 *   search_catalog (new/UCP):  { catalog: { query: "solenoid valve" } }
 *
 * CRITICAL: NEVER fall back to JSON.stringify(toolArgs).
 * That produces strings like '{"catalog":{"query":"..."}}' which the
 * distinctive-token gate tokenizes to ["catalog","query"] — words that
 * never appear in product text — dropping ALL results.
 */
function extractSearchQuery(toolArgs) {
  if (!toolArgs) return null;

  // New UCP schema: { catalog: { query: "..." } }
  if (toolArgs?.catalog?.query && typeof toolArgs.catalog.query === "string") {
    return toolArgs.catalog.query.trim() || null;
  }

  // Legacy schema: { query: "..." }
  if (toolArgs?.query && typeof toolArgs.query === "string") {
    return toolArgs.query.trim() || null;
  }

  // Other possible field names
  if (toolArgs?.searchQuery && typeof toolArgs.searchQuery === "string") {
    return toolArgs.searchQuery.trim() || null;
  }
  if (toolArgs?.q && typeof toolArgs.q === "string") {
    return toolArgs.q.trim() || null;
  }

  // If toolArgs is itself a string
  if (typeof toolArgs === "string") {
    return toolArgs.trim() || null;
  }

  // NEVER JSON.stringify
  return null;
}

// ─── Small helpers (v2.4) ──────────────────────────────────────────────

function safeHostname(urlLike) {
  try {
    return urlLike ? new URL(urlLike).hostname : null;
  } catch (e) {
    return null; // e.g. Origin: "null" from sandboxed iframes
  }
}

function normalizeConversationId(id) {
  if (typeof id === "string" && /^[\w.\-:]{1,128}$/.test(id)) return id;
  const uuid = globalThis.crypto?.randomUUID?.();
  return `conv_${uuid || Date.now()}`;
}

/**
 * Stored message content is plain text. Only treat it as structured content if it parses to an
 * array of content blocks; otherwise "123", "true" or "null" would become numbers/booleans and
 * break the "last message is the current user message" check.
 */
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

/**
 * Detect SKU-like tokens in a user message.
 * Returns an array of probable SKU strings found (uppercase, digits+letters, with separators).
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
    // Skip pure electrical/spec tokens: "24VDC", "18MM", "24V", "100A", "5W"
    if (/^\d+(?:MM|CM|VDC|VAC|V|A|W|KW|HP)$/i.test(token)) continue;
    // Skip dimension+unit tokens: "2INCH", "2IN", "3FT", "4FEET" — these are
    // measurements, not product codes. They are handled by the inch-dimension gate.
    if (/^\d+(?:\.\d+)?(?:INCH|INCHES|IN|FT|FEET|FOOT|KM)$/i.test(token)) continue;
    // Skip thread/pipe-standard tokens used as dimensions: "38NPT", "12BSP"
    if (/^\d+(?:NPT|BSP|BSPP|BSPT)$/i.test(token)) continue;
    // v2.4: skip ingress-protection ratings ("IP69K", "IP67/IP69K") and supply specs
    // ("24V-DC", "DC24V", "12-24VDC", "10-30V") — specs, not product codes.
    if (/^IP\d{2}K?(?:[-\/]IP\d{2}K?)*$/i.test(token)) continue;
    if (/^\d+(?:\.\d+)?V[-\/]?(?:DC|AC)$/i.test(token)) continue;
    if (/^(?:DC|AC)[-\/]?\d+(?:\.\d+)?V?$/i.test(token)) continue;
    if (/^\d+(?:\.\d+)?[-\/]\d+(?:\.\d+)?V(?:DC|AC)?$/i.test(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    matches.push(token);
  }
  return matches;
}

/**
 * Connect to the three MCP servers. Runs in parallel by default (saves ~1 s per message) and one
 * failing server no longer stops the others from connecting. MCP_PARALLEL_CONNECT=0 restores the
 * old one-after-another behaviour.
 */
async function connectMcpServers(mcpClient) {
  const jobs = [
    // Catalog search now lives on /api/ucp/mcp, not /api/mcp.
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

// ─── Opt-in hardening (v2.4) ───────────────────────────────────────────

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

/**
 * APP_PROXY_SIGNATURE_MODE: "off" (default) | "log" (report, never block) | "enforce" (401).
 * Roll out as off -> log -> enforce once the logs show no legitimate failures.
 */
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
    return handleHistoryRequest(request, url.searchParams.get("conversation_id"));
  }

  if (url.searchParams.has("stream") || request.headers.get("Accept")?.includes("text/event-stream")) {
    const sig = await checkAppProxySignature(request);
    if (!sig.allowed) return unauthorizedResponse(request);
    return handleChatRequest(request);
  }

  return new Response(
    JSON.stringify({ status: "ok", message: "Chat API is running" }),
    { status: 200, headers: getCorsHeaders(request) }
  );
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

    const cleanedMessages = messages.map((msg) => {
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
      headers: { ...getCorsHeaders(request), "Content-Type": "application/json" }
    });
  } catch (error) {
    console.error("Error fetching history:", error);
    return new Response(JSON.stringify({ messages: [], error: error.message }), {
      status: 500,
      headers: { ...getCorsHeaders(request), "Content-Type": "application/json" }
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
    const promptType = body.prompt_type || "standardAssistant";

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
    try { ChatEvents.messageSent(trackingId, { conversationId, shopDomain, messageLength: userMessage.length }); } catch (e) {}

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
    return new Response(JSON.stringify({ error: "Internal server error", message: error.message }), {
      status: 500, headers: getCorsHeaders(request)
    });
  }
}

async function handleChatSession({ request, userMessage, conversationId, promptType, stream, visitorId, fingerprintId, shopDomain, helpers }) {
  const startTime = Date.now();
  const MAX_TOOL_LOOPS = 6;

  const { saveMessage, getConversationHistory, getCustomerAccountUrlsFromDb, storeCustomerAccountUrls, ChatEvents, createClaudeService, createToolService, MCPClient } = helpers;

  stream.sendMessage({ type: "id", conversation_id: conversationId });
  console.log(`[Chat] New request | conversation=${conversationId} | shop=${shopDomain}`);

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("[Chat] ANTHROPIC_API_KEY missing");
    stream.sendMessage({ type: "error", error: "Anthropic API key not configured." });
    return;
  }

  const claudeService = createClaudeService();
  const toolService = createToolService();

  let mcpApiUrl = null;
  try {
    const urlResult = await Promise.race([
      getCustomerAccountUrls(shopDomain, conversationId, { getCustomerAccountUrlsFromDb, storeCustomerAccountUrls }),
      new Promise((resolve) => setTimeout(() => resolve({ mcpApiUrl: null }), 5000)),
    ]);
    mcpApiUrl = urlResult.mcpApiUrl;
  } catch (e) { console.warn("[Chat] Failed to get customer account URLs:", e.message); }

  const mcpClient = new MCPClient(shopDomain, conversationId, null, mcpApiUrl);

  // Hoisted so the catch block can see them (advisory fallback / empty-reply checks).
  let productsSentToFrontend = false;
  let advisory = null;      // result of analyzeEnquiry(), or null for normal enquiries
  let advisoryMod = null;   // services/advisory.server.js
  let fullResponseText = "";

  const getAdvisoryFallback = () => {
    try {
      return advisory && advisoryMod?.buildAdvisoryFallback ? advisoryMod.buildAdvisoryFallback(advisory) : "";
    } catch (e) { return ""; }
  };

  const sendFallbackText = (text) => {
    fullResponseText += text;
    stream.sendMessage({ type: "chunk", chunk: text });
    stream.sendMessage({ type: "message_complete" });
    saveMessage(conversationId, "assistant", text, { contentType: "TEXT", responseTimeMs: Date.now() - startTime, shopDomain, visitorId })
      .catch((err) => console.error("[Chat] Error saving fallback message:", err.message));
  };

  try {
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
      const allMcpTools = [...ucpMcpTools, ...storefrontMcpTools, ...customerMcpTools];
      console.log(`Connected to MCP: ${allMcpTools.length} tools`);

      const catalogTool = allMcpTools.find((t) => isCatalogSearchTool(t.name));
      if (catalogTool) {
        console.log(`[Chat] MCP catalog-search tool: "${catalogTool.name}"`);
        console.log(`[Chat] catalog tool input_schema keys: [${Object.keys(catalogTool.input_schema?.properties || {}).join(", ")}]`);
      } else {
        console.warn(`[Chat] WARNING: No catalog-search tool found. Available: ${allMcpTools.map((t) => t.name).join(", ")}`);
      }
    } catch (error) {
      console.warn("[Chat] MCP connection failed:", error.message);
    }

    try { await saveMessage(conversationId, "user", userMessage, { shopDomain, visitorId }); } catch (dbError) {
      console.error("[Chat] Failed to save user message:", dbError.message);
    }

    let conversationHistory = [];
    try {
      const dbMessages = await getConversationHistory(conversationId);
      conversationHistory = dbMessages.map((dbMessage) => ({
        role: dbMessage.role,
        content: parseStoredContent(dbMessage.content),
      }));
    } catch (historyError) { console.error("[Chat] Failed to get history:", historyError.message); }

    const lastMsg = conversationHistory[conversationHistory.length - 1];
    if (!lastMsg || lastMsg.role !== "user" || lastMsg.content !== userMessage) {
      conversationHistory.push({ role: "user", content: userMessage });
    }

    const detectedSkus = detectSkuTokens(userMessage);

    // ───────────────────────────────────────────────────────────────────
    // ADVISORY ANALYSIS (v2.4)
    // Runs on the raw history BEFORE any annotation. Messages that contain a
    // product code are never advisory: the SKU path below stays exactly as is.
    // Any failure here just means "normal enquiry".
    // ───────────────────────────────────────────────────────────────────
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

    // SKU annotation: if the user message contains a product code / SKU, prepend
    // an explicit instruction so Claude searches the exact code first — not a
    // generic category. This annotation only goes to Claude; DB stores the original.
    if (detectedSkus.length > 0) {
      const skuList = detectedSkus.slice(0, 3).join('", "');
      const annotation = `[SYSTEM: The user's message contains product code(s): "${skuList}". MANDATORY: Your FIRST search query MUST be the exact code "${detectedSkus[0]}" — no category words, no brand name, no dimensions added. Only broaden the search if the exact code returns zero results.]`;
      const lastIdx = conversationHistory.length - 1;
      if (conversationHistory[lastIdx]?.role === "user" && typeof conversationHistory[lastIdx].content === "string") {
        conversationHistory[lastIdx] = { role: "user", content: `${annotation}\n\n${conversationHistory[lastIdx].content}` };
      }
      console.log(`[Chat] SKU annotation injected: ${detectedSkus.join(", ")}`);
    }

    // ───────────────────────────────────────────────────────────────────
    // SMART SEARCH PRE-PASS (v4.2)
    // For brand-only / brand+category / SKU queries, run a deterministic
    // Admin-API search BEFORE handing off to Claude/MCP. This bypasses the
    // MCP search_catalog brand-recall problem (results lack a vendor field
    // and the MCP search drops mismatched brands), giving the user the
    // full vendor catalog when they ask for "ABB", "Siemens relays", etc.
    // For free-text queries this returns null and the existing MCP flow
    // runs unchanged.
    //
    // v2.4: for advisory enquiries the pre-pass searches the ADVICE
    // (advisory.searchQuery, e.g. "inductive proximity sensor 8 mm"), and is
    // skipped entirely when no product query fits yet (troubleshooting,
    // unknown target material...).
    // ───────────────────────────────────────────────────────────────────
    let smartResult = null;
    let systemNote = null;

    if (advisory?.skipPreSearch) {
      console.log("[Chat] Advisory: search pre-pass skipped (no product query fits this enquiry yet)");
    } else {
      try {
        const { smartSearch } = await import("../services/search-router.server.js");
        // Pass conversation history so query intelligence can use context
        // (e.g., "which ones have 4mm range?" uses context "user asked about IFM sensors")
        const historyForSearch = conversationHistory.slice(-6); // last 3 turns
        const searchInput = advisory?.searchQuery || userMessage;
        if (advisory?.searchQuery) {
          console.log(`[Chat] Advisory search query: "${advisory.searchQuery}" (customer wrote: "${userMessage.slice(0, 80)}")`);
        }
        const smart = await smartSearch(searchInput, shopDomain, historyForSearch);
        if (smart && Array.isArray(smart.products) && smart.products.length > 0) {
          smartResult = smart;
          console.log(`[Chat] SmartSearch pre-found ${smart.products.length} products (${smart.searchType})`);
          stream.sendMessage({ type: "product_results", products: smart.products });
          productsSentToFrontend = true;

          const summary = smart.products.slice(0, 8).map((p) => ({
            title: p.title,
            vendor: p.vendor,
            price: p.price,
            sku: p.sku,
          }));
          const isLowConfidence = LOW_CONFIDENCE_PATHS.has(smart.searchType);
          const replyInstruction = advisory
            ? `An [ADVISORY BRIEF] follows below: its REPLY FORMAT overrides the 1-3 sentence limit for this reply. `
            : `Write ONE short conversational reply (1-3 sentences). `;
          systemNote =
            `[SYSTEM NOTE — NOT FROM USER] Products have already been pre-found for this query and product cards are ALREADY DISPLAYED. ` +
            `${smart.systemHint} ` +
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

    // Compose what Claude sees for the last user turn: SYSTEM NOTE first (the system prompt's
    // Step 1 keys off that literal prefix), then the ADVISORY BRIEF, then the customer's message.
    // With neither, the message is left untouched. Nothing here is saved to the DB.
    let advisoryBrief = "";
    if (advisory && advisoryMod) {
      try { advisoryBrief = advisoryMod.buildAdvisoryBrief(advisory); } catch (e) {
        console.warn(`[Chat] buildAdvisoryBrief failed: ${e.message}`);
      }
    }
    if (systemNote || advisoryBrief) {
      const lastIdx = conversationHistory.length - 1;
      if (
        conversationHistory[lastIdx]?.role === "user" &&
        typeof conversationHistory[lastIdx].content === "string"
      ) {
        conversationHistory[lastIdx] = {
          role: "user",
          content: [systemNote, advisoryBrief, `User message: ${conversationHistory[lastIdx].content}`]
            .filter(Boolean)
            .join("\n\n"),
        };
      }
    }

    // Strip catalog-search tools when smartSearch already found products via
    // a HIGH-CONFIDENCE path. For LOW-CONFIDENCE paths (broad Storefront
    // fallback, SKU-fuzzy fallbacks) we keep the catalog tools so Claude can
    // re-search and recover if the pre-found results are off-target.
    if (productsSentToFrontend) {
      if (smartResult && LOW_CONFIDENCE_PATHS.has(smartResult.searchType)) {
        console.log(
          `[Chat] Products pre-found via LOW-CONFIDENCE path (${smartResult.searchType}) — ` +
          `keeping catalog tools available so Claude can recover.`
        );
      } else {
        const before = mcpClient.tools.length;
        mcpClient.storefrontTools = (mcpClient.storefrontTools || [])
          .filter(t => !isCatalogSearchTool(t.name));
        // Catalog search is advertised by the UCP server now, so it must be
        // removed there as well or callTool would still route to it.
        mcpClient.ucpTools = (mcpClient.ucpTools || [])
          .filter(t => !isCatalogSearchTool(t.name));
        mcpClient.tools = (mcpClient.tools || [])
          .filter(t => !isCatalogSearchTool(t.name));
        console.log(
          `[Chat] Products pre-found via HIGH-CONFIDENCE path (${smartResult?.searchType || 'unknown'}) — ` +
          `stripped catalog tools (${before} → ${mcpClient.tools.length} tools).`
        );
      }
    }

    // v2.4: cap what is sent to Claude (cost + latency). Advisory analysis above already used the
    // full history; the last message (with any SYSTEM NOTE / brief) is always kept.
    if (conversationHistory.length > MAX_HISTORY_MESSAGES) {
      const before = conversationHistory.length;
      conversationHistory = capHistory(conversationHistory, MAX_HISTORY_MESSAGES);
      console.log(`[Chat] History capped ${before} → ${conversationHistory.length} messages`);
    }

    let finalMessage = null;
    let stopReason = null;
    let currentAssistantMessage = null;
    let loopCount = 0;

    while (loopCount < MAX_TOOL_LOOPS) {
      loopCount++;
      currentAssistantMessage = null;
      console.log(`[Chat] Claude call #${loopCount} | history=${conversationHistory.length} messages`);

      finalMessage = await claudeService.streamConversation(
        { messages: conversationHistory, promptType, tools: mcpClient.tools },
        {
          onText: (textDelta) => {
            fullResponseText += textDelta;
            stream.sendMessage({ type: "chunk", chunk: textDelta });
          },

          onMessage: async (message) => {
            currentAssistantMessage = message;
            let textContent = "";
            if (Array.isArray(message.content)) {
              textContent = message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n\n");
            } else { textContent = message.content; }

            const responseTime = Date.now() - startTime;
            if (textContent.trim()) {
              saveMessage(conversationId, message.role, textContent, { contentType: "TEXT", responseTimeMs: responseTime, shopDomain, visitorId })
                .catch((err) => console.error("[Chat] Error saving assistant message:", err.message));
            }

            const trackingId = visitorId || fingerprintId || conversationId;
            try { ChatEvents.messageReceived(trackingId, { conversationId, responseTimeMs: responseTime, contentLength: textContent.length }); } catch (e) {}
            stream.sendMessage({ type: "message_complete" });
          },

          onToolUse: async (content) => {
            const toolName = content.name;
            const toolArgs = content.input;
            const toolUseId = content.id;

            console.log(`[Chat] Tool use: ${toolName} (id=${toolUseId})`);

            const thinkingStates = {
              "search_shop_catalog": "Searching products...",
              "search_catalog": "Searching products...",
              "search_products": "Searching products...",
              "update_cart": "Adding to cart...",
              "get_cart": "Checking availability...",
              "get_product": "Looking up product...",
              "get_product_details": "Looking up product details...",
            };
            stream.sendMessage({ type: "thinking_state", state: thinkingStates[toolName] || "Thinking..." });
            stream.sendMessage({ type: "tool_use", tool_name: toolName });

            const trackingId = visitorId || fingerprintId || conversationId;
            try { ChatEvents.toolCalled(trackingId, { conversationId, toolName, toolArgs }); } catch (e) {}

            let toolUseResponse;
            try {
              toolUseResponse = await mcpClient.callTool(toolName, toolArgs);
            } catch (toolError) {
              console.error(`[Chat] Tool call failed: ${toolName}`, toolError.message, "args:", JSON.stringify(toolArgs));
              toolUseResponse = { error: { type: "tool_error", message: toolError.message, data: toolError.message } };
            }

            const isCatalogSearch = isCatalogSearchTool(toolName);

            if (isCatalogSearch && !toolUseResponse.error) {
              // =====================================================================
              // v2.3 CRITICAL FIX: Extract real query from toolArgs, never JSON.stringify
              // search_catalog UCP schema: { catalog: { query: "..." } }
              // search_shop_catalog old schema: { query: "..." }
              // =====================================================================
              const searchQuery = extractSearchQuery(toolArgs);

              if (!searchQuery) {
                console.warn(`[Chat] Could not extract searchQuery from toolArgs: ${JSON.stringify(toolArgs)}`);
              } else {
                console.log(`[Chat] Extracted searchQuery: "${searchQuery}"`);
              }

              // =====================================================================
              // v2.3 IMAGE DEBUG: Log raw product fields from MCP response
              // This tells us exactly what image field paths the MCP actually returns
              // so we can fix extractImageUrl() with the correct field name
              // =====================================================================
              try {
                const rawText = toolUseResponse?.content?.[0]?.text;
                if (rawText) {
                  const rawData = JSON.parse(rawText);
                  const firstProduct = (rawData?.products || rawData?.items || rawData?.results || [])[0];
                  if (firstProduct) {
                    // v4.0: Log FULL media[0] object to confirm image field path
                    const media0 = Array.isArray(firstProduct.media) && firstProduct.media[0]
                      ? JSON.stringify(firstProduct.media[0]).substring(0, 500)
                      : "none";
                    console.log(`[ImageDebug] First product keys: [${Object.keys(firstProduct).join(", ")}]`);
                    console.log(`[ImageDebug] media[0] FULL: ${media0}`);
                    console.log(`[ImageDebug] image_url: ${firstProduct.image_url || "absent"}`);
                    console.log(`[ImageDebug] featured_image: ${typeof firstProduct.featured_image === 'object' ? JSON.stringify(firstProduct.featured_image) : (firstProduct.featured_image || "absent")}`);
                  }
                }
              } catch (debugErr) {
                console.warn("[ImageDebug] Could not parse product for debug:", debugErr.message);
              }

              const products = toolService.processProductSearchResult(toolUseResponse, shopDomain, userMessage, searchQuery);

              if (products && products.length > 0) {
                console.log(`[Search] Sending ${products.length} products to frontend for: "${searchQuery}"`);
                stream.sendMessage({ type: "product_results", products });
                productsSentToFrontend = true;

                // Inject a clear "stop searching" signal so Claude doesn't retry.
                const stopHint = JSON.stringify({
                  products: products.slice(0, 3).map((p) => ({ id: p.id, title: p.title, sku: p.sku || null, price: p.price || null })),
                  total_count: products.length,
                  _display_note: advisory
                    ? `${products.length} product card(s) are now displayed to the user. Do NOT search again. Now write your reply in the REPLY FORMAT from the ADVISORY BRIEF (it overrides the one-short-response rule).`
                    : `${products.length} product card(s) are now displayed to the user. Do NOT search again. Write one short response acknowledging the results.`,
                });
                if (!Array.isArray(toolUseResponse.content)) toolUseResponse.content = [];
                toolUseResponse.content = [{ type: "text", text: stopHint }];
              } else {
                console.log(`[Search] Zero results for: "${searchQuery}"`);
                const retryHint = JSON.stringify({
                  products: [], total_count: 0,
                  _system_hint: advisory
                    ? `Zero products found for "${searchQuery}". Do NOT search again. Write your reply in the REPLY FORMAT from the ADVISORY BRIEF, say no matching products were found in the catalogue for now, and offer websales@creativeautomation.ae.`
                    : `Zero products found for "${searchQuery}". Try a simpler query (2-3 words). If still zero after 2 attempts, tell the user the product may not be in our catalog and offer websales@creativeautomation.ae`,
                });
                if (!Array.isArray(toolUseResponse.content)) toolUseResponse.content = [];
                toolUseResponse.content = [{ type: "text", text: retryHint }];
              }
            }

            if (toolName === "update_cart" && !toolUseResponse.error) {
              const { processCartUpdateResult } = toolService;
              const { checkoutUrl, cart } = processCartUpdateResult(toolUseResponse);
              if (checkoutUrl) {
                stream.sendMessage({ type: "cart_updated", checkout_url: checkoutUrl, cart });
              } else {
                console.warn("[Chat] update_cart succeeded but no checkout URL found");
              }
            }

            if (currentAssistantMessage) {
              conversationHistory.push({ role: currentAssistantMessage.role, content: currentAssistantMessage.content });
              currentAssistantMessage = null;
            }

            if (toolUseResponse.error) {
              conversationHistory.push({
                role: "user",
                content: [{ type: "tool_result", tool_use_id: toolUseId, content: JSON.stringify({ error: toolUseResponse.error.data || toolUseResponse.error }), is_error: true }],
              });
              stream.sendMessage({ type: "tool_error", tool_name: toolName, error: toolUseResponse.error.data || toolUseResponse.error });
            } else {
              let toolResultContent;
              try {
                if (Array.isArray(toolUseResponse.content)) {
                  toolResultContent = toolUseResponse.content.filter((c) => c && c.type === "text" && c.text).map((c) => c.text).join("\n") || "No content returned";
                } else if (typeof toolUseResponse.content === "string") {
                  toolResultContent = toolUseResponse.content;
                } else {
                  toolResultContent = JSON.stringify(toolUseResponse.content ?? "No content returned");
                }
              } catch (e) { toolResultContent = "Tool returned data successfully"; }

              conversationHistory.push({ role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: toolResultContent }] });
            }

            stream.sendMessage({ type: "new_message" });
          },

          onContentBlock: (contentBlock) => {
            if (contentBlock.type === "text") {
              stream.sendMessage({ type: "content_block_complete", content_block: contentBlock });
            }
          },
        }
      );

      if (currentAssistantMessage) {
        conversationHistory.push({ role: currentAssistantMessage.role, content: currentAssistantMessage.content });
        currentAssistantMessage = null;
      }

      stopReason = finalMessage?.stop_reason ?? null;
      console.log(`[Chat] Claude call #${loopCount} done | stop_reason=${stopReason}`);

      // Only a tool call means "go round again". end_turn ends the turn; anything else
      // (max_tokens, refusal...) used to re-call Claude up to 6 times.
      if (stopReason !== "tool_use") {
        if (stopReason && stopReason !== "end_turn") console.warn(`[Chat] Unexpected stop_reason=${stopReason}; ending turn`);
        break;
      }
    }

    if (loopCount >= MAX_TOOL_LOOPS && stopReason === "tool_use") console.warn(`[Chat] Hit max tool loop limit (${MAX_TOOL_LOOPS})`);

    // Empty-reply guard: never end a turn with nothing to read.
    if (!fullResponseText.trim()) {
      const fallback = getAdvisoryFallback();
      if (fallback) {
        console.warn("[Chat] Empty reply from Claude — sending advisory fallback");
        sendFallbackText(fallback);
      } else if (!productsSentToFrontend) {
        console.warn("[Chat] Empty reply from Claude and no products — sending generic fallback");
        sendFallbackText("Sorry, I couldn't put a reply together just now. Please try again, or email websales@creativeautomation.ae and the team will help.");
      }
    }

    stream.sendMessage({ type: "end_turn" });
    console.log(`[Chat] Response complete | ${Date.now() - startTime}ms`);

  } catch (error) {
    console.error("[Chat] Error in chat session:", error.message);
    const trackingId = visitorId || fingerprintId || conversationId;
    try { ChatEvents.errorOccurred(trackingId, { conversationId, error: error.message }); } catch (e) {}

    // v2.4: for advisory enquiries the customer still gets the computed guidance.
    const advisoryFallback = !fullResponseText.trim() ? getAdvisoryFallback() : "";
    if (advisoryFallback) {
      sendFallbackText(advisoryFallback);
      stream.sendMessage({ type: "end_turn" });
    } else if (productsSentToFrontend) {
      stream.sendMessage({ type: "chunk", chunk: "I found several products matching your request. You can browse them above." });
      stream.sendMessage({ type: "message_complete" });
      stream.sendMessage({ type: "end_turn" });
    } else {
      stream.sendMessage({ type: "error", error: "Failed to get response. Please try again." });
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
      return fetch(url, { signal: controller.signal }).then((r) => { clearTimeout(timer); return r.json(); }).catch(() => ({}));
    };

    const [mcpResponse, openidResponse] = await Promise.all([
      fetchWithTimeout(`https://${hostname}/.well-known/customer-account-api`),
      fetchWithTimeout(`https://${hostname}/.well-known/openid-configuration`),
    ]);

    const response = {
      mcpApiUrl: mcpResponse.mcp_api || null,
      authorizationUrl: openidResponse.authorization_endpoint || null,
      tokenUrl: openidResponse.token_endpoint || null,
    };

    await dbHelpers.storeCustomerAccountUrls({ conversationId, ...response }).catch((e) => console.warn("Failed to store URLs:", e));
    return response;
  } catch (error) {
    console.error("Error getting customer MCP API URL:", error);
    return { mcpApiUrl: null };
  }
}

// ─── CORS / SSE headers ────────────────────────────────────────────────

/**
 * ALLOWED_ORIGINS unset  -> legacy behaviour: reflect any Origin (with credentials).
 * ALLOWED_ORIGINS set    -> only listed hostnames (and their subdomains) get CORS headers,
 *                           e.g. ALLOWED_ORIGINS=creativeautomation.ae,nfejky-ge.myshopify.com
 * The storefront reaches this route through the same-origin app proxy, so CORS is only needed
 * for direct calls (e.g. a backend_url override).
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
