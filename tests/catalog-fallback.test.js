import test from "node:test";
import assert from "node:assert/strict";
import {
  queryTerms,
  filterProductsByQueryTerms,
  refineProducts,
  isAccessoryTitle,
  isUcpDiscoveryError,
  ucpErrorCode,
  createCircuitBreaker,
  catalogToolMode,
  RELEVANCE_FILTERED_PATHS,
} from "../app/services/catalog-fallback.server.js";

// Exact error text from the Railway logs.
const UCP_422 =
  'Request failed: 422 {"jsonrpc":"2.0","id":1790665947536,"error":{"code":-32001,"message":"UCP discovery failed","data":{"code":"profile_unreachable","content":"Unable to fetch agent profile: Http error","continue_url":"https://nfejky-ge.myshopify.com/"}}}';

const JUNK = [
  { title: "Siemens DIN Rail Enclosures 8GK1052-1KK11", vendor: "Siemens", sku: "8GK1052-1KK11" },
  { title: "Lapp Cable Gland M20", vendor: "Lapp", sku: "53111020" },
];
// Real catalogue titles (checked in Shopify Admin, 29 Sep 2026).
const ACC = { title: "Siemens Circuit Breaker Accessories 8WA2867", vendor: "Siemens", sku: "8WA2867" };
const MAIN = { title: "Siemens Electronic Circuit Breakers 3RV2311-0AC10", vendor: "Siemens", sku: "3RV2311-0AC10" };

test("query terms drop filler words", () => {
  assert.deepEqual(queryTerms("do you supply switchgare"), ["switchgare"]);
  assert.deepEqual(queryTerms("of frp products?"), ["frp"]);
  assert.deepEqual(queryTerms("FRP cable tray"), ["frp", "cable", "tray"]);
  assert.deepEqual(queryTerms("hi, do you have any?"), []);
});

test("last-resort cards with no term overlap are dropped (28 Sep logs)", () => {
  const r = filterProductsByQueryTerms(JUNK, "do you supply switchgare");
  assert.equal(r.kept.length, 0);
  assert.equal(r.dropped, 2);
  assert.equal(filterProductsByQueryTerms(JUNK, "of frp products?").kept.length, 0);
});

test("last-resort cards need ALL query terms (29 Sep: FRP enclosure → metal enclosures)", () => {
  assert.equal(filterProductsByQueryTerms(JUNK, "FRP enclosure").kept.length, 0);
  const products = [...JUNK, { title: "FRP Cable Tray 300 mm", vendor: "Creative Automation", sku: "FRP-CT-300" }];
  assert.deepEqual(filterProductsByQueryTerms(products, "FRP cable tray").kept.map((p) => p.sku), ["FRP-CT-300"]);
  assert.equal(filterProductsByQueryTerms(JUNK, "do you supply enclosure").kept.length, 1);
  assert.equal(filterProductsByQueryTerms(JUNK, "enclosures").kept.length, 1);
});

test("nothing to judge keeps everything", () => {
  const r = filterProductsByQueryTerms(JUNK, "hi, do you have any?");
  assert.equal(r.judged, false);
  assert.equal(r.kept.length, 2);
});

test("accessories go last unless the query asks for them", () => {
  assert.equal(isAccessoryTitle(ACC.title), true);
  assert.equal(isAccessoryTitle(MAIN.title), false);

  let r = refineProducts([ACC, MAIN], "circuit breaker", "algolia_search");
  assert.deepEqual(r.products.map((p) => p.sku), ["3RV2311-0AC10", "8WA2867"]);
  assert.equal(r.accessoryOnly, false);
  assert.equal(r.dropped, 0);

  r = refineProducts([ACC], "circuit breaker", "algolia_search");
  assert.equal(r.accessoryOnly, true);

  r = refineProducts([ACC, MAIN], "circuit breaker accessories", "algolia_search");
  assert.deepEqual(r.products.map((p) => p.sku), ["8WA2867", "3RV2311-0AC10"]);
  assert.equal(r.accessoryOnly, false);
});

test("the term filter applies only to low-quality paths", () => {
  assert.equal(refineProducts(JUNK, "do you supply switchgare", "storefront_search_last_resort").products.length, 0);
  assert.equal(refineProducts(JUNK, "do you supply switchgare", "algolia_search").products.length, 2);
});

test("UCP discovery errors are recognised and summarised", () => {
  assert.equal(isUcpDiscoveryError(UCP_422), true);
  assert.equal(isUcpDiscoveryError("Request failed: 500 Internal Server Error"), false);
  assert.equal(isUcpDiscoveryError("fetch failed: ECONNRESET"), false);
  assert.equal(isUcpDiscoveryError(""), false);
  assert.equal(ucpErrorCode(UCP_422), "profile_unreachable");
  assert.equal(ucpErrorCode("boom"), "ucp_discovery_failed");
});

test("circuit breaker opens and closes", () => {
  const b = createCircuitBreaker(1000);
  assert.equal(b.isOpen(0), false);
  b.trip("profile_unreachable", 0);
  assert.equal(b.isOpen(500), true);
  assert.equal(b.reason, "profile_unreachable");
  assert.equal(b.isOpen(1500), false);
  b.reset();
  assert.equal(b.isOpen(), false);
});

test("catalog tool mode", () => {
  const prev = process.env.CATALOG_TOOL_MODE;
  process.env.CATALOG_TOOL_MODE = "LOCAL";
  assert.equal(catalogToolMode(), "local");
  process.env.CATALOG_TOOL_MODE = "nonsense";
  assert.equal(catalogToolMode(), "auto");
  delete process.env.CATALOG_TOOL_MODE;
  assert.equal(catalogToolMode(), "auto");
  if (prev !== undefined) process.env.CATALOG_TOOL_MODE = prev;
  assert.ok(RELEVANCE_FILTERED_PATHS.has("storefront_search_last_resort"));
});
