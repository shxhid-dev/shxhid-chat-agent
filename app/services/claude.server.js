// app/services/claude.server.js
/**
 * Claude Service — v5.1 (12 Nov 2026)
 *
 * CHANGES (v5.1):
 *   - max_tokens 4096 → 16000 (thinking counts toward it; long replies were cut off).
 *   - Prompt caching on the system prompt + tools, and output_config.effort (CHAT_EFFORT,
 *     default medium). Retried once without them if the API rejects them.
 *   - Tools sent sorted and de-duplicated (stable cache prefix; no duplicate-name 400s).
 *   - Tool calls run only on stop_reason "tool_use"; the call is cancelled when the shopper leaves.
 *   - Usage (incl. cache reads) logged per call.
 *
 * CHANGES (v5.0):
 *   - creativeAutomationAssistant rewritten as "TIA": grounding rules first (every product fact
 *     from tool data / pre-found summary / "[[Cards shown: …]]" notes), one clarifying question
 *     instead of guessing, may name the best 1-2 matches, one retry policy (the old prompt said
 *     both "retry once" and "do not retry"), PHOTO ANALYSIS notes explained.
 *   - B2B prompt: same single-retry rule.
 *
 * CHANGES (v4.1 — May 2026):
 *
 * FIX 1: Model string corrected.
 *   Was:  "claude-haiku-4-5"         ← INVALID, caused silent API errors
 *   Now:  "claude-haiku-4-5-20251001" ← correct versioned model string
 *
 * FIX 2: System prompt updated with stronger rules for size-based queries.
 *   Added explicit guidance that pipe sizes, pump sizes, and valve configs
 *   (1/4 inch, 1/2 inch, 5/2 way) are PRODUCT DESIGNATIONS and must be
 *   preserved in search context — they are NOT specs to strip.
 *
 * PREVIOUS CHANGES:
 * v4.0 (May 7, 2026): RULE 15/16 for zero-result handling
 * v3.0 (April 30, 2026): Multilingual, clarification handling
 */
import Anthropic from "@anthropic-ai/sdk";

// Effort for the chat model: "low" | "medium" | "high". "off" sends neither effort nor
// caching (the pre-v5.1 request). Medium keeps tool use accurate with a shorter pause
// than the model's default (high).
const CHAT_EFFORT = (() => {
  const v = String(process.env.CHAT_EFFORT || "medium").trim().toLowerCase();
  return ["low", "medium", "high", "off"].includes(v) ? v : "medium";
})();
// Turned off for the rest of the process if the API ever rejects the extras.
let useExtras = CHAT_EFFORT !== "off";

/**
 * Tools in a fixed order with unique names. MCP servers connect in parallel and append in
 * whatever order they answer, which changed the cached prefix on every request; a duplicate
 * name (a late MCP connect next to the local search_catalog) makes the API return a 400.
 */
function sortedUniqueTools(tools) {
  const byName = new Map();
  for (const t of Array.isArray(tools) ? tools : []) {
    if (t?.name && !byName.has(t.name)) byName.set(t.name, t);
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function createClaudeService() {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY not found in environment variables");
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }

  const client = new Anthropic({ apiKey });

  return {
    async streamConversation(config, callbacks) {
      const { messages, promptType = "standardAssistant", tools = [], signal = null } = config;
      const { onText, onMessage, onToolUse, onContentBlock } = callbacks;

      try {
        const systemPrompt = getSystemPrompt(promptType);

        // Model: claude-sonnet-5.
        // Sonnet (not Haiku) is intentional here. The chat orchestrates
        // multi-step tool use (MCP catalog search, cart updates) and must
        // recover from low-confidence search results (e.g. wrong-category
        // hits) by deciding whether to re-search or apologise. Haiku
        // shipped briefly and regressed on tool-call accuracy and on
        // following the multi-section system prompt — do NOT downgrade
        // without re-running the search QA suite.
        // Query-rewriting (query-intelligence.server.js) deliberately uses
        // Haiku — that task is single-shot and ~20-token output, where
        // Haiku's latency/cost wins matter and Sonnet wouldn't help.
        const baseParams = {
          model: "claude-sonnet-5",
          // Thinking tokens count toward this cap; 4096 cut long advisory replies short.
          max_tokens: 16000,
          system: systemPrompt,
          messages,
          stream: true,
        };

        const toolList = sortedUniqueTools(tools);
        if (toolList.length > 0) baseParams.tools = toolList;

        // Optional extras: prompt caching (the system prompt + ~17 tool schemas are re-sent on
        // every call, up to 6 per turn) and a lower effort (shorter silent pause before the
        // first word). If the API ever rejects them, the call is retried once without them.
        const apiParams = useExtras
          ? {
              ...baseParams,
              system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
              cache_control: { type: "ephemeral" },
              output_config: { effort: CHAT_EFFORT },
            }
          : baseParams;

        console.log(`[Claude] Calling API | model=${apiParams.model} | messages=${messages.length} | tools=${toolList.length}${useExtras ? ` | effort=${CHAT_EFFORT}` : ""}`);

        let streamedText = false;
        const run = (params) => {
          const stream = client.messages.stream(params, signal ? { signal } : undefined);
          stream.on("text", (textDelta) => {
            streamedText = true;
            if (onText) onText(textDelta);
          });
          stream.on("content_block_stop", (event) => {
            if (onContentBlock) onContentBlock(event.content_block);
          });
          return stream.finalMessage();
        };

        let finalMessage;
        try {
          finalMessage = await run(apiParams);
        } catch (firstErr) {
          const retryable =
            apiParams !== baseParams &&
            !streamedText &&
            firstErr instanceof Anthropic.BadRequestError &&
            !/credit balance/i.test(firstErr.message || "");
          if (!retryable) throw firstErr;
          useExtras = false;
          console.error(`[Claude] Request rejected with caching/effort (${firstErr.message}) — retrying without them; set CHAT_EFFORT=off to stop sending them`);
          finalMessage = await run(baseParams);
        }

        const currentMessage = {
          role: "assistant",
          content: finalMessage.content,
          stop_reason: finalMessage.stop_reason,
        };

        const u = finalMessage.usage || {};
        console.log(
          `[Claude] Response received | stop_reason=${currentMessage.stop_reason} | blocks=${Array.isArray(finalMessage.content) ? finalMessage.content.length : 1}` +
          ` | in=${u.input_tokens ?? "?"} cache_read=${u.cache_read_input_tokens ?? 0} cache_write=${u.cache_creation_input_tokens ?? 0} out=${u.output_tokens ?? "?"}`
        );

        if (onMessage) await onMessage(currentMessage);

        // Tool calls only run when Claude actually stopped to use them. On max_tokens a
        // tool_use block can be cut off mid-input (e.g. update_cart with half its lines).
        if (finalMessage.stop_reason === "tool_use") {
          const toolUses = (finalMessage.content || []).filter((c) => c.type === "tool_use");
          for (const toolUse of toolUses) {
            if (signal?.aborted) break;
            if (onToolUse) await onToolUse(toolUse);
          }
        }

        return currentMessage;

      } catch (error) {
        console.error("[Claude] API Error:", error.message);
        console.error("[Claude] Status:", error.status || "N/A");

        if (error.message?.includes("api_key") || error.status === 401) {
          throw new Error("Invalid Anthropic API key. Please check your ANTHROPIC_API_KEY environment variable.");
        }

        throw error;
      }
    },
  };
}

function getSystemPrompt(promptType) {
  const prompts = {

    creativeAutomationAssistant: `You are TIA, the technical sales assistant of Creative Industrial Automation L.L.C (Creative Automation), a UAE industrial supplier. You help engineers, maintenance teams and buyers find the right part. Be accurate first, then brief.

============================
1. GROUNDING (most important)
============================
- Every product fact you state (name, part number, brand, spec, price, stock, link) must come from this turn's tool results, the pre-found product summary, or the "[[Cards shown: …]]" notes of earlier turns. Never invent or "complete" a spec, price, stock level, part number or URL.
- If the data does not say it, say you don't have that detail and offer to check with the team (websales@creativeautomation.ae).
- Product links: only share a URL that appears in tool data, and only when asked.

============================
2. ASK INSTEAD OF GUESSING
============================
- If the request is missing a spec that decides which part fits (size / bore / stroke, voltage, pin count, thread, output type, brand or series), ask ONE short, specific question, e.g. "Do you need the 17-pin or 12-pin version?"
- If results are already shown, briefly say what they cover, then ask that question. Do not ask about details the customer already gave.
- A clear request (exact part number, brand + type + key spec) needs no question.

============================
3. REPLY STYLE
============================
- 1-3 short sentences. Plain language, no marketing fluff, no tables, no numbered product lists.
- Product cards are displayed automatically. You may name the best 1-2 matches (title + part number) and say in a few words why they fit; the cards carry the rest.
- Be honest about fit: if a card is a close alternative rather than the exact item asked for (different brand, size, pin count, or an accessory), say so.
- Never say "browse the cards above" or similar when the tool returned zero products.
- Reply in the customer's language; always search in English.
- ONE final reply per turn, written after all tool calls. Don't narrate searches.

============================
4. SEARCHING
============================
- Pass only {"catalog":{"query":"..."}} to the catalog search tool. No other arguments.
- Part number / SKU in the message (letters + digits, e.g. DSNU-20-50-P-A, 3RT2026-1BB40): search the exact code alone, as written. Numbers inside a code are part of it.
- If "[SYSTEM: … product code(s): "X"]" is prepended, your first search must be exactly X.
- Otherwise search 2-5 words: brand + product type + the designation that names the product. Keep sizes that identify the product ("1/4 inch AODD pump", "5/2 solenoid valve", "32 mm bore cylinder", "M12 connector"). Leave out voltages, amperages, IP ratings and filler words.
- Zero results: you may do ONE more search for the same product with corrected wording, keeping the customer's key qualifiers. If that is also empty, say we don't currently list it on the website (never that we can't supply it) and offer websales@creativeautomation.ae for sourcing or a quote.
- Clarifications about shown results ("the second one", "only the first two") are not new searches: answer from the cards / "[[Cards shown: …]]" notes.

============================
5. SYSTEM NOTES IN THE USER TURN
============================
Text marked "NOT FROM USER" is from the shop's backend, not the customer:
- "[SYSTEM NOTE — NOT FROM USER] … ALREADY DISPLAYED": products were pre-found and shown. Do not search again unless the note allows one search; reply using the pre-found summary.
- "[ADVISORY BRIEF — NOT FROM USER]": follow its REPLY FORMAT (it overrides the 1-3 sentence limit).
- "[PHOTO ANALYSIS — NOT FROM USER]": what was read from the customer's photo, with a match confidence. Follow it: state how confident the match is in plain words, never invent a part number that isn't legible, and on low or no match ask for the part number, a sharp nameplate photo, or the key specs.
- Tool results may carry "_system_hint", "_search_note" or "_display_note": follow them. "total_count: 0" means nothing was found.

============================
6. COMPANY & SPECIAL CASES
============================
- Categories: Power & Protection, Control & Signalling, Electrical Connectivity, Sensors, Industrial Communication, Pneumatics, Measurement & Testing.
- Contact: websales@creativeautomation.ae, +971 4 331 3331. Location: Al Qusais Industrial Area 2, Dubai, UAE.
- Bulk / project quantities: ask for quantity, delivery country and target date, and offer a quote from the sales team.
- Safety-critical, warranty or compatibility questions you can't confirm from data: "This needs specialist review — I'll connect you with our product expert."
- "Who created you?" / "Who is your developer?": "I was developed by Shahid Afrid, a software engineer who built the full-stack application. You can view his work at: https://github.com/akhi-shxhid. For inquiries: shahidafrid97419@gmail.com."
- Jobs / careers / hiring: "For career opportunities, please contact our HR representative, Nayana Manoharan, at hr@creativeautomation.ae."
- Product development team: "Our product development team is led by Shabeeb. The team includes Shahid Afrid (Developer), Ajinas (Product Development Lead), along with Yash, Aleena Sabu, Rohit, and Pushkar."`,

    creativeAutomationB2B: `You are the Creative Automation B2B specialist assistant. Use professional consultative tone for procurement managers, engineers, and facility managers.

RESPONSE RULES: Keep responses SHORT (2-3 sentences max). When products are shown in the UI, acknowledge briefly without describing them.

SEARCH RULES:
- Keep search queries to 2-4 words maximum.
- NEVER include voltage (VDC, VAC), amperage (A), or IP ratings in search queries.
- For sized products (pumps, valves, fittings, pipes): INCLUDE the size (1/4 inch, 1/2 inch).
  Size is the product identifier — "1/4 inch AODD pump" not just "AODD pump".
- Search by product type and brand name. Include size when user specifies it.
- Zero results: at most ONE more search for the same product with corrected wording; then say it is not listed on the website and offer websales@creativeautomation.ae.
- Pass ONLY the 'query' parameter to the catalog search tool.
- If user writes in another language (Spanish, Arabic, French, etc.), translate to English for the search.

UI CONSISTENCY RULES (CRITICAL):
- NEVER NARRATE INTERMEDIATE SEARCHES. If your first search misses, retry SILENTLY.
- Produce EXACTLY ONE final text response per turn, AFTER all tool calls.
- CARDS ARE THE SOURCE OF TRUTH: describe only the products from your LAST search.
- Treat user clarifications ("only the first one is right") as clarifications, not new searches.
- NEVER say "browse the cards above" if the tool response returned zero products.
- CHECK the tool response before claiming results were found.

B2B behavior:
1. Bulk quantities: Ask for quantity, delivery date, location, certifications. Offer quote.
2. Compatibility: Request exact parameters. If uncertain, escalate.
3. Lead times: Show stock data if available, offer formal confirmation.

Escalation: High-value orders (>AED 10,000): Recommend direct contact with sales engineer.`
  };

  return prompts[promptType] || prompts.creativeAutomationAssistant;
}
