import { cookies } from "next/headers";

export const LOCALE_COOKIE = "locale";
export type Locale = "pt-BR" | "en";
export const DEFAULT_LOCALE: Locale = "pt-BR";

export function parseLocale(value: string | undefined | null): Locale {
  return value === "en" ? "en" : DEFAULT_LOCALE;
}

// Server-only: resolves the request's UI locale from the `locale` cookie.
// The cookie is what the language switcher writes to (both for guests and,
// as a mirror of the signed-in user's `ui_locale` preference, once logged
// in - see components/Header.tsx and PreferencesForm.tsx).
export async function getLocale(): Promise<Locale> {
  const store = await cookies();
  return parseLocale(store.get(LOCALE_COOKIE)?.value);
}
