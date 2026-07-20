"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n/LocaleProvider";

export function ResearchButton({ id }: { id: string }) {
  const router = useRouter();
  const t = useT();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function handleClick() {
    setPending(true);
    setResult(null);

    const res = await fetch(`/api/admin/catalog/${id}/research`, { method: "POST" });
    setPending(false);

    if (res.status === 409) {
      setResult(t.admin.pipelineRunningStopFirst);
      return;
    }
    if (!res.ok) {
      setResult(t.admin.searchFailed);
      return;
    }
    const body = (await res.json()) as { found: boolean };
    setResult(body.found ? t.admin.foundOptions : t.admin.stillNothingFound);
    router.refresh();
  }

  return (
    <div className="flex items-center gap-2">
      {result && <span className="text-xs text-zinc-500">{result}</span>}
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        className="shrink-0 rounded-md border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-zinc-300 hover:bg-white/10 disabled:opacity-60"
      >
        {pending ? t.admin.searching : t.admin.reSearch}
      </button>
    </div>
  );
}
