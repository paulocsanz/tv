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

  try {
    const backendRes = await fetch(`${API_URL}/api/content/${id}/torrent`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!backendRes.ok) {
      return NextResponse.json(
        { error: "Failed to fetch torrent" },
        { status: backendRes.status }
      );
    }

    const buffer = await backendRes.arrayBuffer();
    return new NextResponse(buffer, {
      headers: {
        "Content-Type": "application/x-torrent",
        "Content-Disposition": `attachment; filename="${id}.torrent"`,
      },
    });
  } catch (error) {
    console.error("Error fetching torrent:", error);
    return NextResponse.json(
      { error: "Failed to fetch torrent" },
      { status: 500 }
    );
  }
}
