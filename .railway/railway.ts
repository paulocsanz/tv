import { bucket, defineRailway, project, service } from "railway/iac";

export default defineRailway(() => {
  const convenientPannikin = bucket("convenient-pannikin", { region: "iad" });

  // Builds from backend/Dockerfile (Railpack's Rust provider didn't carry
  // the custom `server` binary name into the runtime image correctly).
  const backend = service("backend", {
    healthcheck: "/health",
  });

  // NEXT_PUBLIC_API_URL is set via `railway variable set` once the backend
  // has a public domain (generated domains are not managed from this file).
  const frontend = service("frontend", {
    build: "npm run build",
    start: "npm start",
  });

  return project("tv", {
    resources: [convenientPannikin, backend, frontend],
  });
});
