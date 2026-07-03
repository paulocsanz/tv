import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ContentItem, ContentResponse, MetaResponse, Section } from "./types";
import { SESSION_COOKIE } from "./session";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

async function authHeaders(): Promise<HeadersInit> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function apiFetch<T>(path: string, revalidate = 3600): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    headers: await authHeaders(),
    next: { revalidate },
  });
  if (res.status === 401) redirect("/login");
  if (!res.ok) {
    throw new Error(`API request failed: ${path} (${res.status})`);
  }
  return res.json();
}

export function getSections(): Promise<Section[]> {
  return apiFetch<Section[]>("/api/sections");
}

export function getMeta(): Promise<MetaResponse> {
  return apiFetch<MetaResponse>("/api/meta");
}

export interface ContentQuery {
  type?: string;
  origin?: string;
  search?: string;
  min_rating?: string;
  genre?: string;
  decade?: string;
  sort?: string;
  page?: string;
  page_size?: string;
}

export function getContent(query: ContentQuery): Promise<ContentResponse> {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  const qs = params.toString();
  return apiFetch<ContentResponse>(`/api/content${qs ? `?${qs}` : ""}`, 60);
}

export async function getContentById(id: string): Promise<ContentItem | null> {
  const res = await fetch(`${API_URL}/api/content/${id}`, {
    headers: await authHeaders(),
    next: { revalidate: 3600 },
  });
  if (res.status === 404) return null;
  if (res.status === 401) redirect("/login");
  if (!res.ok) throw new Error(`API request failed: /api/content/${id} (${res.status})`);
  return res.json();
}
