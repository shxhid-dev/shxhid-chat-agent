// Regression tests for the 13 Nov 2026 reliability pass: Storefront token reuse, MCP tool-list cache.
import test from "node:test";
import assert from "node:assert/strict";

import { pickReusableToken } from "../app/shopify-storefront.js";

test("the newest token this app issued is reused; others and rejected ones are not", () => {
  const tokens = [
    { title: "Chat Agent Storefront Token", access_token: "old", created_at: "2026-09-26T05:28:00Z" },
    { title: "API Client Extension", access_token: "other-app", created_at: "2026-11-01T00:00:00Z" },
    { title: "Chat Agent Storefront Token", access_token: "new", created_at: "2026-11-10T09:48:00Z" },
  ];
  assert.equal(pickReusableToken(tokens, new Set()), "new");
  assert.equal(pickReusableToken(tokens, new Set(["new"])), "old");
  assert.equal(pickReusableToken(tokens, new Set(["new", "old"])), null);
  assert.equal(pickReusableToken(undefined, new Set()), null);
});

test("UCP and storefront tool lists are fetched once and shared by later requests", async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(`${new URL(url).pathname} ${body.method}`);
    const tools = url.includes("/ucp/") ? [{ name: "search_catalog", inputSchema: {} }] : [{ name: "search_shop_policies_and_faqs", inputSchema: {} }];
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: body.id, result: { tools } }) };
  };
  try {
    const { default: MCPClient } = await import("../app/mcp-client.js");
    for (let i = 0; i < 2; i++) {
      const client = new MCPClient("shop.example.com", "conv_test", null, null);
      assert.equal((await client.connectToUcpCatalogServer()).length, 1);
      assert.equal((await client.connectToStorefrontServer()).length, 1);
      assert.equal(client.tools.length, 2);
    }
    assert.deepEqual(calls, ["/api/ucp/mcp tools/list", "/api/mcp tools/list"]);

    // A server that answers after chat.jsx stopped waiting does not add tools.
    const late = new MCPClient("shop.example.com", "conv_test", null, null);
    late.acceptingTools = false;
    await late.connectToStorefrontServer();
    assert.equal(late.tools.length, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
