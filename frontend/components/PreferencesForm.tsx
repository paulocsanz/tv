"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n/LocaleProvider";
import type { Locale } from "@/lib/i18n/locale";

// Same set VideoPlayer.tsx recognizes (BCP47 map) - offering more than that
// would just be a preference that never actually applies to anything.
const SUBTITLE_LANGUAGES: Record<string, string> = {
  eng: "English", spa: "Spanish", fre: "French", ger: "German", ita: "Italian",
  por: "Portuguese", rus: "Russian", jpn: "Japanese", kor: "Korean", chi: "Chinese",
  ara: "Arabic", dut: "Dutch", swe: "Swedish", nor: "Norwegian", dan: "Danish",
  fin: "Finnish", pol: "Polish", tur: "Turkish", heb: "Hebrew", hin: "Hindi", gre: "Greek",
};

export function PreferencesForm({
  initialDisplayName,
  initialSubtitleLang,
  initialAutoplayNext,
  initialUiLocale,
}: {
  initialDisplayName: string;
  initialSubtitleLang: string;
  initialAutoplayNext: boolean;
  initialUiLocale: Locale;
}) {
  const router = useRouter();
  const t = useT();
  const [displayName, setDisplayName] = useState(initialDisplayName);
  const [subtitleLang, setSubtitleLang] = useState(initialSubtitleLang);
  const [autoplayNext, setAutoplayNext] = useState(initialAutoplayNext);
  const [uiLocale, setUiLocale] = useState<Locale>(initialUiLocale);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setSaved(false);

    await Promise.all([
      fetch("/api/account/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          display_name: displayName || null,
          default_subtitle_lang: subtitleLang || null,
          autoplay_next: autoplayNext,
          ui_locale: uiLocale,
        }),
      }),
      // Mirrors the choice into the cookie the rest of the app reads (see
      // lib/i18n/locale.ts) so it takes effect on this device immediately,
      // without waiting for a fresh login to pick up the saved preference.
      fetch("/api/locale", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: uiLocale }),
      }),
    ]);

    setPending(false);
    setSaved(true);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4">
      <div>
        <label htmlFor="display-name" className="mb-1 block text-sm text-zinc-400">
          {t.preferences.displayNameLabel}
        </label>
        <input
          id="display-name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-white outline-none focus:border-[#f5c518]"
        />
      </div>
      <div>
        <label htmlFor="ui-locale" className="mb-1 block text-sm text-zinc-400">
          {t.preferences.uiLanguageLabel}
        </label>
        <select
          id="ui-locale"
          value={uiLocale}
          onChange={(e) => setUiLocale(e.target.value as Locale)}
          className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-white outline-none focus:border-[#f5c518]"
        >
          <option value="pt-BR">{t.preferences.uiLanguagePt}</option>
          <option value="en">{t.preferences.uiLanguageEn}</option>
        </select>
      </div>
      <div>
        <label htmlFor="subtitle-lang" className="mb-1 block text-sm text-zinc-400">
          {t.preferences.subtitleLangLabel}
        </label>
        <select
          id="subtitle-lang"
          value={subtitleLang}
          onChange={(e) => setSubtitleLang(e.target.value)}
          className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-white outline-none focus:border-[#f5c518]"
        >
          <option value="">{t.preferences.subtitleNoPreference}</option>
          {Object.entries(SUBTITLE_LANGUAGES).map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <label className="flex items-center gap-2 text-sm text-zinc-300">
        <input
          type="checkbox"
          checked={autoplayNext}
          onChange={(e) => setAutoplayNext(e.target.checked)}
          className="h-4 w-4 rounded border-white/20 bg-white/5"
        />
        {t.preferences.autoplayNext}
      </label>
      {saved && !pending && <p className="text-sm text-green-400">{t.common.saved}</p>}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-[#f5c518] px-3 py-2 font-semibold text-black transition hover:bg-[#e0b613] disabled:opacity-60"
      >
        {pending ? t.common.saving : t.preferences.save}
      </button>
    </form>
  );
}
