import { getContinueWatching, getMeOrNull, getUsageSummary } from "@/lib/api";
import { ChangePasswordForm } from "@/components/ChangePasswordForm";
import { PreferencesForm } from "@/components/PreferencesForm";

export default async function AccountPage() {
  const me = await getMeOrNull();

  if (!me) {
    return (
      <div className="mx-auto max-w-md px-4 py-24 text-center text-zinc-400">
        Not signed in.
      </div>
    );
  }

  const [watching, usage] = await Promise.all([getContinueWatching(), getUsageSummary()]);
  const totalMinutes = usage.reduce((sum, u) => sum + u.watch_minutes, 0);

  return (
    <div className="mx-auto max-w-xl px-4 py-12 sm:px-8">
      <h1 className="mb-1 text-2xl font-bold text-white">Account</h1>
      <p className="mb-8 text-sm text-zinc-500">Signed in as {me.display_name ?? me.username}</p>

      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold text-zinc-100">Watch history</h2>
        {watching.length === 0 ? (
          <p className="text-sm text-zinc-500">Nothing in progress yet.</p>
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
          <h2 className="mb-1 text-lg font-semibold text-zinc-100">Group usage</h2>
          <p className="mb-3 text-xs text-zinc-500">
            A rough usage split, not a bill — worth a look if the group ever wants to talk about
            splitting hosting costs.
          </p>
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
        <h2 className="mb-3 text-lg font-semibold text-zinc-100">Preferences</h2>
        <PreferencesForm
          initialDisplayName={me.display_name ?? ""}
          initialSubtitleLang={me.default_subtitle_lang ?? ""}
          initialAutoplayNext={me.autoplay_next}
        />
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-zinc-100">Password</h2>
        <ChangePasswordForm />
      </section>
    </div>
  );
}
