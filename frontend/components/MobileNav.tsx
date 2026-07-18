"use client";

import Link from "next/link";
import { useState } from "react";

const LINKS = [
  { href: "/browse?type=movie", label: "Movies" },
  { href: "/browse?type=tv", label: "TV Series" },
  { href: "/browse?origin=Brazilian", label: "Brazilian" },
  { href: "/browse?origin=International", label: "International" },
  { href: "/browse?type=course", label: "Courses" },
];

export function MobileNav() {
  const [open, setOpen] = useState(false);

  return (
    <div className="sm:hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-zinc-300 hover:bg-white/10 hover:text-white"
      >
        {open ? (
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        )}
      </button>

      {open && (
        <nav className="absolute inset-x-0 top-full z-30 flex flex-col gap-1 border-b border-white/5 bg-black/95 px-4 py-3 backdrop-blur">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
              className="rounded-md px-3 py-2 text-sm text-zinc-300 hover:bg-white/10 hover:text-white"
            >
              {link.label}
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}
