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
        <div
          className="mb-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100/90"
          role="status"
        >
          <p className="font-medium text-amber-200">Conexão com o PC da sala caiu</p>
          <p className="mt-1 text-xs leading-relaxed text-amber-100/70">
            Inicie o app da sala no computador de novo, ou continue no player normal desta tela.
          </p>
        </div>
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
