"use client";

import { FormEvent, useEffect, useState } from "react";
import {
  bootstrapCatalogKey,
  bootstrapWithExistingKey,
  exportCatalogKeyBase64,
  loadCatalogKeyLocal,
  unlockCatalogKeyFromLogin,
} from "@/lib/crypto/catalog-key";
import { useT } from "@/lib/i18n/LocaleProvider";

type Status = {
  has_wrap: boolean;
  org_has_encryption: boolean;
  can_bootstrap: boolean;
};

/**
 * Account-page panel for RFC 0006:
 * - admin first-run: mint catalog key OR import an existing one (e.g. migrating
 *   from a hardcoded env key when S3 content is already encrypted under it)
 * - any user with a wrap: re-unlock into IndexedDB after browser clear
 * - any user with key unlocked: generate invite links to hand off the key
 */
export function EncryptionBootstrap({ isAdmin }: { isAdmin: boolean }) {
  const t = useT();
  const e = t.account.encryption;
  const [status, setStatus] = useState<Status | null>(null);
  const [password, setPassword] = useState("");
  const [existingKeyB64, setExistingKeyB64] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [pipelineKey, setPipelineKey] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [localUnlocked, setLocalUnlocked] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [statusRes, key] = await Promise.all([
        fetch("/api/crypto/status").then((r) => (r.ok ? r.json() : null)),
        loadCatalogKeyLocal(),
      ]);
      if (cancelled) return;
      setStatus(statusRes as Status | null);
      setLocalUnlocked(Boolean(key));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleBootstrap(ev: FormEvent) {
    ev.preventDefault();
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      const { pipelineKeyB64 } = await bootstrapCatalogKey(password);
      setPipelineKey(pipelineKeyB64);
      setLocalUnlocked(true);
      setMessage(e.bootstrapSuccess);
      setStatus((s) =>
        s
          ? { ...s, has_wrap: true, org_has_encryption: true, can_bootstrap: false }
          : s,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "bootstrap failed");
    } finally {
      setPending(false);
    }
  }

  async function handleImportExisting(ev: FormEvent) {
    ev.preventDefault();
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      await bootstrapWithExistingKey(existingKeyB64, password);
      setLocalUnlocked(true);
      setMessage(e.importSuccess);
      setStatus((s) =>
        s
          ? { ...s, has_wrap: true, org_has_encryption: true, can_bootstrap: false }
          : s,
      );
      setShowImport(false);
      setExistingKeyB64("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "import failed");
    } finally {
      setPending(false);
    }
  }

  async function handleUnlock(ev: FormEvent) {
    ev.preventDefault();
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      const key = await unlockCatalogKeyFromLogin(password);
      if (!key) {
        setError(e.noKeyForAccount);
      } else {
        setLocalUnlocked(true);
        setMessage(e.unlockSuccess);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "unlock failed");
    } finally {
      setPending(false);
    }
  }

  async function handleGenerateInvite() {
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      const key = await loadCatalogKeyLocal(true);
      if (!key) throw new Error(e.noKeyUnlocked);
      const keyB64 = await exportCatalogKeyBase64(key);
      const res = await fetch("/api/admin/invites", { method: "POST" });
      if (!res.ok) throw new Error(t.admin.inviteCreateFailed);
      const invite = (await res.json()) as { token: string };
      setInviteUrl(
        `${window.location.origin}/signup?token=${invite.token}#mk=${keyB64}`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "invite generation failed");
    } finally {
      setPending(false);
    }
  }

  if (!status) {
    return (
      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold text-zinc-100">{e.heading}</h2>
        <p className="text-sm text-zinc-500">{e.loading}</p>
      </section>
    );
  }

  return (
    <section className="mb-10">
      <h2 className="mb-1 text-lg font-semibold text-zinc-100">{e.heading}</h2>
      <p className="mb-3 text-xs text-zinc-500">{e.description}</p>
      <ul className="mb-4 space-y-1 text-sm text-zinc-400">
        <li>
          {e.orgEncryption}{" "}
          <span className="text-zinc-200">
            {status.org_has_encryption ? e.enabled : e.notBootstrapped}
          </span>
        </li>
        <li>
          {e.yourWrap}{" "}
          <span className="text-zinc-200">{status.has_wrap ? e.yes : e.no}</span>
        </li>
        <li>
          {e.unlockedDevice}{" "}
          <span className="text-zinc-200">{localUnlocked ? e.yes : e.no}</span>
        </li>
      </ul>

      {status.can_bootstrap && isAdmin && !showImport && (
        <div className="space-y-3 rounded-lg border border-white/10 p-4">
          <p className="text-sm text-zinc-300">{e.firstTimeSetup}</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setShowImport(true)}
              className="rounded-md bg-white/10 px-3 py-2 text-sm text-white hover:bg-white/20"
            >
              {e.importExisting}
            </button>
            <span className="self-center text-xs text-zinc-600">{e.or}</span>
          </div>
          <form onSubmit={handleBootstrap} className="space-y-3">
            <input
              type="password"
              autoComplete="current-password"
              placeholder={e.passwordToWrap}
              value={password}
              onChange={(ev) => setPassword(ev.target.value)}
              required
              className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-white outline-none focus:border-[#f5c518]"
            />
            <button
              type="submit"
              disabled={pending}
              className="rounded-md bg-[#f5c518] px-3 py-2 text-sm font-semibold text-black disabled:opacity-60"
            >
              {pending ? e.working : e.generateNewKey}
            </button>
          </form>
        </div>
      )}

      {status.can_bootstrap && isAdmin && showImport && (
        <form onSubmit={handleImportExisting} className="space-y-3 rounded-lg border border-white/10 p-4">
          <p className="text-sm text-zinc-300">{e.importExistingDesc}</p>
          <input
            type="text"
            autoComplete="off"
            placeholder={e.keyPlaceholder}
            value={existingKeyB64}
            onChange={(ev) => setExistingKeyB64(ev.target.value)}
            required
            className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 font-mono text-xs text-white outline-none focus:border-[#f5c518]"
          />
          <input
            type="password"
            autoComplete="current-password"
            placeholder={e.yourPassword}
            value={password}
            onChange={(ev) => setPassword(ev.target.value)}
            required
            className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-white outline-none focus:border-[#f5c518]"
          />
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={pending}
              className="rounded-md bg-[#f5c518] px-3 py-2 text-sm font-semibold text-black disabled:opacity-60"
            >
              {pending ? e.working : e.importAndWrap}
            </button>
            <button
              type="button"
              onClick={() => setShowImport(false)}
              className="rounded-md bg-white/5 px-3 py-2 text-sm text-zinc-400 hover:bg-white/10"
            >
              {t.common.cancel}
            </button>
          </div>
        </form>
      )}

      {status.has_wrap && !localUnlocked && (
        <form onSubmit={handleUnlock} className="space-y-3 rounded-lg border border-white/10 p-4">
          <p className="text-sm text-zinc-300">{e.unlockDesc}</p>
          <input
            type="password"
            autoComplete="current-password"
            placeholder={e.yourPassword}
            value={password}
            onChange={(ev) => setPassword(ev.target.value)}
            required
            className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-white outline-none focus:border-[#f5c518]"
          />
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-white/10 px-3 py-2 text-sm text-white hover:bg-white/20 disabled:opacity-60"
          >
            {pending ? e.working : e.unlockButton}
          </button>
        </form>
      )}

      {localUnlocked && (
        <div className="space-y-3 rounded-lg border border-white/10 p-4">
          <p className="text-sm text-zinc-300">{e.inviteDesc}</p>
          <button
            type="button"
            onClick={handleGenerateInvite}
            disabled={pending}
            className="rounded-md bg-white/10 px-3 py-2 text-sm text-white hover:bg-white/20 disabled:opacity-60"
          >
            {pending ? e.working : e.generateInviteWithKey}
          </button>
          {inviteUrl && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 rounded-md border border-white/10 bg-white/5 px-3 py-2">
                <code className="flex-1 overflow-x-auto text-xs text-zinc-300">
                  {inviteUrl.length > 80
                    ? `${inviteUrl.slice(0, 40)}…${inviteUrl.slice(-20)}`
                    : inviteUrl}
                </code>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(inviteUrl);
                    setMessage(e.inviteCopied);
                  }}
                  className="shrink-0 text-xs text-[#f5c518] hover:underline"
                >
                  {t.admin.copy}
                </button>
              </div>
              <p className="text-xs text-amber-400/80">{e.inviteDecryptWarning}</p>
            </div>
          )}
        </div>
      )}

      {pipelineKey && (
        <div className="mt-4 rounded-lg border border-[#f5c518]/40 bg-[#f5c518]/5 p-4">
          <p className="mb-2 text-sm font-medium text-[#f5c518]">{e.pipelineKeyTitle}</p>
          <code className="block break-all text-xs text-zinc-200">{pipelineKey}</code>
          <p className="mt-2 text-xs text-zinc-500">{e.pipelineKeyHint}</p>
        </div>
      )}

      {message && <p className="mt-3 text-sm text-emerald-400">{message}</p>}
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
    </section>
  );
}
