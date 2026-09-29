// app/routes/ucp.agent-profile[.]json.jsx
// Serves this app's UCP agent (platform) profile at /ucp/agent-profile.json.
// Shopify fetches this URL — sent as meta.ucp-agent.profile on every UCP MCP call — to negotiate
// capabilities. Point UCP_AGENT_PROFILE at it.
// Shape follows Shopify's "valid-with-capabilities" fixture (https://shopify.dev/docs/agents/profiles).

const SUPPORTED = new Set(["2026-08-25", "2026-04-08"]);

function buildProfile(v) {
  const ucp = (path) => `https://ucp.dev/${v}/${path}`;
  const checkoutAndCart = ["dev.ucp.shopping.checkout", "dev.ucp.shopping.cart"];
  const catalog = ["dev.ucp.shopping.catalog.lookup", "dev.ucp.shopping.catalog.search"];
  return {
    ucp: {
      version: v,
      services: {
        "dev.ucp.shopping": [
          {
            version: v,
            spec: ucp("specification/overview"),
            transport: "mcp",
            schema: ucp("services/shopping/mcp.openrpc.json"),
          },
        ],
      },
      capabilities: {
        "dev.ucp.shopping.checkout": [{ version: v }],
        "dev.ucp.shopping.fulfillment": [{ version: v, extends: checkoutAndCart }],
        "dev.ucp.shopping.buyer_consent": [{ version: v, extends: "dev.ucp.shopping.checkout" }],
        "dev.ucp.shopping.discount": [{ version: v, extends: checkoutAndCart }],
        "dev.ucp.shopping.cart": [
          { version: v, spec: ucp("specification/cart"), schema: ucp("schemas/shopping/cart.json") },
        ],
        "dev.ucp.shopping.order": [
          { version: v, spec: ucp("specification/order"), schema: ucp("schemas/shopping/order.json") },
        ],
        "dev.ucp.shopping.catalog.search": [
          { version: v, spec: ucp("specification/catalog/search"), schema: ucp("schemas/shopping/catalog_search.json") },
        ],
        "dev.ucp.shopping.catalog.lookup": [
          { version: v, spec: ucp("specification/catalog/lookup"), schema: ucp("schemas/shopping/catalog_lookup.json") },
        ],
        "dev.shopify.catalog": [
          {
            version: v,
            spec: "https://shopify.dev/docs/agents/catalog/storefront-catalog",
            schema: `https://shopify.dev/ucp/schemas/${v}/shopify_catalog.json`,
            extends: catalog,
          },
        ],
      },
      payment_handlers: {},
    },
  };
}

export const loader = () => {
  const requested = process.env.UCP_PROFILE_VERSION || "2026-08-25";
  const version = SUPPORTED.has(requested) ? requested : "2026-08-25";
  return new Response(JSON.stringify(buildProfile(version)), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    },
  });
};
