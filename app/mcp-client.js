/**
 * MCPClient — v2.3
 * Client for interacting with Model Context Protocol (MCP) API endpoints
 *
 * CHANGES (v2.3 — Sept 2026):
 *   - Shopify's UCP migration moved the catalog tools off /api/mcp.
 *     search_catalog / lookup_catalog / get_product now live on
 *     /api/ucp/mcp, while /api/mcp keeps only get_cart, update_cart and
 *     search_shop_policies_and_faqs. Listing tools on the old endpoint was
 *     returning policies only, which is why "No catalog-search tool found"
 *     started firing and product search returned nothing.
 *   - Added connectToUcpCatalogServer() and callUcpTool().
 *   - Every UCP request carries an agent profile in `meta`; UCP rejects
 *     calls without one.
 *   - searchShopCatalog() now routes through callTool() so the request lands
 *     on whichever server actually advertises the tool.
 *
 * CHANGES (v2.2 — May 2026):
 *   - `searchShopCatalog()` now inspects the tool's input_schema to determine
 *     what argument shape the active MCP version expects:
 *       Old search_shop_catalog: { query: "..." }
 *       New search_catalog:      { catalog: { query: "..." } }
 *     Passing the wrong shape caused "Invalid params" errors silently — the MCP
 *     returned 0 results or unexpected products.
 *   - Added `getCatalogSearchToolArgs()` helper that returns the correct args
 *     object based on the advertised schema.
 *   - Added logging of detected schema so it's visible in production logs.
 *
 * CHANGES (v2.1 — April 2026):
 *   - `searchShopCatalog()` looks up the active catalog-search tool name
 *     from advertised tools instead of hardcoding "search_shop_catalog".
 *   - `searchShopCatalog()` no longer sends the `context` argument.
 */

const CATALOG_SEARCH_TOOL_NAMES = new Set([
  "search_shop_catalog",  // legacy
  "search_catalog",       // current (UCP)
  "search_products",      // defensive
]);

function isCatalogSearchTool(toolName) {
  return CATALOG_SEARCH_TOOL_NAMES.has(String(toolName || "").toLowerCase());
}

class MCPClient {
  constructor(hostUrl, conversationId, shopId, customerMcpEndpoint) {
    this.tools = [];
    this.customerTools = [];
    this.storefrontTools = [];
    this.ucpTools = [];

    this.hostUrl = this._normalizeUrl(hostUrl);

    // Standard Storefront MCP: get_cart, update_cart,
    // search_shop_policies_and_faqs ONLY.
    this.storefrontMcpEndpoint = `${this.hostUrl}/api/mcp`;

    // UCP catalog MCP: search_catalog, lookup_catalog, get_product.
    this.ucpMcpEndpoint = `${this.hostUrl}/api/ucp/mcp`;

    // Every UCP catalog request must carry an agent profile.
    this.ucpAgentProfile =
      process.env.UCP_AGENT_PROFILE ||
      "https://shopify.dev/ucp/agent-profiles/examples/2026-08-25/valid-with-capabilities.json";

    const accountHostUrl = this.hostUrl.replace(/(\.myshopify\.com)$/, '.account$1');
    this.customerMcpEndpoint = customerMcpEndpoint || `${accountHostUrl}/customer/api/mcp`;

    this.customerAccessToken = "";
    this.conversationId = conversationId;
    this.shopId = shopId;

    this.retryAttempts = 3;
    this.retryDelay = 1000;

    // Cache the detected catalog search schema style
    this._catalogSearchSchema = null; // 'flat' or 'nested'
  }

  _normalizeUrl(url) {
    const resolved = url || process.env.SHOPIFY_STORE_DOMAIN;
    if (!resolved) {
      throw new Error(
        "hostUrl is required: pass shopDomain or set SHOPIFY_STORE_DOMAIN env var"
      );
    }
    if (resolved.startsWith('http://') || resolved.startsWith('https://')) {
      return resolved;
    }
    return `https://${resolved}`;
  }

  _ucpMeta() {
    return { "ucp-agent": { profile: this.ucpAgentProfile } };
  }

  /** Catalog tools may be advertised by either server. Check both. */
  _catalogCandidateTools() {
    return [...(this.ucpTools || []), ...(this.storefrontTools || [])];
  }

  getCatalogSearchToolName() {
    const found = this._catalogCandidateTools().find(t => isCatalogSearchTool(t.name));
    return found?.name || "search_catalog";
  }

  /**
   * v2.2: Detect and return the correct args object for the catalog search tool.
   *
   *   Old (search_shop_catalog): { query: "solenoid valve" }
   *   New (search_catalog):      { catalog: { query: "solenoid valve" } }
   *
   * We inspect the tool's advertised input_schema to determine which shape to
   * use, so we pass valid args regardless of MCP version.
   */
  getCatalogSearchToolArgs(query) {
    if (!query || typeof query !== 'string') {
      throw new Error('Search query must be a non-empty string');
    }

    const cleanQuery = query.trim();
    const toolName = this.getCatalogSearchToolName();
    const tool = this._catalogCandidateTools().find(t => t.name === toolName);

    // Check the input_schema to determine expected argument structure
    if (tool?.input_schema?.properties) {
      const props = tool.input_schema.properties;

      // New schema: has 'catalog' property with nested 'query'
      if (props.catalog) {
        if (this._catalogSearchSchema !== 'nested') {
          this._catalogSearchSchema = 'nested';
          console.log(`[MCPClient] Detected catalog search schema: NESTED { catalog: { query } } for tool "${toolName}"`);
        }
        return { catalog: { query: cleanQuery } };
      }

      // Old/flat schema: has 'query' property directly
      if (props.query) {
        if (this._catalogSearchSchema !== 'flat') {
          this._catalogSearchSchema = 'flat';
          console.log(`[MCPClient] Detected catalog search schema: FLAT { query } for tool "${toolName}"`);
        }
        return { query: cleanQuery };
      }
    }

    // Fallback: infer from tool name.
    // search_catalog (new) → nested, search_shop_catalog (old) → flat
    if (toolName === 'search_catalog' || toolName === 'search_products') {
      if (this._catalogSearchSchema !== 'nested') {
        this._catalogSearchSchema = 'nested';
        console.log(`[MCPClient] Inferring catalog search schema: NESTED (tool name is "${toolName}")`);
      }
      return { catalog: { query: cleanQuery } };
    }

    // Default to flat for legacy compatibility
    if (this._catalogSearchSchema !== 'flat') {
      this._catalogSearchSchema = 'flat';
      console.log(`[MCPClient] Using default catalog search schema: FLAT { query } for tool "${toolName}"`);
    }
    return { query: cleanQuery };
  }

  async connectToCustomerServer() {
    try {
      console.log(`🔌 Connecting to customer MCP: ${this.customerMcpEndpoint}`);

      if (this.conversationId) {
        try {
          const dbToken = await (await import('./db.server.js')).getCustomerToken(this.conversationId);
          if (dbToken?.accessToken) {
            this.customerAccessToken = dbToken.accessToken;
            console.log("✅ Using existing customer token");
          }
        } catch (tokenError) {
          console.warn("⚠️ Could not retrieve customer token:", tokenError.message);
        }
      }

      const headers = { "Content-Type": "application/json" };
      if (this.customerAccessToken) {
        headers["Authorization"] = this.customerAccessToken;
      }

      const response = await this._makeJsonRpcRequest(
        this.customerMcpEndpoint,
        "tools/list",
        {},
        headers
      );

      const toolsData = response.result?.tools || [];
      const customerTools = this._formatToolsData(toolsData);

      this.customerTools = customerTools;
      this.tools = [...this.tools, ...customerTools];

      console.log(`✅ Connected to customer MCP: ${customerTools.length} tools available`);
      return customerTools;

    } catch (error) {
      console.error("❌ Failed to connect to customer MCP:", error.message);
      return [];
    }
  }

  async connectToStorefrontServer() {
    try {
      console.log(`🔌 Connecting to storefront MCP: ${this.storefrontMcpEndpoint}`);

      const headers = { "Content-Type": "application/json" };

      const response = await this._makeJsonRpcRequest(
        this.storefrontMcpEndpoint,
        "tools/list",
        {},
        headers
      );

      const toolsData = response.result?.tools || [];
      const storefrontTools = this._formatToolsData(toolsData);

      this.storefrontTools = storefrontTools;
      this.tools = [...this.tools, ...storefrontTools];

      console.log(`✅ Connected to storefront MCP: ${storefrontTools.length} tools available`);
      return storefrontTools;

    } catch (error) {
      console.error("❌ Failed to connect to storefront MCP:", error.message);
      throw new Error(`Storefront MCP connection failed: ${error.message}`);
    }
  }

  async connectToUcpCatalogServer() {
    try {
      console.log(`🔌 Connecting to UCP catalog MCP: ${this.ucpMcpEndpoint}`);

      const headers = { "Content-Type": "application/json" };

      const response = await this._makeJsonRpcRequest(
        this.ucpMcpEndpoint,
        "tools/list",
        { meta: this._ucpMeta() },
        headers
      );

      const toolsData = response.result?.tools || [];
      const ucpTools = this._formatToolsData(toolsData);

      this.ucpTools = ucpTools;
      this.tools = [...this.tools, ...ucpTools];

      console.log(
        `✅ Connected to UCP catalog MCP: ${ucpTools.length} tools available` +
        (ucpTools.length ? ` (${ucpTools.map(t => t.name).join(", ")})` : "")
      );
      return ucpTools;

    } catch (error) {
      // Non-fatal: the assistant can still answer policy questions without it.
      console.error("❌ Failed to connect to UCP catalog MCP:", error.message);
      this.ucpTools = [];
      return [];
    }
  }

  async callTool(toolName, toolArgs) {
    if (this.customerTools.some(tool => tool.name === toolName)) {
      return this.callCustomerTool(toolName, toolArgs);
    } else if (this.ucpTools.some(tool => tool.name === toolName)) {
      return this.callUcpTool(toolName, toolArgs);
    } else if (this.storefrontTools.some(tool => tool.name === toolName)) {
      return this.callStorefrontTool(toolName, toolArgs);
    } else {
      throw new Error(`Tool '${toolName}' not found in any connected MCP server`);
    }
  }

  async callUcpTool(toolName, toolArgs) {
    console.log(`📞 Calling UCP catalog tool: ${toolName}`);

    const headers = { "Content-Type": "application/json" };

    // UCP rejects the call without an agent profile in meta.
    const args = { meta: this._ucpMeta(), ...(toolArgs || {}) };

    try {
      const response = await this._makeJsonRpcRequestWithRetry(
        this.ucpMcpEndpoint,
        "tools/call",
        { name: toolName, arguments: args },
        headers
      );
      return response.result || response;
    } catch (error) {
      console.error(`❌ UCP catalog tool '${toolName}' failed:`, error.message);
      throw error;
    }
  }

  async callStorefrontTool(toolName, toolArgs) {
    console.log(`📞 Calling storefront tool: ${toolName}`);

    const headers = { "Content-Type": "application/json" };

    try {
      const response = await this._makeJsonRpcRequestWithRetry(
        this.storefrontMcpEndpoint,
        "tools/call",
        { name: toolName, arguments: toolArgs },
        headers
      );
      return response.result || response;
    } catch (error) {
      console.error(`❌ Storefront tool '${toolName}' failed:`, error.message);
      throw error;
    }
  }

  async callCustomerTool(toolName, toolArgs) {
    console.log(`📞 Calling customer tool: ${toolName}`);

    let accessToken = this.customerAccessToken;

    if (!accessToken) {
      try {
        const dbToken = await (await import('./db.server.js')).getCustomerToken(this.conversationId);
        if (dbToken?.accessToken) {
          accessToken = dbToken.accessToken;
          this.customerAccessToken = accessToken;
        }
      } catch (error) {
        console.warn("⚠️ Could not retrieve token:", error.message);
      }
    }

    const headers = { "Content-Type": "application/json" };
    if (accessToken) headers["Authorization"] = accessToken;

    try {
      const response = await this._makeJsonRpcRequest(
        this.customerMcpEndpoint,
        "tools/call",
        { name: toolName, arguments: toolArgs },
        headers
      );
      return response.result || response;
    } catch (error) {
      if (error.status === 401) {
        console.log("🔐 Authentication required, generating auth URL");
        try {
          const { generateAuthUrl } = await import('./auth.server.js');
          const authResponse = await generateAuthUrl(this.conversationId, this.shopId);
          return {
            error: {
              type: "auth_required",
              message: "Authentication required",
              auth_url: authResponse.url,
              data: `You need to authorize the app. [Click here to authorize](${authResponse.url})`,
            },
          };
        } catch (authError) {
          console.error("❌ Failed to generate auth URL:", authError.message);
          return {
            error: { type: "auth_failed", message: "Could not generate authorization URL" },
          };
        }
      }

      console.error(`❌ Customer tool '${toolName}' failed:`, error.message);
      return {
        error: {
          type: "tool_error",
          message: `Error calling tool ${toolName}: ${error.message}`,
        },
      };
    }
  }

  /**
   * Search shop catalog by natural language query.
   *
   * v2.3: Dispatches through callTool() so the request goes to whichever
   * server advertises the tool — the UCP endpoint in practice. Calling
   * callStorefrontTool() directly here sent catalog searches to /api/mcp,
   * which no longer serves them.
   */
  async searchShopCatalog(query) {
    if (!query || typeof query !== "string") {
      throw new Error("Search query is required");
    }

    const toolName = this.getCatalogSearchToolName();
    const toolArgs = this.getCatalogSearchToolArgs(query.trim());

    console.log(`🔍 Searching catalog for: "${query}" via tool "${toolName}" with args: ${JSON.stringify(toolArgs)}`);

    try {
      const result = await this.callTool(toolName, toolArgs);

      if (!result || typeof result !== "object") {
        throw new Error("Invalid search result structure");
      }
      return result;
    } catch (error) {
      console.error("❌ Catalog search failed:", error.message);
      throw new Error(`Product search failed: ${error.message}`);
    }
  }

  async updateCart({ cartId, lines }) {
    if (!lines || !Array.isArray(lines) || lines.length === 0) {
      throw new Error("Cart lines are required");
    }

    console.log(`🛒 Updating cart ${cartId || '(new)'} with ${lines.length} item(s)`);

    const validLines = lines.filter(line => {
      if (!line.merchandise_id) {
        console.warn("⚠️ Line item missing merchandise_id:", line);
        return false;
      }
      return true;
    });

    if (validLines.length === 0) {
      throw new Error("No valid line items to add to cart");
    }

    try {
      const result = await this.callStorefrontTool("update_cart", {
        cart_id: cartId || undefined,
        lines: validLines,
      });
      console.log("✅ Cart updated successfully");
      return result;
    } catch (error) {
      console.error("❌ Cart update failed:", error.message);
      throw new Error(`Failed to update cart: ${error.message}`);
    }
  }

  async addSingleProductToCartFromQuery({ productQuery, quantity = 1, existingCartId }) {
    if (!productQuery) {
      throw new Error("Product query is required");
    }

    console.log(`🛍️ Adding "${productQuery}" to cart (qty: ${quantity})`);

    try {
      const searchResult = await this.searchShopCatalog(productQuery);

      const items =
        searchResult?.items ||
        searchResult?.results ||
        searchResult?.products ||
        searchResult?.catalog?.items ||
        searchResult?.catalog?.products ||
        [];

      if (!items || items.length === 0) {
        throw new Error(`No products found for "${productQuery}"`);
      }

      console.log(`✅ Found ${items.length} matching product(s)`);

      const firstProduct = items[0];
      const merchandiseId =
        firstProduct.merchandise_id ||
        firstProduct.variant_id ||
        firstProduct.variantId ||
        firstProduct.default_variant_id ||
        firstProduct.id;

      if (!merchandiseId) {
        console.error("❌ Product missing variant ID:", firstProduct);
        throw new Error("Product does not have a valid variant ID");
      }

      console.log(`✅ Using variant ID: ${merchandiseId}`);

      const cartResult = await this.updateCart({
        cartId: existingCartId,
        lines: [{ merchandise_id: merchandiseId, quantity: parseInt(quantity) || 1 }],
      });

      console.log("✅ Product added to cart successfully");
      return cartResult;
    } catch (error) {
      console.error("❌ Failed to add product to cart:", error.message);
      throw error;
    }
  }

  async getCart(cartId) {
    if (!cartId) {
      throw new Error("Cart ID is required");
    }
    try {
      const result = await this.callStorefrontTool("get_cart", { cart_id: cartId });
      return result;
    } catch (error) {
      console.error("❌ Failed to get cart:", error.message);
      throw error;
    }
  }

  async _makeJsonRpcRequest(endpoint, method, params, headers) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: method,
          id: Date.now(),
          params: params,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        const error = new Error(`Request failed: ${response.status} ${errorText}`);
        error.status = response.status;
        throw error;
      }

      const data = await response.json();

      if (data.error) {
        const error = new Error(data.error.message || "JSON-RPC error");
        error.code = data.error.code;
        throw error;
      }

      return data;
    } catch (error) {
      console.error(`❌ JSON-RPC request failed (${method}):`, error.message);
      throw error;
    }
  }

  async _makeJsonRpcRequestWithRetry(endpoint, method, params, headers, attempt = 1) {
    try {
      return await this._makeJsonRpcRequest(endpoint, method, params, headers);
    } catch (error) {
      if (error.status === 401 || error.status === 400) {
        throw error;
      }
      if (attempt < this.retryAttempts) {
        console.log(`⚠️ Retry attempt ${attempt}/${this.retryAttempts} for ${method}`);
        await new Promise(resolve => setTimeout(resolve, this.retryDelay * attempt));
        return this._makeJsonRpcRequestWithRetry(endpoint, method, params, headers, attempt + 1);
      }
      throw error;
    }
  }

  _formatToolsData(toolsData) {
    if (!Array.isArray(toolsData)) {
      console.warn("⚠️ Invalid tools data format");
      return [];
    }
    return toolsData.map((tool) => ({
      name: tool.name,
      description: tool.description || "",
      input_schema: tool.inputSchema || tool.input_schema || {},
    }));
  }

  getAllTools() {
    return {
      all: this.tools,
      customer: this.customerTools,
      storefront: this.storefrontTools,
      ucp: this.ucpTools,
    };
  }

  hasToolAvailable(toolName) {
    return this.tools.some(tool => tool.name === toolName);
  }

  getToolSchema(toolName) {
    const tool = this.tools.find(t => t.name === toolName);
    return tool?.input_schema || null;
  }
}

export default MCPClient;
