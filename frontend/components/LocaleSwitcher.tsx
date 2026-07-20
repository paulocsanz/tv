"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import type { Locale } from "@/lib/i18n/locale";

// Sets the `locale` cookie (see app/api/locale/route.ts) and refreshes -
// works the same for guests and signed-in users. Signed-in users' choice
// is additionally persisted server-side via PreferencesForm's `ui_locale`
// field, so it survives across devices; this switcher is the fast path
// that always works, cookie-only.
export function LocaleSwitcher() {
  const router = useRouter();
  const locale = useLocale();
  const [pending, setPending] = useState(false);

  async function switchTo(next: Locale) {
    if (next === locale || pending) return;
    setPending(true);
    await fetch("/api/locale", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale: next }),
    });
    router.refresh();
    setPending(false);
  }

  return (
    <div className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-zinc-500">
      <button
        type="button"
        onClick={() => switchTo("pt-BR")}
        disabled={pending}
        className={locale === "pt-BR" ? "text-white" : "hover:text-zinc-300"}
      >
        PT
      </button>
      <span aria-hidden="true">/</span>
      <button
        type="button"
        onClick={() => switchTo("en")}
        disabled={pending}
        className={locale === "en" ? "text-white" : "hover:text-zinc-300"}
      >
        EN
      </button>
    </div>
  );
}
