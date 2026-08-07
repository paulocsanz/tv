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
 * Primary UX is human steps; CLI is optional advanced detail.
 */
export default function SalaPage() {
  const t = useT();
  const [relay, setRelay] = useState<RelayInfo | null>(null);
  const [showCli, setShowCli] = useState(false);

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
      <h1 className="mb-2 text-2xl font-bold tracking-tight text-white">{t.sala.pageTitle}</h1>
      <p className="mb-8 text-sm leading-relaxed text-zinc-400">{t.sala.pageIntro}</p>

      <section className="mb-6 overflow-hidden rounded-2xl border border-white/10 bg-zinc-900/80 p-5 shadow-lg shadow-black/30">
        <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-[#f5c518]">
          {t.sala.statusHeading}
        </h2>
        {relay ? (
          <div>
            <p className="flex items-center gap-2 font-semibold text-emerald-400">
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" aria-hidden />
              {t.sala.relayOnline}
            </p>
            <code className="mt-2 block break-all rounded-lg bg-black/40 px-3 py-2 font-mono text-xs text-zinc-300">
              {relay.base_url}
            </code>
            <p className="mt-2 text-xs text-zinc-500">
              ativo há {Math.round(relay.age_ms / 1000)}s
            </p>
          </div>
        ) : (
          <div>
            <p className="font-semibold text-white">{t.sala.noRelayTitle}</p>
            <p className="mt-2 text-sm leading-relaxed text-zinc-400">{t.sala.noRelayHint}</p>
            <ol className="mt-4 space-y-2.5">
              {[t.sala.noRelayStep1, t.sala.noRelayStep2, t.sala.noRelayStep3].map((step, i) => (
                <li key={i} className="flex gap-3 text-sm text-zinc-300">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/10 text-xs font-bold text-[#f5c518]">
                    {i + 1}
                  </span>
                  <span className="pt-0.5 leading-snug">{step}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </section>

      <section className="mb-8 space-y-3 rounded-2xl border border-white/10 bg-white/[0.04] p-5 text-sm">
        <h2 className="font-semibold text-white">{t.sala.howToHeading}</h2>
        <ol className="list-decimal space-y-2 pl-5 text-zinc-300">
          <li>{t.sala.howTo1}</li>
          <li>{t.sala.howTo3}</li>
          <li>{t.sala.howTo4}</li>
        </ol>
        <button
          type="button"
          onClick={() => setShowCli((v) => !v)}
          className="text-xs font-medium text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline"
        >
          {showCli ? "− " : "+ "}
          {t.sala.noRelayCliLabel}
        </button>
        {showCli && (
          <pre className="overflow-x-auto rounded-xl border border-white/5 bg-black/50 p-3 text-xs leading-relaxed text-zinc-400">
{`set -a && source .env.caixote && set +a
export SESSAO_API_URL=https://backend-production-fbcca.up.railway.app
export SESSAO_TOKEN='<session token after login>'
${t.sala.noRelayCliCmd}`}
          </pre>
        )}
      </section>

      <Link href="/" className="text-sm font-medium text-[#f5c518] hover:underline">
        ← {t.common.goHome}
      </Link>
    </div>
  );
}
