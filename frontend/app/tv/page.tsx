import { headers } from "next/headers";
import { TvPairClient } from "./TvPairClient";

export default async function TvPairPage() {
  const headersList = await headers();
  const host = headersList.get("host") ?? "";
  const proto = headersList.get("x-forwarded-proto") ?? "https";
  const origin = host ? `${proto}://${host}` : "";

  return <TvPairClient origin={origin} />;
}
