import Link from "next/link";
import { getMeOrNull, getPipelineStatusOrNull } from "@/lib/api";

function timeAgo(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ago`;
}

// Deliberately not linked from the global Header/nav, same as /admin/users -
// a direct-URL admin tool. Only meaningful when the backend runs on the same
// machine as the download pipeline (local dev); in a real deployment there's
// no pipeline-events.jsonl to find, and this just reports that plainly.
export default async function AdminPipelinePage() {
  const me = await getMeOrNull();

  if (!me || !me.is_admin) {
    return (
      <div className="mx-auto max-w-md px-4 py-24 text-center text-zinc-400">
        Not authorized.
      </div>
    );
  }

  const status = await getPipelineStatusOrNull();

  return (
    <div className="mx-auto max-w-xl px-4 py-12 sm:px-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Pipeline</h1>
        <Link href="/admin/users" className="text-sm text-zinc-400 hover:text-white">
          Accounts →
        </Link>
      </div>

      {!status ? (
        <p className="text-sm text-zinc-400">Couldn&apos;t reach the backend for pipeline status.</p>
      ) : (
        <div className="space-y-6">
          <div className="flex items-center gap-2 rounded-lg border border-white/10 px-4 py-3">
            <span
              className={`h-2.5 w-2.5 rounded-full ${status.running ? "bg-green-500" : "bg-zinc-600"}`}
            />
            <span className="text-sm text-zinc-200">
              {status.running
                ? `Running (pid ${status.lock_pid})`
                : "Not running"}
            </span>
          </div>

          {status.last_event && (
            <div className="rounded-lg border border-white/10 px-4 py-3">
              <p className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Last event</p>
              <p className="text-sm text-zinc-200">
                {String(status.last_event.type)}
                {status.last_event.item ? ` — ${String(status.last_event.item)}` : ""}
              </p>
              {status.seconds_since_last_event != null && (
                <p className="mt-1 text-xs text-zinc-500">
                  {timeAgo(status.seconds_since_last_event)}
                  {status.seconds_since_last_event > 600 && status.running && (
                    <span className="ml-2 text-amber-400">
                      no progress in {Math.floor(status.seconds_since_last_event / 60)}m — may be stalled
                    </span>
                  )}
                </p>
              )}
            </div>
          )}

          {status.current_run && (
            <div className="rounded-lg border border-white/10 px-4 py-3">
              <p className="mb-2 text-xs uppercase tracking-wide text-zinc-500">Current run</p>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <dt className="text-zinc-500">Picked</dt>
                <dd className="text-zinc-200">{status.current_run.picked}</dd>
                <dt className="text-zinc-500">Done this run</dt>
                <dd className="text-zinc-200">{status.current_run.done_this_run}</dd>
                <dt className="text-zinc-500">Failed this run</dt>
                <dd className="text-zinc-200">{status.current_run.failed_this_run}</dd>
              </dl>
            </div>
          )}

          {!status.last_event && (
            <p className="text-sm text-zinc-500">
              No pipeline-events.jsonl found — either it hasn&apos;t run here yet, or this backend
              isn&apos;t running on the same machine as the download pipeline.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
