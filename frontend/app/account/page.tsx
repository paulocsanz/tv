import { getContinueWatching, getMeOrNull, getUsageSummary } from "@/lib/api";
import { ChangePasswordForm } from "@/components/ChangePasswordForm";
import { PreferencesForm } from "@/components/PreferencesForm";
import { getLocale, parseLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/dictionaries";

export default async function AccountPage() {
  const me = await getMeOrNull();
  const locale = await getLocale();
  const t = getDictionary(locale);

  if (!me) {
    return (
      <div className="mx-auto max-w-md px-4 py-24 text-center text-zinc-400">
        {t.account.notSignedIn}
      </div>
    );
  }

  const [watching, usage] = await Promise.all([getContinueWatching(), getUsageSummary()]);
  const totalMinutes = usage.reduce((sum, u) => sum + u.watch_minutes, 0);

  return (
    <div className="mx-auto max-w-xl px-4 py-12 sm:px-8">
      <h1 className="mb-1 text-2xl font-bold text-white">{t.account.heading}</h1>
      <p className="mb-8 text-sm text-zinc-500">
        {t.account.signedInAs} {me.display_name ?? me.username}
      </p>

      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold text-zinc-100">{t.account.watchHistory}</h2>
        {watching.length === 0 ? (
          <p className="text-sm text-zinc-500">{t.account.nothingInProgress}</p>
        ) : (
          <ul className="divide-y divide-white/10 rounded-lg border border-white/10">
            {watching.map((item) => (
              <li
                key={`${item.id}-${item.episode}`}
                className="flex items-center justify-between px-4 py-3 text-sm"
              >
                <span className="text-zinc-200">{item.title}</span>
                <span className="text-xs text-zinc-500">
                  {Math.round(item.progress_fraction * 100)}%
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {totalMinutes > 0 && (
        <section className="mb-10">
          <h2 className="mb-1 text-lg font-semibold text-zinc-100">{t.account.groupUsage}</h2>
          <p className="mb-3 text-xs text-zinc-500">{t.account.usageDisclaimer}</p>
          <ul className="divide-y divide-white/10 rounded-lg border border-white/10">
            {usage
              .filter((u) => u.watch_minutes > 0)
              .map((u) => (
                <li key={u.user_id} className="px-4 py-3 text-sm">
                  <div className="mb-1 flex items-center justify-between">
                    <span className={u.username === me.username ? "font-medium text-white" : "text-zinc-300"}>
                      {u.display_name ?? u.username}
                    </span>
                    <span className="text-xs text-zinc-500">
                      {Math.round(u.watch_minutes)} min ·{" "}
                      {Math.round((u.watch_minutes / totalMinutes) * 100)}%
                    </span>
                  </div>
                  <div className="h-1 overflow-hidden rounded-full bg-white/5">
                    <div
                      className="h-full bg-[#f5c518]"
                      style={{ width: `${(u.watch_minutes / totalMinutes) * 100}%` }}
                    />
                  </div>
                </li>
              ))}
          </ul>
        </section>
      )}

      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold text-zinc-100">{t.preferences.heading}</h2>
        <PreferencesForm
          initialDisplayName={me.display_name ?? ""}
          initialSubtitleLang={me.default_subtitle_lang ?? ""}
          initialAutoplayNext={me.autoplay_next}
          initialUiLocale={parseLocale(me.ui_locale)}
        />
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-zinc-100">{t.account.passwordHeading}</h2>
        <ChangePasswordForm />
      </section>
    </div>
  );
}
