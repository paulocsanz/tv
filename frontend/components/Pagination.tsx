"use client";

import { useRouter, useSearchParams } from "next/navigation";

export function Pagination({ page, totalPages }: { page: number; totalPages: number }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function goTo(p: number) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("page", String(p));
    router.push(`/browse?${params.toString()}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-center gap-2 py-8">
      <button
        disabled={page <= 1}
        onClick={() => goTo(page - 1)}
        className="rounded-md bg-white/10 px-3 py-1.5 text-sm text-zinc-200 ring-1 ring-inset ring-white/10 disabled:opacity-30"
      >
        ← Prev
      </button>
      <span className="text-sm text-zinc-400">
        Page {page} of {totalPages}
      </span>
      <button
        disabled={page >= totalPages}
        onClick={() => goTo(page + 1)}
        className="rounded-md bg-white/10 px-3 py-1.5 text-sm text-zinc-200 ring-1 ring-inset ring-white/10 disabled:opacity-30"
      >
        Next →
      </button>
    </div>
  );
}
