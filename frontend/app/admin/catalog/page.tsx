import { getCatalogReviewOrNull, getMeOrNull } from "@/lib/api";
import { ResearchButton } from "@/components/ResearchButton";
import { AdminNav } from "@/components/AdminNav";
import { NotAuthorized } from "@/components/NotAuthorized";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/dictionaries";

// Replaces reading *-flagged.json/bloated-uploads.json off disk (RFC 0003 P1)
// - deliberately not linked from the global Header/nav, same as the other
// admin pages.
export default async function AdminCatalogPage() {
  const me = await getMeOrNull();

  if (!me || !me.is_admin) return <NotAuthorized />;

  const t = getDictionary(await getLocale());
  const review = await getCatalogReviewOrNull();

  return (
    <div className="mx-auto max-w-2xl px-4 py-12 sm:px-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">{t.admin.catalogHeading}</h1>
        <AdminNav current="/admin/catalog" />
      </div>

      {!review ? (
        <p className="text-sm text-zinc-400">{t.admin.catalogUnreachable}</p>
      ) : (
        <>
          <section className="mb-10">
            <h2 className="mb-1 text-lg font-semibold text-zinc-100">
              {t.admin.noTorrentOptions.replace("{count}", String(review.no_torrent_options.length))}
            </h2>
            <p className="mb-3 text-xs text-zinc-500">{t.admin.noTorrentOptionsDesc}</p>
            {review.no_torrent_options.length === 0 ? (
              <p className="text-sm text-zinc-500">{t.admin.nothingOutstanding}</p>
            ) : (
              <ul className="divide-y divide-white/10 rounded-lg border border-white/10">
                {review.no_torrent_options.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
                  >
                    <span className="min-w-0 truncate text-zinc-200">{item.title}</span>
                    <ResearchButton id={item.id} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h2 className="mb-3 text-lg font-semibold text-zinc-100">{t.admin.recentEdits}</h2>
            {review.recent_edits.length === 0 ? (
              <p className="text-sm text-zinc-500">{t.admin.noEditsYet}</p>
            ) : (
              <ul className="divide-y divide-white/10 rounded-lg border border-white/10">
                {review.recent_edits.map((edit, i) => (
                  <li key={i} className="px-4 py-3 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-zinc-200">
                        {edit.username} · {edit.action} · {edit.content_id}
                      </span>
                      <span className="text-xs text-zinc-500">
                        {new Date(edit.created_at).toLocaleString()}
                      </span>
                    </div>
                    {edit.detail && <p className="mt-1 text-xs text-zinc-500">{edit.detail}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
