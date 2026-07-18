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

  const backendUrl = `${API_URL}/api/content/${id}/poster`;

  try {
    const backendRes = await fetch(backendUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      redirect: "manual",
    });

    const location = backendRes.headers.get("location");
    if (backendRes.status >= 300 && backendRes.status < 400 && location) {
      return NextResponse.redirect(location);
    }

    return NextResponse.json(
      { error: "Failed to get poster url" },
      { status: backendRes.status || 502 }
    );
  } catch (error) {
    console.error("Error fetching poster url:", error);
    return NextResponse.json(
      { error: "Failed to get poster url" },
      { status: 500 }
    );
  }
}
