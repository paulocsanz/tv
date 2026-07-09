import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/session";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const token = body?.token;
  const username = body?.username;
  const password = body?.password;
  const displayName = body?.display_name;

  if (typeof token !== "string" || typeof username !== "string" || typeof password !== "string") {
    return NextResponse.json({ error: "token, username and password are required" }, { status: 400 });
  }

  const backendRes = await fetch(`${API_URL}/api/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token,
      username,
      password,
      display_name: typeof displayName === "string" ? displayName : null,
    }),
  });

  if (!backendRes.ok) {
    const responseBody = await backendRes.text();
    return new NextResponse(responseBody, {
      status: backendRes.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { token: sessionToken } = (await backendRes.json()) as { token: string };

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return response;
}
