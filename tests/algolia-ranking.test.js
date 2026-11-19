// End-to-end Algolia ranking with a fake client: vendor routing, rerank, spec filter, relevance
// verdict. No network, no database: the store/database env vars are cleared before import, and
// fetch is stubbed so Storefront variant lookups fail fast.
import test from "node:test";
import assert from "node:assert/strict";

delete process.env.SHOPIFY_STORE_DOMAIN;
// Not `delete`: Prisma loads .env itself and would reach the production database. A value that is
// already set is never overridden, so point it at a closed local port.
process.env.DATABASE_URL = "postgresql://nobody:nothing@127.0.0.1:1/none?connect_timeout=1";
process.env.ALGOLIA_APP_ID = "test-app";
process.env.ALGOLIA_SEARCH_KEY = "test-key";
globalThis.fetch = async () => {
  throw new Error("network disabled in tests");
};

const { algoliaSearchDetailed, __internals: A } = await import("../app/services/algolia.server.js");

const hit = (id, title, vendor = "IFM", extra = {}) => ({
  objectID: id,
  title,
  handle: `h-${id}`,
  vendor,
  product_type: "Inductive Sensors",
  tags: [`${vendor} Inductive Sensors`],
  body_html_safe: "",
  price: 100,
  sku: id.toUpperCase(),
  inventory_available: true,
  ...extra,
});

function fakeClient({ vendors = ["IFM", "Siemens", "ABB"], hits = [] }) {
  const requests = [];
  return {
    requests,
    async search({ requests: reqs }) {
      const r = reqs[0];
      requests.push(r);
      if (r.facets) return { results: [{ facets: { vendor: Object.fromEntries(vendors.map((v) => [v, 1])) } }] };
      const filtered = r.filters
        ? hits.filter((h) => r.filters.toLowerCase().includes(`"${h.vendor.toLowerCase()}"`))
        : hits;
      return { results: [{ hits: filtered, nbHits: filtered.length }] };
    },
  };
}

test("cards that contradict the asked spec are hidden once three match it", async () => {
  A.setClientForTests(fakeClient({
    hits: [
      hit("a1", "IFM IM5033 Inductive Sensor Sn 15 mm"),
      hit("a2", "IFM IA5025 Inductive Sensor 5 mm"),
      hit("a3", "IFM IE5070 Inductive Sensor 5 mm"),
      hit("a4", "IFM IG5554 Inductive Sensor 5 mm"),
    ],
  }));
  const r = await algoliaSearchDetailed("inductive sensor 5 mm", { first: 10 });
  const titles = r.products.map((p) => p.title);
  assert.equal(r.status, "ok");
  assert.ok(!titles.some((t) => /15 mm/.test(t)), JSON.stringify(titles));
  assert.equal(titles.length, 3);
});

test("with fewer than three spec matches the mismatched card stays, ranked last", async () => {
  A.setClientForTests(fakeClient({
    hits: [
      hit("b1", "IFM IM5033 Inductive Sensor Sn 15 mm"),
      hit("b2", "IFM IA5025 Inductive Sensor 5 mm"),
    ],
  }));
  const r = await algoliaSearchDetailed("inductive sensor 5 mm", { first: 10 });
  const titles = r.products.map((p) => p.title);
  assert.equal(titles.length, 2);
  assert.match(titles[0], /5 mm/);
  assert.match(titles[1], /15 mm/);
});

test("brand + product: a brand-only match is graded low, so Claude keeps its search tool", async () => {
  A.setClientForTests(fakeClient({
    hits: [hit("c1", "Siemens 3RT2026 Contactor", "Siemens", { product_type: "Contactors", tags: ["Siemens Contactors"] })],
  }));
  const r = await algoliaSearchDetailed("Siemens proximity sensor", { first: 10 });
  assert.equal(r.status, "ok");
  assert.equal(r.confidence, "low");
});

test("brand-only queries stay high", async () => {
  A.setClientForTests(fakeClient({
    hits: [hit("d1", "ABB ACS480 Inverter Drive", "ABB", { product_type: "Drives", tags: ["ABB Drives"] })],
  }));
  const r = await algoliaSearchDetailed("abb", { first: 10 });
  assert.equal(r.status, "ok");
  assert.equal(r.confidence, "high");
});
