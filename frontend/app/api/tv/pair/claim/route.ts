import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/session";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

export async function POST(request: Request) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.text();

  const backendRes = await fetch(`${API_URL}/api/tv/pair/claim`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body,
  });

  const responseBody = await backendRes.text();
  return new NextResponse(responseBody, {
    status: backendRes.status,
    headers: { "Content-Type": "application/json" },
  });
}
