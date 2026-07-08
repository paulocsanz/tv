"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { MetaResponse } from "@/lib/types";

const DECADES = [1920, 1930, 1940, 1950, 1960, 1970, 1980, 1990, 2000, 2010, 2020];

export function FilterBar({ meta }: { meta: MetaResponse }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function setParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    params.delete("page");
    router.push(`/browse?${params.toString()}`);
  }

  const select =
    "rounded-md bg-white/10 px-3 py-1.5 text-sm text-zinc-200 ring-1 ring-inset ring-white/10 outline-none focus:ring-white/30";

  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-4 sm:px-8">
      <select
        className={select}
        value={searchParams.get("type") ?? ""}
        onChange={(e) => setParam("type", e.target.value)}
      >
        <option value="">All Types</option>
        <option value="movie">Movies</option>
        <option value="tv">TV Series</option>
      </select>

      <select
        className={select}
        value={searchParams.get("origin") ?? ""}
        onChange={(e) => setParam("origin", e.target.value)}
      >
        <option value="">All Origins</option>
        <option value="Brazilian">Brazilian</option>
        <option value="International">International</option>
      </select>

      <select
        className={select}
        value={searchParams.get("genre") ?? ""}
        onChange={(e) => setParam("genre", e.target.value)}
      >
        <option value="">All Genres</option>
        {meta.genres.map((g) => (
          <option key={g} value={g}>
            {g}
          </option>
        ))}
      </select>

      <select
        className={select}
        value={searchParams.get("keyword") ?? ""}
        onChange={(e) => setParam("keyword", e.target.value)}
      >
        <option value="">All Themes</option>
        {meta.keywords.map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </select>

      <select
        className={select}
        value={searchParams.get("decade") ?? ""}
        onChange={(e) => setParam("decade", e.target.value)}
      >
        <option value="">All Decades</option>
        {DECADES.filter((d) => d >= meta.year_min - 9 && d <= meta.year_max).map((d) => (
          <option key={d} value={d}>
            {d}s
          </option>
        ))}
      </select>

      <select
        className={select}
        value={searchParams.get("min_rating") ?? ""}
        onChange={(e) => setParam("min_rating", e.target.value)}
      >
        <option value="">Any Rating</option>
        <option value="9">9.0+</option>
        <option value="8">8.0+</option>
        <option value="7">7.0+</option>
        <option value="6">6.0+</option>
      </select>

      <select
        className={select}
        value={searchParams.get("sort") ?? "rating_desc"}
        onChange={(e) => setParam("sort", e.target.value)}
      >
        <option value="rating_desc">Highest Rated</option>
        <option value="rating_asc">Lowest Rated</option>
        <option value="year_desc">Newest</option>
        <option value="year_asc">Oldest</option>
        <option value="title_asc">Title A–Z</option>
      </select>

      {[...searchParams.keys()].length > 0 && (
        <button
          onClick={() => router.push("/browse")}
          className="rounded-md px-3 py-1.5 text-sm text-zinc-400 hover:text-white"
        >
          Clear all
        </button>
      )}
    </div>
  );
}
