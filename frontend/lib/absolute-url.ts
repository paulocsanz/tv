// Railway's edge proxies terminate TLS and forward to the container's
// internal $PORT, so request.url reflects that internal loopback address
// rather than the public domain - redirects built from it point the
// browser at "localhost:<port>" instead of the real site. x-forwarded-host
// / x-forwarded-proto carry the actual public origin, when present.
export function absoluteUrl(request: Request, path: string): URL {
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host");
  const proto = request.headers.get("x-forwarded-proto");
  if (host) url.host = host;
  if (proto) url.protocol = proto;
  url.pathname = path;
  url.search = "";
  return url;
}
