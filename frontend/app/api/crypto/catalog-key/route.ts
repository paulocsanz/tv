import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/session";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

async function proxy(method: string, request?: Request) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(method === "PUT" ? { "Content-Type": "application/json" } : {}),
    },
    cache: "no-store",
  };
  if (method === "PUT" && request) {
    init.body = await request.text();
  }
  const res = await fetch(`${API_URL}/api/crypto/catalog-key`, init);
  if (res.status === 204) {
    return new NextResponse(null, { status: 204 });
  }
  const body = await res.text();
  return new NextResponse(body || null, {
    status: res.status,
    headers: body ? { "Content-Type": "application/json" } : undefined,
  });
}

export async function GET() {
  return proxy("GET");
}

export async function PUT(request: Request) {
  return proxy("PUT", request);
}
