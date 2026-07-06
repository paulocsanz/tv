// Railway's edge proxies terminate TLS and forward to the container's
// internal $PORT, so request.url reflects that internal loopback address
// rather than the public domain - redirects built from it point the
// browser at "localhost:<port>" instead of the real site. x-forwarded-host
// carries the real public hostname, when present, but with that same
// internal port suffixed onto it - the public site is always served over
// the implicit 443, so the port is dropped rather than copied over too.
export function absoluteUrl(request: Request, path: string): URL {
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host");
  const proto = request.headers.get("x-forwarded-proto");
  if (host) {
    url.hostname = host.split(":")[0];
    url.port = "";
  }
  if (proto) url.protocol = proto;
  url.pathname = path;
  url.search = "";
  return url;
}
