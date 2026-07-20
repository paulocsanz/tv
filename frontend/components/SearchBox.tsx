"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useRef, useState } from "react";
import { useT } from "@/lib/i18n/LocaleProvider";

export function SearchBox() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const t = useT();
  const [value, setValue] = useState(searchParams.get("search") ?? "");
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function navigate(next: string) {
    const params = new URLSearchParams(pathname === "/browse" ? searchParams.toString() : "");
    if (next.trim()) {
      params.set("search", next.trim());
    } else {
      params.delete("search");
    }
    params.delete("page");
    const qs = params.toString();
    const url = `/browse${qs ? `?${qs}` : ""}`;
    if (pathname === "/browse") {
      router.replace(url);
    } else {
      router.push(url);
    }
  }

  function scheduleNavigate(next: string) {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => navigate(next), 250);
  }

  return (
    <input
      type="search"
      value={value}
      onChange={(e) => {
        setValue(e.target.value);
        scheduleNavigate(e.target.value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          if (timeoutRef.current) clearTimeout(timeoutRef.current);
          navigate(value);
        }
      }}
      placeholder={t.nav.searchPlaceholder}
      className="w-full rounded-md bg-white/10 px-4 py-1.5 text-sm text-white placeholder-zinc-500 outline-none ring-1 ring-inset ring-white/10 focus:ring-white/30"
    />
  );
}
