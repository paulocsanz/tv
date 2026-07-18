import { NextResponse } from "next/server";
import { TV_PENDING_POLL_TOKEN_COOKIE } from "@/lib/session";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

export async function POST() {
  const backendRes = await fetch(`${API_URL}/api/tv/pair/start`, { method: "POST" });

  if (!backendRes.ok) {
    return NextResponse.json({ error: "failed to start pairing" }, { status: backendRes.status });
  }

  const { code, poll_token, expires_at } = (await backendRes.json()) as {
    code: string;
    poll_token: string;
    expires_at: string;
  };

  const response = NextResponse.json({ code, expires_at });
  // Never handed to client JS - /api/tv/pair/poll reads it straight off the
  // request to authenticate the poll, the same role a session cookie plays
  // once one exists.
  response.cookies.set(TV_PENDING_POLL_TOKEN_COOKIE, poll_token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 10,
  });
  return response;
}
