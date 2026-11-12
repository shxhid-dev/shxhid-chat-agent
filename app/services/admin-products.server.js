/**
 * Admin Products / Variants Search — v5.0 (simplified)
 *
 * Only two functions remain:
 *   - searchBySku()    — exact SKU lookup via Admin productVariants(query: "sku:...")
 *   - getAllVendors()  — diagnostics helper
 *
 * Vendor-targeted product search has been removed; the new flow uses Storefront
 * `search` (plain text) for everything that isn't a SKU.
 *
 * Required scope: read_products.
 */

import { shopifyAdminGraphqlQuery } from "../shopify-storefront.js";

const SKU_SEARCH_QUERY = `
  query skuSearch($skuQuery: String!, $first: Int!) {
    productVariants(first: $first, query: $skuQuery) {
      nodes {
        id
        sku
        title
        price
        inventoryQuantity
        product {
          id
          title
          handle
          status
          vendor
          tags
          descriptionHtml
          featuredMedia {
            preview { image { url altText } }
          }
          images(first: 3) {
            nodes { url altText }
          }
          priceRangeV2 {
            minVariantPrice { amount currencyCode }
            maxVariantPrice { amount currencyCode }
          }
        }
      }
    }
  }
`;

const ALL_VENDORS_QUERY = `
  query allVendors {
    products(first: 250, query: "status:active") {
      nodes { vendor }
    }
  }
`;

const ADMIN_TEXT_SEARCH_QUERY = `
  query adminTextSearch($q: String!, $first: Int!) {
    products(first: $first, query: $q) {
      nodes {
        id
        title
        handle
        vendor
        productType
        tags
        descriptionHtml
        featuredMedia { preview { image { url altText } } }
        images(first: 1) { nodes { url altText } }
        priceRangeV2 {
          minVariantPrice { amount currencyCode }
          maxVariantPrice { amount currencyCode }
        }
        variants(first: 1) {
          nodes { id sku availableForSale price }
        }
      }
    }
  }
`;

// Draft and archived products (3,573 drafts) are invisible on the storefront: their card links
// 404 and Add to Cart fails. The variant search has no working status filter, so filter here.
function activeOnly(variants) {
  return (Array.isArray(variants) ? variants : []).filter((v) => !v?.product?.status || v.product.status === "ACTIVE");
}

export async function searchBySku(shopDomain, sku) {
  const skuTrim = String(sku).trim();
  console.log(`[AdminProducts] SKU search: sku:${skuTrim}`);

  try {
    let data = await shopifyAdminGraphqlQuery({
      query: SKU_SEARCH_QUERY,
      variables: { skuQuery: `sku:${skuTrim}`, first: 10 },
      shopDomain,
    });

    let variants = activeOnly(data?.productVariants?.nodes);

    const skuUpper = skuTrim.toUpperCase();
    const exact = variants.filter((v) => v.sku && v.sku.toUpperCase() === skuUpper);
    if (exact.length > 0) {
      console.log(`[AdminProducts] exact SKU match: ${exact.length} variants`);
      return { type: "exact", variants: exact, originalSku: skuTrim };
    }
    if (variants.length > 0) {
      console.log(`[AdminProducts] partial SKU matches: ${variants.length} variants`);
      return { type: "partial", variants, originalSku: skuTrim };
    }

    // Wildcard prefix fallback
    const prefix = skuTrim.replace(/[A-Z0-9]{1,3}$/i, "");
    if (prefix && prefix !== skuTrim && prefix.length >= 3) {
      data = await shopifyAdminGraphqlQuery({
        query: SKU_SEARCH_QUERY,
        variables: { skuQuery: `sku:${prefix}*`, first: 10 },
        shopDomain,
      });
      variants = activeOnly(data?.productVariants?.nodes);
      if (variants.length > 0) {
        console.log(`[AdminProducts] wildcard SKU matches for "${prefix}*": ${variants.length}`);
        return { type: "wildcard", variants, originalSku: skuTrim, prefix };
      }
    }

    console.log(`[AdminProducts] no SKU matches for "${skuTrim}"`);
    return { type: "none", variants: [], originalSku: skuTrim };
  } catch (err) {
    console.error(`[AdminProducts] SKU search failed: ${err.message}`);
    return null;
  }
}

/**
 * Tier-2 text search via Admin GraphQL `products(query: ...)`.
 * Uses Shopify's saved-search syntax (title:* / vendor:*), which is more
 * precise than Storefront `search` (broad full-text). Returns the same
 * shape the Storefront result mapper consumes, so the router can pass
 * the products through storefrontProductToCardShape unchanged.
 *
 * Docs: https://shopify.dev/docs/api/usage/search-syntax
 */
// Tokens shorter than this are noise in 200k-row substring searches.
const MIN_ADMIN_TOKEN_LEN = 3;
// Cap to avoid Shopify rejecting a giant query string.
const MAX_ADMIN_TOKENS = 5;

function _adminTokenize(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9\-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= MIN_ADMIN_TOKEN_LEN)
    .slice(0, MAX_ADMIN_TOKENS);
}

async function _runAdminSearch(searchQuery, shopDomain) {
  console.log(`[AdminProducts] text search: "${searchQuery}"`);
  const data = await shopifyAdminGraphqlQuery({
    query: ADMIN_TEXT_SEARCH_QUERY,
    variables: { q: `status:active AND (${searchQuery})`, first: 10 },
    shopDomain,
  });
  const nodes = data?.products?.nodes || [];
  console.log(`[AdminProducts] text search returned ${nodes.length} products`);
  return nodes;
}

export async function adminTextSearch(query, shopDomain) {
  if (!query || typeof query !== "string") return null;
  const trimmed = query.trim();
  if (!trimmed) return null;

  // Pass 1: token-AND on title for multi-word queries. This is dramatically
  // tighter than `title:*phrase*` at 200k scale (Shopify search-syntax docs:
  // https://shopify.dev/docs/api/usage/search-syntax).
  const tokens = _adminTokenize(trimmed);
  let nodes = [];
  try {
    if (tokens.length === 0) {
      // Fallback to the legacy phrase search for very short queries.
      nodes = await _runAdminSearch(
        `title:*${trimmed}* OR vendor:*${trimmed}*`,
        shopDomain
      );
    } else {
      const andClause = tokens.map((t) => `title:*${t}*`).join(' AND ');
      nodes = await _runAdminSearch(andClause, shopDomain);

      // Pass 2: if zero hits, retry with just the first token, preferring vendor.
      if (nodes.length === 0) {
        const t = tokens[0];
        nodes = await _runAdminSearch(`title:*${t}* OR vendor:*${t}*`, shopDomain);
      }
    }
    if (nodes.length === 0) return null;

    const products = nodes.map((p) => ({
      id: p.id,
      title: p.title,
      handle: p.handle,
      vendor: p.vendor,
      product_type: p.productType,
      tags: p.tags,
      description: (p.descriptionHtml || "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 500),
      image_url:
        p.featuredMedia?.preview?.image?.url ||
        p.images?.nodes?.[0]?.url ||
        null,
      featuredImage:
        p.featuredMedia?.preview?.image || p.images?.nodes?.[0] || null,
      priceRange: p.priceRangeV2,
      variants: (p.variants?.nodes || []).map((v) => ({
        id: v.id,
        sku: v.sku,
        available: v.availableForSale,
        price: v.price,
      })),
      sku: p.variants?.nodes?.[0]?.sku || null,
    }));

    return { products };
  } catch (err) {
    console.warn(`[AdminProducts] text search failed: ${err.message}`);
    return null;
  }
}

export async function getAllVendors(shopDomain) {
  try {
    const data = await shopifyAdminGraphqlQuery({
      query: ALL_VENDORS_QUERY,
      variables: {},
      shopDomain,
    });
    const vendors = [
      ...new Set((data?.products?.nodes || []).map((p) => p.vendor).filter(Boolean)),
    ];
    console.log(`[AdminProducts] found ${vendors.length} unique vendors`);
    return vendors;
  } catch (err) {
    console.error(`[AdminProducts] getAllVendors failed: ${err.message}`);
    return [];
  }
}
