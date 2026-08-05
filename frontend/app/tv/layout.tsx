import type { ReactNode } from "react";

export default function TvLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-black text-white">
      {/* Overscan-safe padding for TVs that crop edges */}
      <div className="min-h-screen py-6">{children}</div>
    </div>
  );
}
