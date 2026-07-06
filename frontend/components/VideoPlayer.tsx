"use client";

import { useState } from "react";

function episodeLabel(s3Key: string, index: number): string {
  const filename = s3Key.split("/").pop() ?? s3Key;
  const withoutExt = filename.replace(/\.[^./]+$/, "");
  const match = withoutExt.match(/^Ep\s*\d+\s*-\s*([^-]+)/i);
  return match ? `${index + 1}. ${match[1].trim()}` : `Episode ${index + 1}`;
}

export function VideoPlayer({ id, s3Keys }: { id: string; s3Keys: string[] }) {
  const [episode, setEpisode] = useState(1);
  const hasEpisodes = s3Keys.length > 1;
  const streamUrl = hasEpisodes ? `/api/stream/${id}?episode=${episode}` : `/api/stream/${id}`;

  return (
    <div>
      {hasEpisodes && (
        <div className="mb-3 flex flex-wrap gap-2">
          {s3Keys.map((key, i) => (
            <button
              key={key}
              onClick={() => setEpisode(i + 1)}
              className={`rounded-md px-3 py-1.5 text-sm ring-1 ring-inset ring-white/10 ${
                episode === i + 1
                  ? "bg-white text-black"
                  : "bg-white/10 text-zinc-200 hover:bg-white/20"
              }`}
            >
              {episodeLabel(key, i)}
            </button>
          ))}
        </div>
      )}
      <div className="relative w-full overflow-hidden rounded-lg bg-black">
        <video key={streamUrl} className="aspect-video w-full" controls>
          <source src={streamUrl} type="video/mp4" />
          Your browser does not support the video tag.
        </video>
      </div>
    </div>
  );
}
