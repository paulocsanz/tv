import type { Locale } from "../locale";
import ptBR from "./pt-BR";
import en from "./en";

const dictionaries = { "pt-BR": ptBR, en };

export function getDictionary(locale: Locale) {
  return dictionaries[locale];
}

export type { Dictionary } from "./pt-BR";
