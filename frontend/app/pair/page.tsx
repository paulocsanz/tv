"use client";

import { FormEvent, useState } from "react";

type Status = "idle" | "pending" | "success" | "expired" | "unauthorized" | "error";

export default function PairDevicePage() {
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<Status>("idle");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("pending");

    const res = await fetch("/api/tv/pair/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });

    if (res.status === 401) {
      setStatus("unauthorized");
      return;
    }
    if (res.status === 410) {
      setStatus("expired");
      return;
    }
    if (!res.ok) {
      setStatus("error");
      return;
    }
    setStatus("success");
  }

  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center px-4">
      <h1 className="mb-6 text-2xl font-bold text-white">Pair a device</h1>

      {status === "success" ? (
        <p className="text-lg text-[#f5c518]">Paired! You can go back to your TV now.</p>
      ) : status === "unauthorized" ? (
        <p className="text-zinc-300">
          You need to sign in first.{" "}
          <a href="/login?next=/pair" className="text-[#f5c518] hover:underline">
            Sign in
          </a>
        </p>
      ) : (
        <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4">
          <div>
            <label htmlFor="code" className="mb-1 block text-sm text-zinc-400">
              Code shown on your TV
            </label>
            <input
              id="code"
              name="code"
              autoComplete="off"
              autoCapitalize="characters"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-center text-xl uppercase tracking-widest text-white outline-none focus:border-[#f5c518]"
            />
          </div>
          {status === "expired" && (
            <p className="text-sm text-red-400">
              That code is invalid or has expired. Generate a new one on your TV.
            </p>
          )}
          {status === "error" && (
            <p className="text-sm text-red-400">Something went wrong. Try again.</p>
          )}
          <button
            type="submit"
            disabled={status === "pending"}
            className="w-full rounded-md bg-[#f5c518] px-3 py-2 font-semibold text-black transition hover:bg-[#e0b613] disabled:opacity-60"
          >
            {status === "pending" ? "Pairing…" : "Pair device"}
          </button>
        </form>
      )}
    </div>
  );
}
