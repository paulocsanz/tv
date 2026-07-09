"use client";

import { useEffect, useState } from "react";

// Per-browser, not per-account - there's no backend field for "has this user
// seen onboarding" yet, and adding one felt like overkill for a dismissible
// tooltip sequence. Worth revisiting if people keep hitting it on shared
// devices, but that hasn't come up yet.
const SEEN_KEY = "top400_onboarding_seen_v1";

const STEPS = [
  {
    title: "Welcome to Top400",
    body: "A curated catalog of 400 movies and TV series. Here's a 30-second tour.",
  },
  {
    title: "Continue Watching",
    body: "Anything you've started shows up in a row right below the featured title, ordered by when you last watched it.",
  },
  {
    title: "Search & browse",
    body: "Use the search box in the header, or Browse to filter by genre, decade, rating, or keyword.",
  },
  {
    title: "Playback controls",
    body: "← / → skip 10 seconds, Space toggles play/pause. Your spot is saved automatically, even across devices.",
  },
];

export function OnboardingWalkthrough() {
  const [step, setStep] = useState<number | null>(null);

  useEffect(() => {
    // localStorage isn't available during SSR, so this can't be a lazy
    // useState initializer - it has to run post-mount, client-only. A single
    // mount-time check isn't the derived-state-cascade this lint guards
    // against.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!localStorage.getItem(SEEN_KEY)) setStep(0);
  }, []);

  function dismiss() {
    localStorage.setItem(SEEN_KEY, "1");
    setStep(null);
  }

  if (step === null) return null;
  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center">
      <div className="w-full max-w-sm rounded-lg border border-white/10 bg-zinc-900 p-6 shadow-2xl">
        <h2 className="mb-2 text-lg font-bold text-white">{current.title}</h2>
        <p className="mb-6 text-sm text-zinc-400">{current.body}</p>
        <div className="flex items-center justify-between">
          <div className="flex gap-1">
            {STEPS.map((_, i) => (
              <span
                key={i}
                className={`h-1.5 w-1.5 rounded-full ${i === step ? "bg-[#f5c518]" : "bg-white/20"}`}
              />
            ))}
          </div>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={dismiss}
              className="text-sm text-zinc-500 hover:text-zinc-300"
            >
              Skip
            </button>
            <button
              type="button"
              onClick={() => (isLast ? dismiss() : setStep(step + 1))}
              className="rounded-md bg-[#f5c518] px-3 py-1.5 text-sm font-semibold text-black hover:bg-[#e0b613]"
            >
              {isLast ? "Done" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
