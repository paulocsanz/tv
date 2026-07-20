import { getMeOrNull, getPipelineStatusOrNull } from "@/lib/api";
import { AdminNav } from "@/components/AdminNav";
import { NotAuthorized } from "@/components/NotAuthorized";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary, type Dictionary } from "@/lib/i18n/dictionaries";

function timeAgo(seconds: number, t: Dictionary): string {
  if (seconds < 60) return t.admin.secondsAgo.replace("{s}", String(Math.floor(seconds)));
  if (seconds < 3600) return t.admin.minutesAgo.replace("{m}", String(Math.floor(seconds / 60)));
  return t.admin.hoursMinutesAgo
    .replace("{h}", String(Math.floor(seconds / 3600)))
    .replace("{m}", String(Math.floor((seconds % 3600) / 60)));
}

// Deliberately not linked from the global Header/nav, same as /admin/users -
// a direct-URL admin tool. Only meaningful when the backend runs on the same
// machine as the download pipeline (local dev); in a real deployment there's
// no pipeline-events.jsonl to find, and this just reports that plainly.
export default async function AdminPipelinePage() {
  const me = await getMeOrNull();

  if (!me || !me.is_admin) return <NotAuthorized />;

  const t = getDictionary(await getLocale());
  const status = await getPipelineStatusOrNull();

  return (
    <div className="mx-auto max-w-xl px-4 py-12 sm:px-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">{t.admin.pipelineHeading}</h1>
        <AdminNav current="/admin/pipeline" />
      </div>

      {!status ? (
        <p className="text-sm text-zinc-400">{t.admin.pipelineUnreachable}</p>
      ) : (
        <div className="space-y-6">
          <div className="flex items-center gap-2 rounded-lg border border-white/10 px-4 py-3">
            <span
              className={`h-2.5 w-2.5 rounded-full ${status.running ? "bg-green-500" : "bg-zinc-600"}`}
            />
            <span className="text-sm text-zinc-200">
              {status.running
                ? t.admin.runningPid.replace("{pid}", String(status.lock_pid))
                : t.admin.notRunning}
            </span>
          </div>

          {status.last_event && (
            <div className="rounded-lg border border-white/10 px-4 py-3">
              <p className="mb-1 text-xs uppercase tracking-wide text-zinc-500">{t.admin.lastEvent}</p>
              <p className="text-sm text-zinc-200">
                {String(status.last_event.type)}
                {status.last_event.item ? ` — ${String(status.last_event.item)}` : ""}
              </p>
              {status.seconds_since_last_event != null && (
                <p className="mt-1 text-xs text-zinc-500">
                  {timeAgo(status.seconds_since_last_event, t)}
                  {status.seconds_since_last_event > 600 && status.running && (
                    <span className="ml-2 text-amber-400">
                      {t.admin.mayBeStalled.replace(
                        "{minutes}",
                        String(Math.floor(status.seconds_since_last_event / 60))
                      )}
                    </span>
                  )}
                </p>
              )}
            </div>
          )}

          {status.current_run && (
            <div className="rounded-lg border border-white/10 px-4 py-3">
              <p className="mb-2 text-xs uppercase tracking-wide text-zinc-500">{t.admin.currentRun}</p>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <dt className="text-zinc-500">{t.admin.picked}</dt>
                <dd className="text-zinc-200">{status.current_run.picked}</dd>
                <dt className="text-zinc-500">{t.admin.doneThisRun}</dt>
                <dd className="text-zinc-200">{status.current_run.done_this_run}</dd>
                <dt className="text-zinc-500">{t.admin.failedThisRun}</dt>
                <dd className="text-zinc-200">{status.current_run.failed_this_run}</dd>
              </dl>
            </div>
          )}

          {!status.last_event && (
            <p className="text-sm text-zinc-500">{t.admin.noPipelineEvents}</p>
          )}
        </div>
      )}
    </div>
  );
}
