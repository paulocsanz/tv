"use client";

import { FormEvent, useEffect, useState } from "react";
import {
  bootstrapCatalogKey,
  bootstrapWithExistingKey,
  exportCatalogKeyBase64,
  loadCatalogKeyLocal,
  unlockCatalogKeyFromLogin,
} from "@/lib/crypto/catalog-key";

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

  async function handleBootstrap(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      const { pipelineKeyB64 } = await bootstrapCatalogKey(password);
      setPipelineKey(pipelineKeyB64);
      setLocalUnlocked(true);
      setMessage(
        "Encryption bootstrapped. Copy the pipeline key into ENCRYPTION_CATALOG_KEY on torrent-pipeline, set ENCRYPT_UPLOADS=true, then new greenfield uploads will be encrypted.",
      );
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

  async function handleImportExisting(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      await bootstrapWithExistingKey(existingKeyB64, password);
      setLocalUnlocked(true);
      setMessage(
        "Existing catalog key imported and wrapped under your password. " +
          "Encrypted titles will now play on this device. " +
          "Generate an invite link below to grant access to other members.",
      );
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

  async function handleUnlock(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      const key = await unlockCatalogKeyFromLogin(password);
      if (!key) {
        setError("No encryption key stored for this account yet.");
      } else {
        setLocalUnlocked(true);
        setMessage("Catalog key unlocked on this device.");
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
      const key = await loadCatalogKeyLocal();
      if (!key) throw new Error("No catalog key unlocked on this device.");
      const keyB64 = await exportCatalogKeyBase64(key);
      const res = await fetch("/api/admin/invites", { method: "POST" });
      if (!res.ok) throw new Error("failed to create invite");
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
        <h2 className="mb-3 text-lg font-semibold text-zinc-100">Storage encryption</h2>
        <p className="text-sm text-zinc-500">Loading…</p>
      </section>
    );
  }

  return (
    <section className="mb-10">
      <h2 className="mb-1 text-lg font-semibold text-zinc-100">Storage encryption</h2>
      <p className="mb-3 text-xs text-zinc-500">
        AES-256-GCM (SSESENC1) media encryption. The shared catalog key is wrapped
        under each member&apos;s password — the server never sees it unwrapped.
        Members gain access through an invite link that carries the key in the URL
        fragment (never sent to the server).
      </p>
      <ul className="mb-4 space-y-1 text-sm text-zinc-400">
        <li>
          Org encryption:{" "}
          <span className="text-zinc-200">
            {status.org_has_encryption ? "enabled" : "not bootstrapped"}
          </span>
        </li>
        <li>
          Your wrap on server:{" "}
          <span className="text-zinc-200">{status.has_wrap ? "yes" : "no"}</span>
        </li>
        <li>
          Unlocked on this device:{" "}
          <span className="text-zinc-200">{localUnlocked ? "yes" : "no"}</span>
        </li>
      </ul>

      {/* Bootstrap: generate new OR import existing */}
      {status.can_bootstrap && isAdmin && !showImport && (
        <div className="space-y-3 rounded-lg border border-white/10 p-4">
          <p className="text-sm text-zinc-300">
            First-time setup. Choose how to provision the catalog key:
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setShowImport(true)}
              className="rounded-md bg-white/10 px-3 py-2 text-sm text-white hover:bg-white/20"
            >
              Import existing key
            </button>
            <span className="self-center text-xs text-zinc-600">or</span>
          </div>
          <form onSubmit={handleBootstrap} className="space-y-3">
            <input
              type="password"
              autoComplete="current-password"
              placeholder="Your password (to wrap the new key)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-white outline-none focus:border-[#f5c518]"
            />
            <button
              type="submit"
              disabled={pending}
              className="rounded-md bg-[#f5c518] px-3 py-2 text-sm font-semibold text-black disabled:opacity-60"
            >
              {pending ? "Working…" : "Generate new catalog key"}
            </button>
          </form>
        </div>
      )}

      {/* Import existing key */}
      {status.can_bootstrap && isAdmin && showImport && (
        <form onSubmit={handleImportExisting} className="space-y-3 rounded-lg border border-white/10 p-4">
          <p className="text-sm text-zinc-300">
            Import an existing catalog key (e.g. when S3 content is already
            encrypted under a key from the pipeline env). Paste the 32-byte base64
            key and your password.
          </p>
          <input
            type="text"
            autoComplete="off"
            placeholder="ENCRYPTION_CATALOG_KEY (base64)"
            value={existingKeyB64}
            onChange={(e) => setExistingKeyB64(e.target.value)}
            required
            className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 font-mono text-xs text-white outline-none focus:border-[#f5c518]"
          />
          <input
            type="password"
            autoComplete="current-password"
            placeholder="Your password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-white outline-none focus:border-[#f5c518]"
          />
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={pending}
              className="rounded-md bg-[#f5c518] px-3 py-2 text-sm font-semibold text-black disabled:opacity-60"
            >
              {pending ? "Working…" : "Import & wrap key"}
            </button>
            <button
              type="button"
              onClick={() => setShowImport(false)}
              className="rounded-md bg-white/5 px-3 py-2 text-sm text-zinc-400 hover:bg-white/10"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Re-unlock after browser clear */}
      {status.has_wrap && !localUnlocked && (
        <form onSubmit={handleUnlock} className="space-y-3 rounded-lg border border-white/10 p-4">
          <p className="text-sm text-zinc-300">
            Re-enter your password to unlock the catalog key on this device.
          </p>
          <input
            type="password"
            autoComplete="current-password"
            placeholder="Your password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-white outline-none focus:border-[#f5c518]"
          />
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-white/10 px-3 py-2 text-sm text-white hover:bg-white/20 disabled:opacity-60"
          >
            {pending ? "Working…" : "Unlock on this device"}
          </button>
        </form>
      )}

      {/* Invite generation */}
      {localUnlocked && (
        <div className="space-y-3 rounded-lg border border-white/10 p-4">
          <p className="text-sm text-zinc-300">
            Invite a new member. The invite link carries the catalog key in the URL
            fragment — copy and send it privately. The recipient wraps the key under
            their own password on signup.
          </p>
          <button
            type="button"
            onClick={handleGenerateInvite}
            disabled={pending}
            className="rounded-md bg-white/10 px-3 py-2 text-sm text-white hover:bg-white/20 disabled:opacity-60"
          >
            {pending ? "Working…" : "Generate invite link with key"}
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
                    setMessage("Invite link copied to clipboard.");
                  }}
                  className="shrink-0 text-xs text-[#f5c518] hover:underline"
                >
                  Copy
                </button>
              </div>
              <p className="text-xs text-amber-400/80">
                This link grants full media decrypt access. Send it only to trusted members.
              </p>
            </div>
          )}
        </div>
      )}

      {pipelineKey && (
        <div className="mt-4 rounded-lg border border-[#f5c518]/40 bg-[#f5c518]/5 p-4">
          <p className="mb-2 text-sm font-medium text-[#f5c518]">
            ENCRYPTION_CATALOG_KEY (pipeline only — store as a secret)
          </p>
          <code className="block break-all text-xs text-zinc-200">{pipelineKey}</code>
          <p className="mt-2 text-xs text-zinc-500">
            Also set ENCRYPT_UPLOADS=true on torrent-pipeline. Do not put this on the web backend.
          </p>
        </div>
      )}

      {message && <p className="mt-3 text-sm text-emerald-400">{message}</p>}
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
    </section>
  );
}
