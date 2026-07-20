import { NextResponse } from "next/server";
import { LOCALE_COOKIE, parseLocale } from "@/lib/i18n/locale";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const locale = parseLocale(body?.locale);

  const res = NextResponse.json({ locale });
  res.cookies.set(LOCALE_COOKIE, locale, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });
  return res;
}
