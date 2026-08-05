"use client";

import { FormEvent, useEffect, useState } from "react";
import {
  bootstrapCatalogKey,
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
 * - admin first-run: mint catalog key + show pipeline env value
 * - any user with a wrap: re-unlock into IndexedDB after browser clear
 */
export function EncryptionBootstrap({ isAdmin }: { isAdmin: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [password, setPassword] = useState("");
  const [pipelineKey, setPipelineKey] = useState<string | null>(null);
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
        Optional AES-256-GCM (SSESENC1) for new uploads. Existing library stays plaintext until
        re-uploaded. Key never leaves your browser unwrapped.
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

      {status.can_bootstrap && isAdmin && (
        <form onSubmit={handleBootstrap} className="space-y-3 rounded-lg border border-white/10 p-4">
          <p className="text-sm text-zinc-300">
            First-time setup: generate the shared catalog key and wrap it with your password.
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
            className="rounded-md bg-[#f5c518] px-3 py-2 text-sm font-semibold text-black disabled:opacity-60"
          >
            {pending ? "Working…" : "Bootstrap encryption"}
          </button>
        </form>
      )}

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
