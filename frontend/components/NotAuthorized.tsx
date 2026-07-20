import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/dictionaries";

export async function NotAuthorized() {
  const t = getDictionary(await getLocale());

  return (
    <div className="mx-auto max-w-md px-4 py-24 text-center text-zinc-400">
      {t.admin.notAuthorized}
    </div>
  );
}
