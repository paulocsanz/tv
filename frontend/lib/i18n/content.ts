import type { ContentItem } from "@/lib/types";
import type { Locale } from "./locale";

// Swaps in TMDB-sourced pt-BR fields (see models.rs's EnrichedItem and
// backfill-pt-translations.js) when present, falling back to the English
// OMDb-sourced fields otherwise - never a machine translation, so a title
// TMDB has no Portuguese data for just keeps showing English. `awards`,
// `actors`, `director`, and `creator` have no legitimate translated source
// (OMDb-only free text, or proper nouns) and are left untouched in both
// locales.
export function localizeItem<T extends ContentItem>(item: T, locale: Locale): T {
  if (locale !== "pt-BR") return item;
  return {
    ...item,
    title: item.title_pt || item.title,
    plot: item.plot_pt || item.plot,
    genres: item.genres_pt.length > 0 ? item.genres_pt : item.genres,
    rated: item.rated_pt || item.rated,
  };
}
