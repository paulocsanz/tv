"use client";

import { createContext, useContext } from "react";
import type { Locale } from "./locale";
import { getDictionary } from "./dictionaries";

const LocaleContext = createContext<Locale>("pt-BR");

// The root layout resolves the locale server-side (from the `locale`
// cookie - see lib/i18n/locale.ts) and passes it in here, so client
// components never guess or flash the wrong language on first paint.
export function LocaleProvider({
  locale,
  children,
}: {
  locale: Locale;
  children: React.ReactNode;
}) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useLocale(): Locale {
  return useContext(LocaleContext);
}

// Client-component counterpart to getDictionary() (used directly in server
// components/pages, which already have `locale` from getLocale()).
export function useT() {
  return getDictionary(useLocale());
}
