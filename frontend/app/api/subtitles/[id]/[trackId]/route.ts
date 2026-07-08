import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/session";
import { NextResponse } from "next/server";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; trackId: string }> }
) {
  const { id, trackId } = await params;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;

  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const episode = new URL(request.url).searchParams.get("episode");
  const backendUrl = new URL(`${API_URL}/api/content/${id}/subtitles/${trackId}`);
  if (episode) backendUrl.searchParams.set("episode", episode);

  const backendRes = await fetch(backendUrl, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const body = await backendRes.text();
  return new NextResponse(body, {
    status: backendRes.status,
    headers: { "Content-Type": "text/vtt; charset=utf-8" },
  });
}
