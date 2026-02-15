// lib/tmdb.ts

import type { LogContext, TmdbType, TmdbSearchResult, TmdbDetails, WatchProvidersResult, WatchProviderWithAvailability, AvailabilityType } from "../lib/types.ts";
import { TMDB_API_KEY, API_TIMEOUT_MS } from "../lib/constants.ts";
import { fetchWithTimeout, log } from "../lib/helpers.ts";

const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";

export async function tmdbSearchOne(
  ctx: LogContext,
  searchQuery: string,
  tmdbType: TmdbType,
): Promise<TmdbSearchResult | null> {
  const encoded = encodeURIComponent(searchQuery);
  const url = `${TMDB_BASE}/search/${tmdbType}?api_key=${TMDB_API_KEY}&language=en-US&query=${encoded}`;
  try {
    const res = await fetchWithTimeout(url, {}, API_TIMEOUT_MS);
    if (!res.ok) {
      const t = await res.text();
      log(ctx, "TMDB search failed", { url, status: res.status, body: t.slice(0, 500) });
      return null;
    }
    const json = await res.json();
    const first = json?.results?.[0];
    if (!first?.id) return null;
    return {
      tmdb_id: Number(first.id),
      tmdb_type: tmdbType,
      tmdb_title: first.title || first.name || searchQuery,
    };
  } catch (error) {
    log(ctx, "TMDB search error", { searchQuery, tmdbType, error: String(error) });
    return null;
  }
}

export async function tmdbGetDetails(
  ctx: LogContext,
  tmdbId: number,
  tmdbType: TmdbType,
): Promise<TmdbDetails | null> {
  const url = `${TMDB_BASE}/${tmdbType}/${tmdbId}?api_key=${TMDB_API_KEY}&language=en-US&append_to_response=credits,external_ids`;
  try {
    const res = await fetchWithTimeout(url, {}, API_TIMEOUT_MS);
    if (!res.ok) {
      log(ctx, "TMDB details failed", { tmdbId, tmdbType, status: res.status });
      return null;
    }
    return (await res.json()) as TmdbDetails;
  } catch (error) {
    log(ctx, "TMDB details error", { tmdbId, tmdbType, error: String(error) });
    return null;
  }
}

export async function tmdbWatchProviders(
  ctx: LogContext,
  tmdbId: number,
  tmdbType: TmdbType,
): Promise<unknown> {
  const url = `${TMDB_BASE}/${tmdbType}/${tmdbId}/watch/providers?api_key=${TMDB_API_KEY}`;
  try {
    const res = await fetchWithTimeout(url, {}, API_TIMEOUT_MS);
    if (!res.ok) {
      const t = await res.text();
      log(ctx, "TMDB watch/providers failed", { url, status: res.status, body: t.slice(0, 300) });
      return null;
    }
    return await res.json();
  } catch (error) {
    log(ctx, "TMDB watch providers error", { tmdbId, tmdbType, error: String(error) });
    return null;
  }
}

export function pickProvidersForRegion(watchJson: unknown, region: string): WatchProvidersResult {
  const j = watchJson as Record<string, unknown>;
  const regionData = (j?.results as Record<string, unknown>)?.[region] ?? null;
  if (!regionData) return { link: null, providers: [], providerAvailability: [] };

  const rd = regionData as Record<string, unknown>;
  const providerAvailability: WatchProviderWithAvailability[] = [];
  const availabilityTypes: Array<{ key: string; type: AvailabilityType }> = [
    { key: "flatrate", type: "flatrate" },
    { key: "free", type: "free" },
    { key: "ads", type: "ads" },
    { key: "rent", type: "rent" },
    { key: "buy", type: "buy" },
  ];

  for (const { key, type } of availabilityTypes) {
    const list = rd[key];
    if (Array.isArray(list)) {
      for (const p of list) {
        if (p?.provider_id != null && p?.provider_name) {
          providerAvailability.push({
            provider_id: p.provider_id,
            name: p.provider_name,
            logo_url: p.logo_path ? `${TMDB_IMAGE_BASE}/w92${p.logo_path}` : null,
            availability_type: type,
          });
        }
      }
    }
  }

  const seen = new Set<number>();
  const providers = providerAvailability
    .filter((p) => (seen.has(p.provider_id) ? false : (seen.add(p.provider_id), true)))
    .map(({ provider_id, name, logo_url }) => ({ provider_id, name, logo_url }));

  return { link: (rd.link as string) ?? null, providers, providerAvailability };
}