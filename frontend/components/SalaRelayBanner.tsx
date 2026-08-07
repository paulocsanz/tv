"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useT } from "@/lib/i18n/LocaleProvider";

type RelayInfo = {
  base_url: string;
  title_id?: string | null;
  age_ms: number;
  play_url?: string | null;
};

/**
 * Discovers a PC "sala" decrypt relay (RFC 0011) for the logged-in user and
 * offers one-click plain-HLS playback on this device (TV shell / phone).
 */
export function SalaRelayBanner({
  titleId,
  onPlayRelay,
}: {
  titleId: string;
  /** Called with absolute plain HLS URL on the LAN. */
  onPlayRelay: (plainHlsUrl: string) => void;
}) {
  const t = useT();
  const [relay, setRelay] = useState<RelayInfo | null>(null);
  const [offline, setOffline] = useState(false);
  const [checking, setChecking] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showCli, setShowCli] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/sala/relay", { cache: "no-store" });
      if (res.status === 404) {
        setRelay(null);
        setOffline(true);
        setErr(null);
        return;
      }
      if (!res.ok) {
        setRelay(null);
        setOffline(true);
        setErr(`relay ${res.status}`);
        return;
      }
      const data = (await res.json()) as RelayInfo;
      setRelay(data);
      setOffline(false);
      setErr(null);
    } catch {
      setRelay(null);
      setOffline(true);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    const t0 = window.setTimeout(() => {
      void refresh();
    }, 0);
    const id = window.setInterval(() => {
      void refresh();
    }, 5_000);
    return () => {
      window.clearTimeout(t0);
      window.clearInterval(id);
    };
  }, [refresh]);

  if (checking && !relay && !offline) {
    return (
      <div
        className="mb-4 rounded-2xl border border-white/10 bg-zinc-900/80 px-4 py-4 text-sm text-zinc-400"
        role="status"
      >
        <div className="flex items-center gap-3">
          <span
            className="inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-zinc-600 border-t-[#f5c518]"
            aria-hidden
          />
          <p>{t.sala.noRelayChecking}</p>
        </div>
      </div>
    );
  }

  if (offline || !relay) {
    return (
      <div
        className="mb-4 overflow-hidden rounded-2xl border border-amber-500/25 bg-gradient-to-b from-amber-500/10 to-zinc-900/90 shadow-lg shadow-black/40"
        role="status"
      >
        <div className="flex gap-3 px-4 pb-3 pt-4 sm:px-5">
          <div
            className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-lg"
            aria-hidden
          >
            📺
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-base font-semibold tracking-tight text-white">{t.sala.noRelayTitle}</p>
            <p className="mt-1 text-sm leading-relaxed text-zinc-400">{t.sala.noRelayHint}</p>
          </div>
        </div>

        <ol className="mx-4 mb-3 space-y-2 rounded-xl border border-white/5 bg-black/25 px-3 py-3 text-sm sm:mx-5">
          {[t.sala.noRelayStep1, t.sala.noRelayStep2, t.sala.noRelayStep3].map((step, i) => (
            <li key={i} className="flex gap-3 text-zinc-300">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/10 text-xs font-bold text-[#f5c518]">
                {i + 1}
              </span>
              <span className="pt-0.5 leading-snug">{step}</span>
            </li>
          ))}
        </ol>

        <div className="flex flex-wrap items-center gap-2 border-t border-white/10 px-4 py-3 sm:px-5">
          <button
            type="button"
            onClick={() => {
              setChecking(true);
              void refresh();
            }}
            className="rounded-full bg-[#f5c518] px-4 py-2 text-sm font-semibold text-black hover:bg-[#e0b613]"
          >
            {t.sala.noRelayRetry}
          </button>
          <Link
            href="/sala"
            className="rounded-full border border-white/15 px-4 py-2 text-sm font-medium text-zinc-200 hover:border-white/30 hover:bg-white/5"
          >
            {t.sala.noRelayLearnMore}
          </Link>
          <button
            type="button"
            onClick={() => setShowCli((v) => !v)}
            className="ml-auto text-xs font-medium text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline"
          >
            {showCli ? "− " : "+ "}
            {t.sala.noRelayCliLabel}
          </button>
        </div>

        {showCli && (
          <div className="border-t border-white/10 bg-black/40 px-4 py-3 sm:px-5">
            <p className="mb-2 text-xs text-zinc-500">{t.sala.noRelayCliLabel}</p>
            <code className="block overflow-x-auto rounded-lg bg-black/60 px-3 py-2 font-mono text-xs text-[#f5c518]">
              {t.sala.noRelayCliCmd}
            </code>
          </div>
        )}
      </div>
    );
  }

  const playUrl = `${relay.base_url.replace(/\/$/, "")}/play/${encodeURIComponent(titleId)}/index.m3u8`;

  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm sm:px-5">
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-emerald-300">{t.sala.relayOnline}</p>
        <p className="mt-0.5 truncate font-mono text-xs text-zinc-500" title={relay.base_url}>
          {relay.base_url}
        </p>
        {err && <p className="text-xs text-red-400">{err}</p>}
      </div>
      <button
        type="button"
        onClick={() => onPlayRelay(playUrl)}
        className="shrink-0 rounded-full bg-[#f5c518] px-4 py-2.5 text-sm font-semibold text-black hover:bg-[#e0b613]"
      >
        {t.sala.playViaSala}
      </button>
    </div>
  );
}
