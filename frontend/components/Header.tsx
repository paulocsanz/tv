import Link from "next/link";
import { Suspense } from "react";
import { LogoutButton } from "./LogoutButton";
import { MobileNav } from "./MobileNav";
import { SearchBox } from "./SearchBox";

export function Header() {
  return (
    <header className="sticky top-0 z-30 border-b border-white/5 bg-black/80 backdrop-blur">
      <div className="relative mx-auto flex max-w-7xl items-center gap-4 px-4 py-3 sm:px-8">
        <MobileNav />
        <Link href="/" className="shrink-0 text-lg font-bold tracking-tight text-white">
          Top<span className="text-[#f5c518]">400</span>
        </Link>
        <nav className="hidden gap-4 text-sm text-zinc-300 sm:flex">
          <Link href="/browse?type=movie" className="hover:text-white">
            Movies
          </Link>
          <Link href="/browse?type=tv" className="hover:text-white">
            TV Series
          </Link>
          <Link href="/browse?origin=Brazilian" className="hover:text-white">
            Brazilian
          </Link>
          <Link href="/browse?origin=International" className="hover:text-white">
            International
          </Link>
        </nav>
        <div className="ml-auto w-full max-w-xs">
          <Suspense fallback={<div className="h-8 w-full rounded-full bg-white/10" />}>
            <SearchBox />
          </Suspense>
        </div>
        <LogoutButton />
      </div>
    </header>
  );
}
