import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/session";
import { absoluteUrl } from "@/lib/absolute-url";

const PUBLIC_PATHS = ["/login", "/signup"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`)
  );
  const hasSession = request.cookies.has(SESSION_COOKIE);

  // TV shell marker (was middleware.ts) — root layout hides desktop chrome.
  const requestHeaders = new Headers(request.headers);
  if (pathname.startsWith("/tv")) {
    requestHeaders.set("x-sessao-shell", "tv");
  }

  if (!hasSession && !isPublic) {
    const loginUrl = absoluteUrl(request, "/login");
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (hasSession && pathname === "/login") {
    return NextResponse.redirect(absoluteUrl(request, "/"));
  }

  return NextResponse.next({
    request: { headers: requestHeaders },
  });
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
