"use client";

import { useState } from "react";
import { InviteResponse } from "@/lib/types";
import { useT } from "@/lib/i18n/LocaleProvider";

export function CreateInviteButton() {
  const t = useT();
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setPending(true);
    setError(null);
    setCopied(false);

    const res = await fetch("/api/admin/invites", { method: "POST" });
    setPending(false);

    if (!res.ok) {
      setError(t.admin.inviteCreateFailed);
      return;
    }

    const invite = (await res.json()) as InviteResponse;
    setLink(`${window.location.origin}/signup?token=${invite.token}`);
  }

  async function handleCopy() {
    if (!link) return;
    await navigator.clipboard.writeText(link);
    setCopied(true);
  }

  return (
    <div className="mb-6 space-y-2">
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        className="rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-200 hover:bg-white/10 disabled:opacity-60"
      >
        {pending ? t.admin.generating : t.admin.generateInviteLink}
      </button>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {link && (
        <div className="flex items-center gap-2 rounded-md border border-white/10 bg-white/5 px-3 py-2">
          <code className="flex-1 overflow-x-auto text-xs text-zinc-300">{link}</code>
          <button
            type="button"
            onClick={handleCopy}
            className="shrink-0 text-xs text-[#f5c518] hover:underline"
          >
            {copied ? t.admin.copied : t.admin.copy}
          </button>
        </div>
      )}
      <p className="text-xs text-zinc-500">{t.admin.inviteExpiryNote}</p>
    </div>
  );
}
