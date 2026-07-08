"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center px-4 text-center">
      <h1 className="mb-2 text-2xl font-bold text-white">
        Top<span className="text-[#f5c518]">400</span>
      </h1>
      <p className="mb-1 text-lg font-semibold text-white">Something went wrong.</p>
      <p className="mb-6 max-w-sm text-sm text-zinc-400">
        The server hit a snag loading this page. It&apos;s usually temporary — give it another try.
      </p>
      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => reset()}
          className="rounded-md bg-[#f5c518] px-4 py-2 text-sm font-semibold text-black transition hover:bg-[#e0b613]"
        >
          Try again
        </button>
        <Link
          href="/"
          className="rounded-md border border-white/10 bg-white/5 px-4 py-2 text-sm text-zinc-200 transition hover:bg-white/10"
        >
          Go home
        </Link>
      </div>
    </div>
  );
}
