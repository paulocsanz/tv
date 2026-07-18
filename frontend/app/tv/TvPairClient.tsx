"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

const POLL_INTERVAL_MS = 3000;

function formatCode(code: string): string {
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

export function TvPairClient({ origin }: { origin: string }) {
  const router = useRouter();
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const startingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      const res = await fetch("/api/tv/pair/poll");
      if (cancelled) return;

      if (res.status === 202) {
        pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
        return;
      }

      if (res.status === 410) {
        await start();
        return;
      }

      if (res.ok) {
        router.push("/");
        router.refresh();
        return;
      }

      setError("Something went wrong. Retrying…");
      pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
    }

    async function start() {
      if (startingRef.current) return;
      startingRef.current = true;
      setError(null);

      const res = await fetch("/api/tv/pair/start", { method: "POST" });
      startingRef.current = false;
      if (cancelled) return;

      if (!res.ok) {
        setError("Couldn't generate a pairing code. Retrying…");
        pollTimer = setTimeout(start, POLL_INTERVAL_MS);
        return;
      }

      const data = (await res.json()) as { code: string; expires_at: string };
      setCode(data.code);
      pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
    }

    start();

    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [router]);

  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center px-4 text-center">
      <h1 className="mb-8 text-2xl font-bold text-white">
        Sess<span className="text-[#f5c518]">ão</span>
      </h1>
      <p className="mb-6 text-lg text-zinc-300">
        On your phone or computer, go to{" "}
        <span className="text-white">{origin ? `${origin}/pair` : "/pair"}</span> and enter this
        code:
      </p>
      {code ? (
        <p className="text-6xl font-bold tracking-[0.3em] text-[#f5c518]">{formatCode(code)}</p>
      ) : (
        <p className="text-lg text-zinc-500">Generating code…</p>
      )}
      {error && <p className="mt-6 text-sm text-red-400">{error}</p>}
    </div>
  );
}
