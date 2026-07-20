import Link from "next/link";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/dictionaries";

export async function AdminNav({
  current,
}: {
  current: "/admin/users" | "/admin/pipeline" | "/admin/catalog";
}) {
  const t = getDictionary(await getLocale());

  const pages = [
    { href: "/admin/users", label: t.admin.accountsHeading },
    { href: "/admin/pipeline", label: t.admin.pipelineHeading },
    { href: "/admin/catalog", label: t.admin.catalogHeading },
  ];

  return (
    <div className="flex gap-4 text-sm text-zinc-400">
      {pages.filter((p) => p.href !== current).map((p) => (
        <Link key={p.href} href={p.href} className="hover:text-white">
          {p.label}
        </Link>
      ))}
    </div>
  );
}
