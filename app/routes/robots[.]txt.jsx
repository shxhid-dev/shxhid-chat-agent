// app/routes/robots[.]txt.jsx — stops "No route matches URL /robots.txt" errors from crawlers.
export const loader = () =>
  new Response("User-agent: *\nDisallow: /\n", {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" },
  });
