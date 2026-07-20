"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useT } from "@/lib/i18n/LocaleProvider";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useT();

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center px-4 text-center">
      <h1 className="mb-2 text-2xl font-bold text-white">
        Sess<span className="text-[#f5c518]">ão</span>
      </h1>
      <p className="mb-1 text-lg font-semibold text-white">{t.common.somethingWrong}</p>
      <p className="mb-6 max-w-sm text-sm text-zinc-400">{t.common.errorDescription}</p>
      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => reset()}
          className="rounded-md bg-[#f5c518] px-4 py-2 text-sm font-semibold text-black transition hover:bg-[#e0b613]"
        >
          {t.common.tryAgain}
        </button>
        <Link
          href="/"
          className="rounded-md border border-white/10 bg-white/5 px-4 py-2 text-sm text-zinc-200 transition hover:bg-white/10"
        >
          {t.common.goHome}
        </Link>
      </div>
    </div>
  );
}
