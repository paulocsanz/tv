import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/session";
import { NextResponse } from "next/server";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

/** Proxy rewritten HLS playlist (presigned segment URLs) from the backend. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const requestUrl = new URL(request.url);
  const episode = requestUrl.searchParams.get("episode");
  const backendUrl = new URL(`${API_URL}/api/content/${id}/hls/playlist`);
  if (episode) backendUrl.searchParams.set("episode", episode);

  try {
    const backendRes = await fetch(backendUrl, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    const body = await backendRes.text();
    if (!backendRes.ok) {
      return NextResponse.json(
        { error: body || "Failed to get HLS playlist" },
        { status: backendRes.status || 502 },
      );
    }
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Error fetching HLS playlist:", error);
    return NextResponse.json({ error: "Failed to get HLS playlist" }, { status: 500 });
  }
}
