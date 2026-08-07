/**
 * HLS AES-128 playback with catalog key injected via custom hls.js loader
 * (RFC 0009). Playlist URI uses sessao-key:catalog — never fetched from S3.
 */

import Hls from "hls.js";
import { exportCatalogKeyRaw } from "@/lib/crypto/catalog-key";

export const SESSAO_KEY_URI = "sessao-key:catalog";

/** First 16 bytes of the 32-byte catalog key = HLS AES-128 key. */
export async function hlsAes128KeyFromCatalog(
  catalogKey: CryptoKey,
): Promise<Uint8Array> {
  const raw = await exportCatalogKeyRaw(catalogKey);
  if (raw.length < 16) throw new Error("catalog key too short for HLS AES-128");
  return raw.subarray(0, 16);
}

export type HlsAttachResult = {
  hls: Hls;
  mode: "hls";
  revoke: () => void;
};

/**
 * Attach hls.js to a video element. Playlist URL should be same-origin
 * `/api/hls/{id}` (rewritten segment URLs). Catalog key supplies AES-128.
 */
export async function attachHlsPlayback(
  video: HTMLVideoElement,
  playlistUrl: string,
  catalogKey: CryptoKey,
): Promise<HlsAttachResult> {
  if (!Hls.isSupported()) {
    // Safari can play native HLS but not our custom key URI without a service
    // worker — require hls.js MSE path everywhere we control.
    throw new Error("HLS MSE not supported in this browser");
  }

  const keyBytes = await hlsAes128KeyFromCatalog(catalogKey);
  // hls.js key response must be ArrayBuffer-like.
  const keyBuffer = keyBytes.buffer.slice(
    keyBytes.byteOffset,
    keyBytes.byteOffset + keyBytes.byteLength,
  );

  const BaseLoader = Hls.DefaultConfig.loader;

  class CatalogKeyLoader extends BaseLoader {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    load(context: any, config: any, callbacks: any) {
      const url: string = context?.url || "";
      if (
        context?.type === "key" ||
        url === SESSAO_KEY_URI ||
        url.startsWith("sessao-key:")
      ) {
        // Synchronous success path — no network.
        const stats = {
          aborted: false,
          loaded: keyBuffer.byteLength,
          retry: 0,
          total: keyBuffer.byteLength,
          chunkCount: 1,
          bwEstimate: 0,
          loading: { start: 0, first: 0, end: 0 },
          parsing: { start: 0, end: 0 },
          buffering: { start: 0, first: 0, end: 0 },
        };
        // Defer so hls.js finishes registering the load.
        Promise.resolve().then(() => {
          callbacks.onSuccess(
            { url: SESSAO_KEY_URI, data: keyBuffer },
            stats,
            context,
            null,
          );
        });
        return;
      }
      super.load(context, config, callbacks);
    }
  }

  const hls = new Hls({
    enableWorker: true,
    lowLatencyMode: false,
    // Segment retry — core resilience win vs progressive SSESENC1.
    fragLoadingMaxRetry: 6,
    fragLoadingRetryDelay: 1000,
    manifestLoadingMaxRetry: 4,
    levelLoadingMaxRetry: 4,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    loader: CatalogKeyLoader as any,
  });

  hls.loadSource(playlistUrl);
  hls.attachMedia(video);

  await new Promise<void>((resolve, reject) => {
    const onError = (_: unknown, data: { fatal?: boolean; type?: string; details?: string }) => {
      if (data.fatal) {
        hls.off(Hls.Events.MANIFEST_PARSED, onParsed);
        hls.off(Hls.Events.ERROR, onError);
        reject(
          new Error(
            `HLS fatal: ${data.type || "error"} ${data.details || ""}`.trim(),
          ),
        );
      }
    };
    const onParsed = () => {
      hls.off(Hls.Events.MANIFEST_PARSED, onParsed);
      hls.off(Hls.Events.ERROR, onError);
      resolve();
    };
    hls.on(Hls.Events.MANIFEST_PARSED, onParsed);
    hls.on(Hls.Events.ERROR, onError);
  });

  return {
    hls,
    mode: "hls",
    revoke: () => {
      try {
        hls.destroy();
      } catch {
        /* ignore */
      }
    },
  };
}
