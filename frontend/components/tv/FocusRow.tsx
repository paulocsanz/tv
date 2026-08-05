"use client";

import {
  KeyboardEvent,
  ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

/**
 * Horizontal 10-foot UI row: left/right move focus between children,
 * up/down leave the row (browser default / parent handles vertical).
 * Children should be focusable (buttons/links with tabIndex={0}).
 */
export function FocusRow({
  label,
  children,
  className = "",
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const labelId = useId();
  const [focused, setFocused] = useState(false);

  const focusChild = useCallback((index: number) => {
    const root = listRef.current;
    if (!root) return;
    const items = root.querySelectorAll<HTMLElement>("[data-tv-focus]");
    const el = items[index];
    el?.focus();
  }, []);

  function onKeyDown(e: KeyboardEvent) {
    const root = listRef.current;
    if (!root) return;
    const items = Array.from(root.querySelectorAll<HTMLElement>("[data-tv-focus]"));
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowRight") {
      e.preventDefault();
      focusChild(Math.min(items.length - 1, Math.max(0, current) + 1));
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      focusChild(Math.max(0, (current < 0 ? 0 : current) - 1));
    }
  }

  useEffect(() => {
    // Ensure first card in the first row on the page is focusable on mount
    // only if nothing else is focused yet.
  }, []);

  return (
    <section
      className={`mb-8 ${className}`}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setFocused(false);
      }}
    >
      <h2
        id={labelId}
        className={`mb-3 px-8 text-xl font-semibold tracking-wide ${
          focused ? "text-white" : "text-zinc-300"
        }`}
      >
        {label}
      </h2>
      <div
        ref={listRef}
        role="list"
        aria-labelledby={labelId}
        onKeyDown={onKeyDown}
        className="flex gap-4 overflow-x-auto px-8 pb-2 scrollbar-none"
        style={{ scrollbarWidth: "none" }}
      >
        {children}
      </div>
    </section>
  );
}

export function tvFocusClass(extra = ""): string {
  return [
    "outline-none transition",
    "focus-visible:scale-105 focus-visible:ring-4 focus-visible:ring-[#f5c518]",
    "focus-visible:ring-offset-2 focus-visible:ring-offset-black",
    extra,
  ].join(" ");
}
