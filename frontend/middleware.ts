import { NextRequest, NextResponse } from "next/server";

/** Mark TV shell routes so the root layout can hide desktop chrome. */
export function middleware(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  if (request.nextUrl.pathname.startsWith("/tv")) {
    requestHeaders.set("x-sessao-shell", "tv");
  }
  return NextResponse.next({
    request: { headers: requestHeaders },
  });
}

export const config = {
  matcher: ["/tv/:path*"],
};
