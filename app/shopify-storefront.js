/**
 * Shopify Storefront API Client (PRODUCTION SAFE)
 *
 * Token acquisition (13 Nov 2026):
 *   1. Reuse the newest "Chat Agent Storefront Token" this app already issued:
 *      GET /admin/api/{version}/storefront_access_tokens.json
 *      Before, every container start minted a NEW token and none was ever deleted. Shopify caps
 *      an app at 100 Storefront tokens per shop; past that, creation fails and variant lookups
 *      and Add to Cart stop working after the next restart.
 *   2. Only if none exists (or every one was rejected with 401): create one via
 *      POST /admin/api/{version}/storefront_access_tokens.json
 *   3. Cache it in memory for the process lifetime; a 401 marks it rejected and repeats 1-2.
 *   (SHOPIFY_STOREFRONT_TOKEN is still ignored: it caused stale-token 401s on deploy.)
 *
 * Official docs:
 * - https://shopify.dev/docs/api/admin-rest/latest/resources/storefrontaccesstoken
 * - https://shopify.dev/docs/api/storefront/latest#authentication
 */

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-01';
const STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || '';

// In-memory cache (per process). Token is always auto-created fresh via
// Admin REST API to avoid stale-token 401s on deploy.
//
// `inFlight` dedupes concurrent callers (Bug 2): without it, the 10
// parallel productByHandle queries fired by Algolia's variant lookup all
// race past the `cachedToken === null` check and each mints a new token.
let cachedToken = null;
let inFlight = null;
let envTokenDiscarded = true; // env var path permanently disabled

// Startup diagnostics
if (!STORE_DOMAIN) {
  console.error(
    '[Storefront] SHOPIFY_STORE_DOMAIN not set. Storefront features will fail.'
  );
} else {
  console.log(
    `[Storefront] Initialized | domain=${STORE_DOMAIN} | api=${API_VERSION} | token=${
      cachedToken ? 'env' : 'auto-create'
    }`
  );
}

// -----------------------------------------------------------------------------
// Token management
// -----------------------------------------------------------------------------

/**
 * Get a valid Storefront API access token.
 * Uses cached token or auto-creates via Admin REST API.
 * NEVER re-reads process.env at call time.
 */
async function getStorefrontToken() {
  if (cachedToken) return cachedToken;
  // Dedupe concurrent callers so we mint exactly ONE token even when
  // 10 parallel productByHandle queries race past the cache check.
  if (inFlight) return inFlight;
  console.log('[Storefront] No cached token — looking up this app\'s existing tokens...');
  inFlight = acquireStorefrontToken()
    .then((t) => {
      cachedToken = t;
      return t;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * Permanently invalidate the cached Storefront token.
 * If the env var token caused the 401, mark it as permanently discarded.
 */
function invalidateToken() {
  if (cachedToken) rejectedTokens.add(cachedToken);
  cachedToken = null;
  console.warn('[Storefront] Token rejected (401) — will look for another or create one');
}

const TOKEN_TITLE = 'Chat Agent Storefront Token';
// Tokens that returned 401 in this process: never reused again.
const rejectedTokens = new Set();

async function getAdminSession() {
  if (!STORE_DOMAIN) {
    throw new Error('[Storefront] Missing SHOPIFY_STORE_DOMAIN');
  }
  const { default: prisma } = await import('./db.server.js');
  const session = await prisma.session.findFirst({
    where: { shop: STORE_DOMAIN },
    orderBy: { id: 'desc' },
  });
  if (!session?.accessToken) {
    throw new Error(
      `[Storefront] No Admin API token found for ${STORE_DOMAIN}. App must be installed.`
    );
  }
  return session;
}

/** Newest token this app issued earlier, or null. Never throws. */
export function pickReusableToken(tokens, rejected = rejectedTokens) {
  const ours = (Array.isArray(tokens) ? tokens : [])
    .filter((t) => t?.title === TOKEN_TITLE && typeof t.access_token === 'string' && t.access_token && !rejected.has(t.access_token))
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return ours[0]?.access_token || null;
}

async function acquireStorefrontToken() {
  const session = await getAdminSession();
  try {
    const response = await fetch(
      `https://${STORE_DOMAIN}/admin/api/${API_VERSION}/storefront_access_tokens.json`,
      {
        headers: { Accept: 'application/json', 'X-Shopify-Access-Token': session.accessToken },
        signal: AbortSignal.timeout(10000),
      }
    );
    if (response.ok) {
      const list = (await response.json())?.storefront_access_tokens || [];
      const ours = list.filter((t) => t?.title === TOKEN_TITLE).length;
      const token = pickReusableToken(list);
      if (ours >= 50) {
        console.warn(`[Storefront] ${ours} "${TOKEN_TITLE}" tokens exist (Shopify allows 100 per app). Old ones can be deleted in the Admin API.`);
      }
      if (token) {
        cachedToken = token;
        console.log(`[Storefront] Reusing existing Storefront token (${ours} issued by this app)`);
        return token;
      }
    } else {
      console.warn(`[Storefront] Listing Storefront tokens failed (${response.status}) — creating one`);
    }
  } catch (e) {
    console.warn(`[Storefront] Listing Storefront tokens failed (${e.message}) — creating one`);
  }
  return createStorefrontTokenViaAdminRest(session);
}

/**
 * Create a Storefront access token via Admin REST API.
 * POST /admin/api/{version}/storefront_access_tokens.json
 */
async function createStorefrontTokenViaAdminRest(session) {
  console.log('[Storefront] Creating Storefront token via Admin REST API...');

  const response = await fetch(
    `https://${STORE_DOMAIN}/admin/api/${API_VERSION}/storefront_access_tokens.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': session.accessToken,
      },
      body: JSON.stringify({
        storefront_access_token: {
          title: TOKEN_TITLE,
        },
      }),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    console.error(
      `[Storefront] Admin REST API ${response.status}: ${text.slice(0, 300)}`
    );

    if (response.status === 403) {
      throw new Error(
        '[Storefront] Admin token lacks permission. Ensure unauthenticated_* scopes and reinstall.'
      );
    }

    throw new Error(
      `[Storefront] Failed to create Storefront token (${response.status})`
    );
  }

  const json = await response.json();
  const token = json?.storefront_access_token?.access_token;

  if (!token) {
    throw new Error(
      '[Storefront] Token creation succeeded but no token returned'
    );
  }

  cachedToken = token;
  console.log('[Storefront] Storefront token created successfully via Admin REST API');

  return token;
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Execute a Shopify Admin API GraphQL query.
 *
 * Uses session.accessToken from Prisma (the same token used to mint
 * Storefront tokens). Required scopes for productVariants(query: "sku:..."):
 * read_products. The chat app already requests this scope.
 *
 * Used by searchVariantBySku() in storefront-service.js for exact SKU lookups,
 * which Storefront `search` cannot handle reliably.
 */
export async function shopifyAdminGraphqlQuery({ query, variables = {}, shopDomain }) {
  const domain = shopDomain || STORE_DOMAIN;
  if (!domain) {
    throw new Error('[AdminGraphQL] No shop domain available.');
  }

  const { default: prisma } = await import('./db.server.js');
  const session = await prisma.session.findFirst({
    where: { shop: domain },
    orderBy: { id: 'desc' },
  });

  if (!session?.accessToken) {
    throw new Error(`[AdminGraphQL] No Admin access token for ${domain}`);
  }

  const endpoint = `https://${domain}/admin/api/${API_VERSION}/graphql.json`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Shopify-Access-Token': session.accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`[AdminGraphQL] HTTP ${response.status}: ${text.slice(0, 300)}`);
    throw new Error(`Admin GraphQL HTTP ${response.status}`);
  }

  const json = await response.json();
  if (json.errors?.length) {
    const message = json.errors[0]?.message || 'Unknown GraphQL error';
    console.error('[AdminGraphQL] errors:', JSON.stringify(json.errors).slice(0, 300));
    throw new Error(`Admin GraphQL error: ${message}`);
  }
  return json.data;
}

/**
 * Execute a Storefront API GraphQL query/mutation.
 * Uses cached token or auto-creates one. Retries once on 401.
 */
export async function shopifyStorefrontQuery({
  query,
  variables = {},
  shopDomain,
  _retried = false,
}) {
  const domain = shopDomain || STORE_DOMAIN;

  if (!domain) {
    throw new Error(
      '[Storefront] No shop domain available. Pass shopDomain or set SHOPIFY_STORE_DOMAIN env.'
    );
  }

  const endpoint = `https://${domain}/api/${API_VERSION}/graphql.json`;

  // CRITICAL: Always use the cached token system. NEVER re-read env var at call time.
  const token = await getStorefrontToken();

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Shopify-Storefront-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });

  // On 401: permanently discard the failing token and retry with a fresh one
  if (response.status === 401 && !_retried) {
    console.warn('[Storefront] 401 — token rejected. Discarding and creating fresh token via Admin REST API...');
    invalidateToken();
    return shopifyStorefrontQuery({
      query,
      variables,
      shopDomain,
      _retried: true,
    });
  }

  if (!response.ok) {
    const text = await response.text();
    console.error(
      `[Storefront] HTTP ${response.status}: ${text.slice(0, 300)}`
    );
    throw new Error(`Storefront API HTTP ${response.status}`);
  }

  const json = await response.json();

  if (json.errors?.length) {
    const message = json.errors[0]?.message || 'Unknown GraphQL error';
    console.error('[Storefront] GraphQL Error:', message);
    throw new Error(message);
  }

  return json.data;
}
