/**
 * Cart API Endpoint
 * POST /api/cart — add item to cart via Storefront API
 */

import { addToCart } from '../storefront-service.js';

export function loader({ request }) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: getCorsHeaders(request),
    });
  }
  return new Response('Cart API Ready', { headers: getCorsHeaders(request) });
}

export async function action({ request }) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: getCorsHeaders(request) });
  }

  if (request.method !== 'POST') {
    return new Response('Method not allowed', {
      status: 405,
      headers: getCorsHeaders(request)
    });
  }

  try {
    const body = await request.json();
    const { variantId, cartId } = body;
    // Whole units only, 1-999 ("abc" or 0 used to reach the Storefront API and come back as a 500).
    const qty = Number.parseInt(body.quantity ?? 1, 10);
    const quantity = Number.isFinite(qty) ? Math.min(999, Math.max(1, qty)) : 1;

    console.log(
      `[CartAPI] Request: variant=${variantId?.substring(0, 50)} ` +
      `qty=${quantity} cart=${cartId ? 'existing' : 'new'}`
    );

    if (!variantId) {
      return Response.json(
        { status: 'error', message: 'variantId is required' },
        { status: 400, headers: getCorsHeaders(request) }
      );
    }

    // Validate GID format before calling Storefront API
    if (!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(variantId)) {
      console.error(`[CartAPI] Invalid variant GID: "${variantId}"`);
      return Response.json(
        {
          status: 'error',
          message: `Invalid variantId format. Expected: gid://shopify/ProductVariant/{id}`
        },
        { status: 400, headers: getCorsHeaders(request) }
      );
    }

    let result;
    try {
      result = await addToCart({ variantId, quantity, cartId: cartId || null });
    } catch (cartError) {
      // A completed or expired cart can't take new lines: start a fresh cart once instead of
      // failing every Add to Cart for the rest of the session.
      if (!cartId) throw cartError;
      console.warn(`[CartAPI] Existing cart failed (${cartError.message}) — creating a new cart`);
      result = await addToCart({ variantId, quantity, cartId: null });
    }

    console.log(
      `[CartAPI] Success: cartId=${result.cartId?.substring(0, 30)}... ` +
      `checkout=${result.checkoutUrl ? 'present' : 'missing'}`
    );

    return Response.json({
      status: 'success',
      cartId: result.cartId,
      checkoutUrl: result.checkoutUrl,
      totalQuantity: result.totalQuantity
    }, {
      status: 200,
      headers: getCorsHeaders(request)
    });

  } catch (error) {
    console.error(`[CartAPI] Error: ${error.message}`);

    return Response.json(
      {
        status: 'error',
        // Upstream error text stays in the logs; the shopper gets a plain message.
        message: 'Could not add this item to the cart. Please try again.'
      },
      {
        status: 500,
        headers: getCorsHeaders(request)
      }
    );
  }
}

function getCorsHeaders(request) {
  const origin = request.headers.get('Origin');
  const allowOrigin = origin || '*';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, X-Shopify-Shop-Id',
    ...(origin ? { 'Access-Control-Allow-Credentials': 'true' } : {}),
    'Access-Control-Max-Age': '86400',
  };
}
