import Link from "next/link";

const PAGES = [
  { href: "/admin/users", label: "Accounts" },
  { href: "/admin/pipeline", label: "Pipeline" },
  { href: "/admin/catalog", label: "Catalog" },
];

export function AdminNav({ current }: { current: "/admin/users" | "/admin/pipeline" | "/admin/catalog" }) {
  return (
    <div className="flex gap-4 text-sm text-zinc-400">
      {PAGES.filter((p) => p.href !== current).map((p) => (
        <Link key={p.href} href={p.href} className="hover:text-white">
          {p.label}
        </Link>
      ))}
    </div>
  );
}
