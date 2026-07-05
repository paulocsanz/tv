import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/session";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

export async function POST() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;

  if (token) {
    await fetch(`${API_URL}/api/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.delete(SESSION_COOKIE);
  return response;
}

// Used by server-side `redirect("/api/logout")` calls (e.g. apiFetch's 401
// handler) to clear a stale session cookie. A Server Component can't delete
// cookies itself — only a Route Handler, Server Action, or middleware can —
// so without this GET handler the browser keeps resending the dead cookie
// and proxy.ts bounces it between "/" and "/login" forever.
export async function GET(request: Request) {
  const response = NextResponse.redirect(new URL("/login", request.url));
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
