import { defineProject, service } from "@caixote/iac";

/**
 * Torrent acquisition pipeline: download picked magnets → transcode to
 * browser MP4 → upload to the Railway S3 bucket used by the vete app.
 *
 * Deploy:  ./scripts/ops/deploy-pipeline-caixote.sh
 * Logs:    caixote logs torrent-pipeline
 * Monitor: node scripts/ops/monitor-pipeline-caixote.mjs
 *
 * S3 credentials: export from `railway bucket credentials` before apply.
 */
export default defineProject("vete-pipeline", () => {
  const pipeline = service("torrent-pipeline", {
    type: "container",
    role: "worker",
    image: "ghcr.io/paulocsanz/tv-torrent-pipeline:20260807-hls1",
    region: "brasil",
    cpus: 4,
    memory_mb: 8 * 1024,
    disk_mb: 80 * 1024, // 80 GiB — qcow2 sparse, grows on demand
    env: {
      S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID || "",
      S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY || "",
      S3_BUCKET_NAME: process.env.S3_BUCKET_NAME || "",
      S3_ENDPOINT: process.env.S3_ENDPOINT || "",
      S3_REGION: process.env.S3_REGION || "auto",
      S3_URL_STYLE: process.env.S3_URL_STYLE || "virtual-host",
      FFMPEG_H264_ENCODER: "libx264",
      FFMPEG_X264_PRESET: "veryfast",
      MIN_FREE_GB: "1",
      ENCRYPTION_CATALOG_KEY: process.env.ENCRYPTION_CATALOG_KEY || "",
      ENCRYPT_UPLOADS: process.env.ENCRYPT_UPLOADS || "true",
    },
  });

  return { services: [pipeline] };
});
