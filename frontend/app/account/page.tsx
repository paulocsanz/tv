import { getContinueWatching, getMeOrNull } from "@/lib/api";
import { ChangePasswordForm } from "@/components/ChangePasswordForm";

export default async function AccountPage() {
  const me = await getMeOrNull();

  if (!me) {
    return (
      <div className="mx-auto max-w-md px-4 py-24 text-center text-zinc-400">
        Not signed in.
      </div>
    );
  }

  const watching = await getContinueWatching();

  return (
    <div className="mx-auto max-w-xl px-4 py-12 sm:px-8">
      <h1 className="mb-1 text-2xl font-bold text-white">Account</h1>
      <p className="mb-8 text-sm text-zinc-500">Signed in as {me.username}</p>

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

      <section>
        <h2 className="mb-3 text-lg font-semibold text-zinc-100">Password</h2>
        <ChangePasswordForm />
      </section>
    </div>
  );
}
