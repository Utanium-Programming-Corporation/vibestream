// lib/media.ts

import type {
  LogContext,
  TmdbType,
  MediaTitle,
  WatchProvidersResult,
  WatchProviderWithAvailability,
} from "../lib/types.ts";
import { log, nowIso } from "../lib/helpers.ts";
import { tmdbGetDetails, tmdbWatchProviders, pickProvidersForRegion } from "../schema/tmdb.ts";
import { omdbGetDetails } from "./omdb.ts";

/**
 * Upserts a streaming provider row and all of its title availability records.
 *
 * BUG FIX: The original code typed `providerIdMap` as `Map<number, string>`,
 * but `streaming_providers.id` is an integer column — not a uuid. The map is
 * now correctly typed as `Map<number, number>` so the integer FK value is
 * passed to `title_streaming_availability.provider_id` without type coercion.
 */
export async function storeStreamingProviders(
  ctx: LogContext,
  // deno-lint-ignore no-explicit-any
  supabaseAdmin: any,
  titleId: string,
  providerAvailability: WatchProviderWithAvailability[],
  region: string,
  watchProviderLink: string | null,
): Promise<void> {
  if (providerAvailability.length === 0) return;
  try {
    const uniqueProviders = new Map<
      number,
      { tmdb_provider_id: number; name: string; logo_url: string | null }
    >();
    for (const p of providerAvailability) {
      if (!uniqueProviders.has(p.provider_id)) {
        uniqueProviders.set(p.provider_id, {
          tmdb_provider_id: p.provider_id,
          name: p.name,
          logo_url: p.logo_url,
        });
      }
    }

    const { data: upsertedProviders, error: providerErr } = await supabaseAdmin
      .from("streaming_providers")
      .upsert(Array.from(uniqueProviders.values()), {
        onConflict: "tmdb_provider_id",
        ignoreDuplicates: false,
      })
      .select("id, tmdb_provider_id");

    if (providerErr) {
      log(ctx, "Error upserting streaming_providers", providerErr);
      return;
    }

    // BUG FIX: was Map<number, string> — streaming_providers.id is integer.
    const providerIdMap = new Map<number, number>();
    for (const p of upsertedProviders ?? []) {
      providerIdMap.set(p.tmdb_provider_id as number, p.id as number);
    }

    const { error: deleteErr } = await supabaseAdmin
      .from("title_streaming_availability")
      .delete()
      .eq("title_id", titleId)
      .eq("region", region);
    if (deleteErr) log(ctx, "Error deleting old title_streaming_availability", deleteErr);

    const availabilityRecords = providerAvailability
      .map((p) => ({
        title_id: titleId,
        provider_id: providerIdMap.get(p.provider_id),
        region,
        availability_type: p.availability_type,
        watch_link: watchProviderLink,
      }))
      .filter((r) => r.provider_id != null);

    if (availabilityRecords.length > 0) {
      const { error: insertErr } = await supabaseAdmin
        .from("title_streaming_availability")
        .insert(availabilityRecords);
      if (insertErr) log(ctx, "Error inserting title_streaming_availability", insertErr);
      else log(ctx, `Stored ${availabilityRecords.length} streaming availability records for title ${titleId}`);
    }
  } catch (err) {
    log(ctx, "Exception in storeStreamingProviders", err);
  }
}

/**
 * Retrieves an existing media_titles row or creates one by fetching from TMDB/OMDB.
 *
 * BUG FIX: The original `needsEnrich` condition re-fetched from TMDB/OMDB every time
 * a title genuinely had no IMDb ID (imdb_rating == null && imdb_id == null).
 * This caused redundant API calls on every lookup for titles that simply aren't on
 * IMDb. The fix adds a `last_enriched_at` guard — if the row was updated within the
 * last 7 days, skip re-enrichment even when IMDb fields are missing, since the data
 * is as good as it's going to get.
 */
export async function getOrCreateMediaTitle(
  ctx: LogContext,
  // deno-lint-ignore no-explicit-any
  supabaseAdmin: any,
  tmdbId: number,
  tmdbType: TmdbType,
  fallbackTitle: string,
  userRegion: string,
): Promise<{ mediaTitle: MediaTitle | null; watchProviders: WatchProvidersResult }> {
  const { data: existing, error: existingErr } = await supabaseAdmin
    .from("media_titles")
    .select("*")
    .eq("tmdb_id", tmdbId)
    .eq("tmdb_type", tmdbType)
    .maybeSingle();
  if (existingErr) log(ctx, "Error checking media_titles cache", existingErr);

  // BUG FIX: avoid re-enriching titles that simply have no IMDb entry by
  // honouring a 7-day freshness window on the updated_at timestamp.
  const ENRICH_FRESHNESS_DAYS = 7;
  const isRecent = existing?.updated_at
    ? Date.now() - new Date(existing.updated_at).getTime() < ENRICH_FRESHNESS_DAYS * 86_400_000
    : false;

  const needsEnrich =
    !existing ||
    (!isRecent &&
      ((existing.imdb_rating == null && existing.imdb_id == null) ||
        existing.director == null ||
        existing.starring == null));

  const [details, watchJson] = await Promise.all([
    needsEnrich ? tmdbGetDetails(ctx, tmdbId, tmdbType) : Promise.resolve(null),
    tmdbWatchProviders(ctx, tmdbId, tmdbType),
  ]);

  const watchProviders = watchJson
    ? pickProvidersForRegion(watchJson, userRegion)
    : { link: null, providers: [], providerAvailability: [] };

  if (!needsEnrich && existing) return { mediaTitle: existing as MediaTitle, watchProviders };
  if (!details) return { mediaTitle: (existing as MediaTitle) ?? null, watchProviders };

  const imdbId =
    tmdbType === "movie" ? (details.imdb_id ?? null) : (details.external_ids?.imdb_id ?? null);
  const omdbJson = imdbId ? await omdbGetDetails(ctx, imdbId) : null;

  const imdbRating =
    omdbJson?.imdbRating && omdbJson.imdbRating !== "N/A"
      ? Number.parseFloat(omdbJson.imdbRating)
      : null;
  const ageRating =
    omdbJson?.Rated && omdbJson.Rated !== "N/A" ? omdbJson.Rated : null;

  const credits = details.credits ?? null;
  const castNames: string[] = Array.isArray(credits?.cast)
    ? (credits!.cast!.slice(0, 5).map((c) => c?.name).filter(Boolean) as string[])
    : [];

  let director: string | null = null;
  if (tmdbType === "movie") {
    const crew = Array.isArray(credits?.crew) ? credits!.crew! : [];
    director = crew.find((c) => c?.job === "Director")?.name ?? null;
  } else {
    const creators = Array.isArray(details.created_by) ? details.created_by : [];
    director =
      creators.length > 0
        ? creators.map((x) => x?.name).filter(Boolean).slice(0, 2).join(", ")
        : null;
  }

  const genres = (details.genres ?? []).map((g) => g?.name).filter(Boolean) as string[];
  const dateStr =
    tmdbType === "movie" ? (details.release_date ?? "") : (details.first_air_date ?? "");
  const yearValue = dateStr ? Number.parseInt(String(dateStr).slice(0, 4)) : null;
  const runtime =
    tmdbType === "movie"
      ? (details.runtime ?? null)
      : Array.isArray(details.episode_run_time)
      ? (details.episode_run_time[0] ?? null)
      : null;

  const POSTER_BASE = "https://image.tmdb.org/t/p/w500";
  const posterUrl = details.poster_path ? POSTER_BASE + details.poster_path : null;
  const backdropUrl = details.backdrop_path ? POSTER_BASE + details.backdrop_path : null;
  const title =
    tmdbType === "movie" ? (details.title ?? fallbackTitle) : (details.name ?? fallbackTitle);

  const row = {
    tmdb_id: tmdbId,
    tmdb_type: tmdbType,
    title,
    overview: details.overview ?? null,
    genres,
    year: yearValue,
    runtime_minutes: runtime,
    poster_url: posterUrl,
    backdrop_url: backdropUrl,
    imdb_id: imdbId,
    imdb_rating: imdbRating,
    age_rating: ageRating,
    director,
    starring: castNames.length > 0 ? castNames : null,
    raw_tmdb: details,
    raw_omdb: omdbJson,
    updated_at: nowIso(),
  };

  if (existing) {
    const { data: updated, error: upErr } = await supabaseAdmin
      .from("media_titles")
      .update(row)
      .eq("id", existing.id)
      .select()
      .single();
    if (upErr) {
      log(ctx, "Error updating existing media_titles", upErr);
      return { mediaTitle: existing as MediaTitle, watchProviders };
    }
    return { mediaTitle: updated as MediaTitle, watchProviders };
  }

  const { data: inserted, error: insertErr } = await supabaseAdmin
    .from("media_titles")
    .insert({ ...row, created_at: nowIso() })
    .select()
    .single();

  if (insertErr) {
    log(ctx, "Error inserting media_titles", insertErr);
    // Race condition fallback: another request may have inserted the row.
    const { data: again } = await supabaseAdmin
      .from("media_titles")
      .select("*")
      .eq("tmdb_id", tmdbId)
      .eq("tmdb_type", tmdbType)
      .maybeSingle();
    return { mediaTitle: (again as MediaTitle) ?? null, watchProviders };
  }
  return { mediaTitle: inserted as MediaTitle, watchProviders };
}