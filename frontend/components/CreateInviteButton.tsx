"use client";

import { useState } from "react";
import { InviteResponse } from "@/lib/types";
import { useT } from "@/lib/i18n/LocaleProvider";
import {
  attachInviteMediaKeyEnvelope,
  loadCatalogKeyLocal,
  sealCatalogKeyForInvite,
} from "@/lib/crypto/catalog-key";

export function CreateInviteButton() {
  const t = useT();
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mediaAttached, setMediaAttached] = useState(false);

  async function handleClick() {
    setPending(true);
    setError(null);
    setCopied(false);
    setMediaAttached(false);

    try {
      const res = await fetch("/api/admin/invites", { method: "POST" });
      if (!res.ok) {
        setError(t.admin.inviteCreateFailed);
        return;
      }

      const invite = (await res.json()) as InviteResponse;
      // URL carries only the invite token — never the catalog key.
      const url = `${window.location.origin}/signup?token=${invite.token}`;

      // If the admin has the catalog key unlocked, seal it under the invite
      // token and store the envelope server-side (one-shot on signup).
      try {
        const key = await loadCatalogKeyLocal(true);
        if (key) {
          const envelopeHex = await sealCatalogKeyForInvite(key, invite.token);
          await attachInviteMediaKeyEnvelope(invite.token, envelopeHex);
          setMediaAttached(true);
        }
      } catch (e) {
        console.warn("invite media envelope attach failed:", e);
        // Invite still works for account creation without media access.
      }

      setLink(url);
    } finally {
      setPending(false);
    }
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
          <code className="flex-1 overflow-x-auto text-xs text-zinc-300">
            {link.length > 80 ? `${link.slice(0, 40)}…${link.slice(-20)}` : link}
          </code>
          <button
            type="button"
            onClick={handleCopy}
            className="shrink-0 text-xs text-[#f5c518] hover:underline"
          >
            {copied ? t.admin.copied : t.admin.copy}
          </button>
        </div>
      )}
      <p className="text-xs text-zinc-500">
        {t.admin.inviteExpiryNote}
        {mediaAttached && t.admin.inviteMediaKeyAttached}
      </p>
    </div>
  );
}
