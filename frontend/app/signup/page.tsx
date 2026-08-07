"use client";

import { FormEvent, Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useT } from "@/lib/i18n/LocaleProvider";

function SignupForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useT();
  const token = searchParams.get("token") ?? "";
  // Legacy only: old invites used #mk=base64 in the fragment. New invites use
  // a server-stored envelope sealed under the invite token (no raw key in URL).
  const [legacyMk] = useState(() => {
    if (typeof window === "undefined") return null;
    const match = window.location.hash.match(/[#&]mk=([A-Za-z0-9+/=]+)/);
    return match?.[1] ?? null;
  });
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const res = await fetch("/api/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, username, password, display_name: displayName || null }),
    });

    if (!res.ok) {
      setPending(false);
      if (res.status === 410) {
        setError(t.auth.inviteExpired);
      } else if (res.status === 409) {
        setError(t.auth.usernameTaken);
      } else {
        setError(t.auth.signupFailed);
      }
      return;
    }

    const data = (await res.json().catch(() => ({}))) as {
      media_key_envelope_hex?: string | null;
    };

    // Preferred path: one-shot envelope from signup response, opened with
    // invite token, then wrapped under the new password.
    try {
      const crypto = await import("@/lib/crypto/catalog-key");
      if (data.media_key_envelope_hex) {
        const raw = await crypto.openCatalogKeyFromInviteEnvelope(
          data.media_key_envelope_hex,
          token,
        );
        await crypto.acceptInviteKeyRaw(raw, password);
      } else if (legacyMk) {
        await crypto.acceptInviteKey(legacyMk, password);
      }
    } catch (e) {
      // Account exists; key handoff failed — unlock later from Account.
      console.warn("invite key handoff failed:", e);
    }

    if (legacyMk && typeof window !== "undefined") {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }

    router.push("/");
    router.refresh();
  }

  if (!token) {
    return (
      <p className="max-w-sm text-center text-sm text-zinc-400">{t.auth.needsInvite}</p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4">
      <div>
        <label htmlFor="username" className="mb-1 block text-sm text-zinc-400">
          {t.auth.usernameLabel}
        </label>
        <input
          id="username"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-white outline-none focus:border-[#f5c518]"
        />
      </div>
      <div>
        <label htmlFor="password" className="mb-1 block text-sm text-zinc-400">
          {t.auth.passwordLabel}
        </label>
        <input
          id="password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
          className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-white outline-none focus:border-[#f5c518]"
        />
      </div>
      <div>
        <label htmlFor="display-name" className="mb-1 block text-sm text-zinc-400">
          {t.auth.displayNameLabel} <span className="text-zinc-600">{t.common.optional}</span>
        </label>
        <input
          id="display-name"
          autoComplete="nickname"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder={username || t.auth.displayNamePlaceholder}
          className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-white outline-none focus:border-[#f5c518]"
        />
      </div>
      <p className="text-xs text-zinc-500">
        {t.auth.inviteMediaAccessNote}
      </p>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-[#f5c518] px-3 py-2 font-semibold text-black transition hover:bg-[#e0b613] disabled:opacity-60"
      >
        {pending ? t.auth.creating : t.auth.createAccount}
      </button>
    </form>
  );
}

export default function SignupPage() {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center px-4">
      <h1 className="mb-6 text-2xl font-bold text-white">
        Sess<span className="text-[#f5c518]">ão</span>
      </h1>
      <Suspense>
        <SignupForm />
      </Suspense>
    </div>
  );
}
