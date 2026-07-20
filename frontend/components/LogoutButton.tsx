"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useT } from "@/lib/i18n/LocaleProvider";

export function LogoutButton() {
  const router = useRouter();
  const t = useT();
  const [pending, setPending] = useState(false);

  async function handleLogout() {
    setPending(true);
    await fetch("/api/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={handleLogout}
      disabled={pending}
      className="shrink-0 text-sm text-zinc-400 hover:text-white disabled:opacity-60"
    >
      {t.nav.logout}
    </button>
  );
}
