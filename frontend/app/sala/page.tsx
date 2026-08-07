"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useT } from "@/lib/i18n/LocaleProvider";

type RelayInfo = {
  base_url: string;
  title_id?: string | null;
  age_ms: number;
};

/**
 * Operator page for the living-room decrypt relay (RFC 0011).
 * The actual decrypt process is CLI (`npm run sala:relay`); this page
 * shows status and how to wire SESSAO_TOKEN for discovery on the TV.
 */
export default function SalaPage() {
  const t = useT();
  const [relay, setRelay] = useState<RelayInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const res = await fetch("/api/sala/relay", { cache: "no-store" });
        if (cancelled) return;
        if (res.ok) setRelay(await res.json());
        else setRelay(null);
      } catch {
        if (!cancelled) setRelay(null);
      }
    }
    tick();
    const id = window.setInterval(tick, 4_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  return (
    <div className="mx-auto max-w-2xl px-6 py-12 text-zinc-200">
      <h1 className="mb-2 text-2xl font-bold text-white">{t.sala.pageTitle}</h1>
      <p className="mb-8 text-sm text-zinc-400">{t.sala.pageIntro}</p>

      <section className="mb-8 rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-2 text-sm font-semibold text-[#f5c518]">{t.sala.statusHeading}</h2>
        {relay ? (
          <div>
            <p className="text-emerald-400">{t.sala.relayOnline}</p>
            <code className="mt-2 block break-all font-mono text-xs text-zinc-300">
              {relay.base_url}
            </code>
            <p className="mt-1 text-xs text-zinc-500">
              age {Math.round(relay.age_ms / 1000)}s
            </p>
          </div>
        ) : (
          <p className="text-zinc-400">{t.sala.noRelayTitle}</p>
        )}
      </section>

      <section className="mb-8 space-y-3 rounded-xl border border-white/10 bg-white/5 p-5 text-sm">
        <h2 className="font-semibold text-white">{t.sala.howToHeading}</h2>
        <ol className="list-decimal space-y-2 pl-5 text-zinc-300">
          <li>{t.sala.howTo1}</li>
          <li>
            <code className="rounded bg-black/40 px-1.5 py-0.5 text-xs text-[#f5c518]">
              npm run sala:relay
            </code>
          </li>
          <li>{t.sala.howTo3}</li>
          <li>{t.sala.howTo4}</li>
        </ol>
        <pre className="overflow-x-auto rounded-lg bg-black/50 p-3 text-xs text-zinc-400">
{`set -a && source .env.caixote && set +a
export SESSAO_API_URL=https://backend-production-fbcca.up.railway.app
export SESSAO_TOKEN='<session token after login>'
npm run sala:relay`}
        </pre>
      </section>

      <Link href="/" className="text-sm text-[#f5c518] hover:underline">
        ← {t.common.goHome}
      </Link>
    </div>
  );
}
