import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/session";
import { NextResponse } from "next/server";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;

  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const requestUrl = new URL(request.url);
  const episode = requestUrl.searchParams.get("episode");
  // Cast receivers play against an absolute URL they fetch themselves rather
  // than a same-origin <video src> - they can't follow a same-origin redirect
  // the way a browser's video element does, so they need the resolved S3 URL
  // handed to them as data instead.
  const resolve = requestUrl.searchParams.get("resolve") === "1";
  const backendUrl = new URL(`${API_URL}/api/content/${id}/stream`);
  if (episode) backendUrl.searchParams.set("episode", episode);

  try {
    const backendRes = await fetch(backendUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      redirect: "manual",
    });

    const location = backendRes.headers.get("location");
    if (backendRes.status >= 300 && backendRes.status < 400 && location) {
      return resolve ? NextResponse.json({ url: location }) : NextResponse.redirect(location);
    }

    return NextResponse.json(
      { error: "Failed to get stream url" },
      { status: backendRes.status || 502 }
    );
  } catch (error) {
    console.error("Error fetching stream url:", error);
    return NextResponse.json(
      { error: "Failed to get stream url" },
      { status: 500 }
    );
  }
}
