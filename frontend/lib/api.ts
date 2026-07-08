import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  ContentItem,
  ContentResponse,
  ContinueWatchingItem,
  MeResponse,
  MetaResponse,
  ProgressEntry,
  RelatedTitle,
  Section,
  UserSummary,
} from "./types";
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
  if (res.status === 401) redirect("/api/logout");
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
  keyword?: string;
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
  if (res.status === 401) redirect("/api/logout");
  if (!res.ok) throw new Error(`API request failed: /api/content/${id} (${res.status})`);
  return res.json();
}

// Every movie in the same TMDB collection (prequels/sequels), ordered by
// year - including ones not in the library, which render as non-playable
// TMDB links. Empty when the title isn't part of a collection.
export async function getRelatedContent(id: string): Promise<RelatedTitle[]> {
  const res = await fetch(`${API_URL}/api/content/${id}/related`, {
    headers: await authHeaders(),
    next: { revalidate: 3600 },
  });
  if (!res.ok) return [];
  return res.json();
}

// TMDB-recommended titles ranked by relevance, in or out of the library.
// Excludes anything already shown in the collection row above.
export async function getSimilarContent(id: string): Promise<RelatedTitle[]> {
  const res = await fetch(`${API_URL}/api/content/${id}/similar`, {
    headers: await authHeaders(),
    next: { revalidate: 3600 },
  });
  if (!res.ok) return [];
  return res.json();
}

// Unlike apiFetch, never redirects on 401 - safe to call from places that
// also render while logged out (an admin-gate check, not a page that
// requires a session to make sense at all).
export async function getMeOrNull(): Promise<MeResponse | null> {
  const res = await fetch(`${API_URL}/api/me`, {
    headers: await authHeaders(),
    cache: "no-store",
  });
  if (!res.ok) return null;
  return res.json();
}

// Progress must reflect the latest save immediately on reload, unlike the
// hour-long cache on catalog data above.
export async function getProgress(id: string): Promise<ProgressEntry[]> {
  const res = await fetch(`${API_URL}/api/content/${id}/progress`, {
    headers: await authHeaders(),
    cache: "no-store",
  });
  if (!res.ok) return [];
  return res.json();
}

export async function getUsersOrNull(): Promise<UserSummary[] | null> {
  const res = await fetch(`${API_URL}/api/admin/users`, {
    headers: await authHeaders(),
    cache: "no-store",
  });
  if (!res.ok) return null;
  return res.json();
}

// Must reflect the latest save immediately, like getProgress above.
export async function getContinueWatching(): Promise<ContinueWatchingItem[]> {
  const res = await fetch(`${API_URL}/api/continue-watching`, {
    headers: await authHeaders(),
    cache: "no-store",
  });
  if (!res.ok) return [];
  return res.json();
}
