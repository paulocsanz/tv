import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE, TV_PENDING_POLL_TOKEN_COOKIE } from "@/lib/session";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

export async function GET() {
  const pollToken = (await cookies()).get(TV_PENDING_POLL_TOKEN_COOKIE)?.value;
  if (!pollToken) {
    return NextResponse.json({ error: "no pairing in progress" }, { status: 400 });
  }

  const backendRes = await fetch(
    `${API_URL}/api/tv/pair/poll?poll_token=${encodeURIComponent(pollToken)}`,
  );

  if (backendRes.status === 202) {
    return new NextResponse(null, { status: 202 });
  }

  if (backendRes.status === 410) {
    const response = NextResponse.json({ error: "pairing code expired" }, { status: 410 });
    response.cookies.delete(TV_PENDING_POLL_TOKEN_COOKIE);
    return response;
  }

  if (!backendRes.ok) {
    return NextResponse.json({ error: "failed to poll pairing" }, { status: backendRes.status });
  }

  const { token } = (await backendRes.json()) as { token: string };

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  response.cookies.delete(TV_PENDING_POLL_TOKEN_COOKIE);
  return response;
}
