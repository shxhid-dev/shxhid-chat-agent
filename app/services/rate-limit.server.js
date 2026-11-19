// app/services/rate-limit.server.js — v1.0 (19 Nov 2026)
//
// Sliding-window counters, shared by photo uploads (image-intel.server.js) and chat messages
// (chat.jsx). In-memory: one Railway instance, resets on deploy. Pure, no imports.

/** Sliding-window counter per key. */
export function createRateLimiter({ max, windowMs, now = () => Date.now() }) {
  const hits = new Map();
  return {
    /** True if one more hit fits, without recording it. */
    peek(key) {
      const t = now();
      return (hits.get(key) || []).filter((ts) => t - ts < windowMs).length < max;
    },
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

function intEnv(name, fallback) {
  const n = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Chat messages. Generous for people (a fast typist sends a few a minute); the global cap
// bounds what a script could spend on Claude calls, since each message is up to 6 of them.
const chatPerConversation = createRateLimiter({ max: intEnv("CHAT_MAX_PER_CONVERSATION_10MIN", 40), windowMs: 10 * 60 * 1000 });
const chatGlobal = createRateLimiter({ max: intEnv("CHAT_MAX_PER_MINUTE", 200), windowMs: 60 * 1000 });

/** True if this conversation may send another message now. Both limits are checked before either is charged. */
export function allowChatMessage(conversationId) {
  const key = String(conversationId || "anon");
  if (!chatPerConversation.peek(key) || !chatGlobal.peek("all")) return false;
  return chatPerConversation.allow(key) && chatGlobal.allow("all");
}

export default { createRateLimiter, allowChatMessage };
