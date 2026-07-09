"use client";

import { FormEvent, useState } from "react";

export function ChangePasswordForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setSuccess(false);

    const res = await fetch("/api/account/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    });

    setPending(false);

    if (res.status === 401) {
      setError("Current password is incorrect.");
      return;
    }
    if (!res.ok) {
      setError("Failed to change password.");
      return;
    }

    setCurrentPassword("");
    setNewPassword("");
    setSuccess(true);
  }

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4">
      <div>
        <label htmlFor="current-password" className="mb-1 block text-sm text-zinc-400">
          Current password
        </label>
        <input
          id="current-password"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          required
          className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-white outline-none focus:border-[#f5c518]"
        />
      </div>
      <div>
        <label htmlFor="new-password" className="mb-1 block text-sm text-zinc-400">
          New password
        </label>
        <input
          id="new-password"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          required
          minLength={8}
          className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-white outline-none focus:border-[#f5c518]"
        />
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {success && <p className="text-sm text-green-400">Password changed.</p>}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-[#f5c518] px-3 py-2 font-semibold text-black transition hover:bg-[#e0b613] disabled:opacity-60"
      >
        {pending ? "Saving…" : "Change password"}
      </button>
    </form>
  );
}
