import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/session";
import { NextResponse } from "next/server";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

/** Proxy: attach sealed media-key envelope to an invite. */
export async function POST(request: Request) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.text();
  const backendRes = await fetch(`${API_URL}/api/admin/invites/media-key`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body,
  });

  if (backendRes.status === 204) {
    return new NextResponse(null, { status: 204 });
  }
  const text = await backendRes.text();
  return new NextResponse(text || null, {
    status: backendRes.status,
    headers: text ? { "Content-Type": "application/json" } : undefined,
  });
}
