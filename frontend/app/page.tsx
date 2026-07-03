import { getSections } from "@/lib/api";
import { Hero } from "@/components/Hero";
import { ContentRow } from "@/components/ContentRow";

// Avoid build-time prerendering: this fetches from the Rust backend, which
// isn't reachable during the frontend's own build step.
export const dynamic = "force-dynamic";

export default async function Home() {
  const sections = await getSections();
  const featured = sections.find((s) => s.key === "featured");
  const heroItem = featured?.items[0];
  const rows = sections.filter((s) => s.key !== "featured");

  return (
    <div className="pb-12">
      {heroItem && <Hero item={heroItem} />}
      <div className="mt-4">
        {rows.map((section) => (
          <ContentRow key={section.key} section={section} />
        ))}
      </div>
    </div>
  );
}
