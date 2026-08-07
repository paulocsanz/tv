import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/session";
import { NextResponse } from "next/server";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

async function proxy(method: string, body?: string) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const res = await fetch(`${API_URL}/api/sala/relay`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body,
    cache: "no-store",
  });
  if (res.status === 204) return new NextResponse(null, { status: 204 });
  const text = await res.text();
  return new NextResponse(text || null, {
    status: res.status,
    headers: text ? { "Content-Type": "application/json" } : undefined,
  });
}

export async function GET() {
  return proxy("GET");
}

export async function POST(request: Request) {
  return proxy("POST", await request.text());
}

export async function DELETE() {
  return proxy("DELETE");
}
