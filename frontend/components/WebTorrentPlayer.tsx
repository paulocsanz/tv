"use client";

import { useEffect, useRef, useState } from "react";
import WebTorrent from "webtorrent";

const MEMORY_WARNING_THRESHOLD = 512 * 1024 * 1024; // 512MB

interface WebTorrentPlayerProps {
  itemId: string;
}

interface TorrentStats {
  progress: number;
  downloadSpeed: number;
  uploadSpeed: number;
  peers: number;
  memoryUsage: number;
}

export function WebTorrentPlayer({ itemId }: WebTorrentPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const clientRef = useRef<WebTorrent.Instance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<TorrentStats>({
    progress: 0,
    downloadSpeed: 0,
    uploadSpeed: 0,
    peers: 0,
    memoryUsage: 0,
  });
  const [memoryWarning, setMemoryWarning] = useState(false);

  useEffect(() => {
    const initTorrent = async () => {
      if (!videoRef.current) return;

      try {
        // Initialize WebTorrent client (singleton pattern)
        if (!clientRef.current) {
          clientRef.current = new WebTorrent({
            maxConnections: 55,
            utp: false,
          });
        }

        const client = clientRef.current;

        // Fetch torrent file from frontend API (which proxies to backend)
        const torrentResponse = await fetch(`/api/torrent/${itemId}`);

        if (!torrentResponse.ok) {
          throw new Error("Failed to fetch torrent file");
        }

        const torrentBlob = await torrentResponse.blob();
        const torrentArrayBuffer = await torrentBlob.arrayBuffer();

        // Add torrent to client
        client.add(new Uint8Array(torrentArrayBuffer), (torrent) => {
          // Find the first video file in the torrent
          const videoFile = torrent.files.find((file) =>
            /\.(mp4|webm|avi|mov)$/i.test(file.name)
          );

          if (!videoFile) {
            setError("No playable video file found in torrent");
            setLoading(false);
            return;
          }

          // Stream file data into memory for browser playback
          const stream = videoFile.createReadStream();
          const chunks: Uint8Array[] = [];

          stream.on("data", (chunk: Uint8Array) => {
            chunks.push(chunk);
          });

          stream.on("end", () => {
            // Create blob from all chunks and set as video source
            const blob = new Blob(chunks, { type: "video/mp4" });
            const blobUrl = URL.createObjectURL(blob);
            if (videoRef.current) {
              videoRef.current.src = blobUrl;
            }
            setLoading(false);
          });

          stream.on("error", (err: Error) => {
            setError(`Streaming error: ${err.message}`);
            setLoading(false);
          });


          // Update stats every second
          const statsInterval = setInterval(() => {
            const downloaded = torrent.downloaded;
            const total = torrent.length;
            const progress = total > 0 ? (downloaded / total) * 100 : 0;

            const perfMemory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
            const memUsage = perfMemory?.usedJSHeapSize || 0;

            setStats({
              progress,
              downloadSpeed: torrent.downloadSpeed || 0,
              uploadSpeed: torrent.uploadSpeed || 0,
              peers: torrent.numPeers || 0,
              memoryUsage: memUsage,
            });

            // Check memory usage
            if (memUsage > MEMORY_WARNING_THRESHOLD) {
              setMemoryWarning(true);
            }
          }, 1000);

          return () => clearInterval(statsInterval);
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load torrent");
        setLoading(false);
      }
    };

    initTorrent();

    return () => {
      // Cleanup on unmount
      if (clientRef.current && clientRef.current.torrents.length === 0) {
        clientRef.current.destroy();
        clientRef.current = null;
      }
    };
  }, [itemId]);

  if (error) {
    return (
      <div className="rounded-lg bg-red-500/10 border border-red-500/30 p-4 text-sm text-red-300">
        <p className="font-semibold">Error loading torrent</p>
        <p>{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {memoryWarning && (
        <div className="rounded-lg bg-yellow-500/10 border border-yellow-500/30 p-3 text-sm text-yellow-300">
          ⚠️ Memory usage is high. Large files may cause performance issues on this device.
        </div>
      )}

      <div className="relative w-full bg-black rounded-lg overflow-hidden">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50">
            <div className="text-center">
              <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-white"></div>
              <p className="mt-2 text-sm text-white">Loading torrent...</p>
            </div>
          </div>
        )}

        <video
          ref={videoRef}
          className="w-full aspect-video"
          controls
          crossOrigin="anonymous"
        />
      </div>

      {/* Stats Display */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        <div className="bg-zinc-900/50 rounded p-2">
          <p className="text-zinc-500">Progress</p>
          <p className="text-white font-semibold">{stats.progress.toFixed(1)}%</p>
        </div>
        <div className="bg-zinc-900/50 rounded p-2">
          <p className="text-zinc-500">Download Speed</p>
          <p className="text-white font-semibold">
            {(stats.downloadSpeed / 1024 / 1024).toFixed(1)} MB/s
          </p>
        </div>
        <div className="bg-zinc-900/50 rounded p-2">
          <p className="text-zinc-500">Peers</p>
          <p className="text-white font-semibold">{stats.peers}</p>
        </div>
        <div className="bg-zinc-900/50 rounded p-2">
          <p className="text-zinc-500">Memory</p>
          <p className="text-white font-semibold">
            {(stats.memoryUsage / 1024 / 1024).toFixed(0)} MB
          </p>
        </div>
      </div>

      <p className="text-xs text-zinc-500">
        💡 WebTorrent streams video while downloading from peers. Download speeds depend on
        available seeders.
      </p>
    </div>
  );
}
