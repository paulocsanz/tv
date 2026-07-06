import { bucket, defineRailway, github, postgres, preserve, project, service } from "railway/iac";

export default defineRailway(() => {
  const tv = github("paulocsanz/tv");

  const convenientPannikin = bucket("convenient-pannikin", { region: "iad" });

  // Backs the account system and per-user watch progress (see
  // backend/migrations). `db.env.DATABASE_URL` is Railway's private
  // connection string - internal network, no TLS-terminating proxy hop -
  // deliberately not DATABASE_PUBLIC_URL.
  const db = postgres("db");

  const frontend = service("frontend", {
    source: tv,
    root: "frontend",
    build: "npm run build",
    start: "npm start",
    replicas: 1,
    env: {
      NEXT_PUBLIC_API_URL: preserve(),
    },
  });
  const backend = service("backend", {
    source: tv,
    root: "backend",
    build: { buildCommand: "cargo build --release --bin server", buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    healthcheck: "/health",
    replicas: 1,
    env: {
      ADMIN_PASSWORD: preserve(),
      ADMIN_USERNAME: preserve(),
      AWS_ACCESS_KEY_ID: preserve(),
      AWS_DEFAULT_REGION: preserve(),
      AWS_ENDPOINT_URL: preserve(),
      AWS_S3_BUCKET_NAME: preserve(),
      AWS_SECRET_ACCESS_KEY: preserve(),
      DATABASE_URL: db.env.DATABASE_URL,
    },
  });

  return project("tv", {
    resources: [frontend, backend, convenientPannikin, db],
  });
});
