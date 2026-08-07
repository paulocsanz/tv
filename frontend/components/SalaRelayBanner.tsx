"use client";

import { useCallback, useEffect, useState } from "react";
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
  const [err, setErr] = useState<string | null>(null);

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
    }
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => {
      void refresh();
    }, 0);
    const id = window.setInterval(() => {
      void refresh();
    }, 5_000);
    return () => {
      window.clearTimeout(t);
      window.clearInterval(id);
    };
  }, [refresh]);

  if (!relay && !offline) return null;

  if (offline || !relay) {
    return (
      <div className="mb-4 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-zinc-400">
        <p className="font-medium text-zinc-300">{t.sala.noRelayTitle}</p>
        <p className="mt-1 text-xs text-zinc-500">{t.sala.noRelayHint}</p>
      </div>
    );
  }

  const playUrl = `${relay.base_url.replace(/\/$/, "")}/play/${encodeURIComponent(titleId)}/index.m3u8`;

  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-[#f5c518]/30 bg-[#f5c518]/10 px-4 py-3 text-sm">
      <div className="min-w-0 flex-1">
        <p className="font-medium text-[#f5c518]">{t.sala.relayOnline}</p>
        <p className="truncate font-mono text-xs text-zinc-400">{relay.base_url}</p>
        {err && <p className="text-xs text-red-400">{err}</p>}
      </div>
      <button
        type="button"
        onClick={() => onPlayRelay(playUrl)}
        className="shrink-0 rounded-full bg-[#f5c518] px-4 py-2 text-sm font-semibold text-black hover:bg-[#e0b613]"
      >
        {t.sala.playViaSala}
      </button>
    </div>
  );
}
