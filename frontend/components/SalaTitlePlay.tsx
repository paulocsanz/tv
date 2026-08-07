"use client";

import { useState } from "react";
import type { EpisodeMetadata, ProgressEntry, SubtitleTrack } from "@/lib/types";
import { VideoPlayer } from "@/components/VideoPlayer";
import { SalaRelayBanner } from "@/components/SalaRelayBanner";

/** Client wrapper: VideoPlayer + optional PC sala relay plain-HLS path. */
export function SalaTitlePlay(props: {
  id: string;
  title: string;
  s3Keys: string[];
  initialProgress: ProgressEntry[];
  subtitles: SubtitleTrack[];
  episodeMetadata: EpisodeMetadata[];
  preferredSubtitleLang: string | null;
  /** Catalog origin ("Brazilian" | "International") — PT audio detection. */
  origin?: string | null;
  autoplayNext: boolean;
  posterUrl: string | null;
  numberedTitles: boolean;
  encrypted: boolean;
  mediaCodecs: string | null;
  runtime: string | null;
  hlsPlaylistS3Key: string | null;
}) {
  const [plainHlsUrl, setPlainHlsUrl] = useState<string | null>(null);
  const [relayGone, setRelayGone] = useState(false);

  return (
    <div>
      <SalaRelayBanner
        titleId={props.id}
        onPlayRelay={(url) => {
          setRelayGone(false);
          setPlainHlsUrl(url);
        }}
      />
      {relayGone && (
        <p className="mb-3 text-sm text-amber-400/90">
          O decryptor da sala parou. Rode o relay no PC de novo ou volte ao player normal.
        </p>
      )}
      <VideoPlayer
        {...props}
        plainHlsUrl={plainHlsUrl}
        onPlainHlsError={() => {
          setPlainHlsUrl(null);
          setRelayGone(true);
        }}
      />
    </div>
  );
}
