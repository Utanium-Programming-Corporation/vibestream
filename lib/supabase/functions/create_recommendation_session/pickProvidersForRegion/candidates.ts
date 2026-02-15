// lib/candidates.ts

import type {
  LogContext,
  TmdbType,
  OpenAIItem,
  MediaTitle,
  WatchProvidersResult,
  RecommendationCard,
  CandidateResult,
} from "../lib/types.ts";
import { normalizeTitle, log } from "../lib/helpers.ts";
import { tmdbSearchOne } from "../schema/tmdb.ts";
import { getOrCreateMediaTitle } from "./media.ts";

type OnCardReady = (result: CandidateResult, index: number) => void;

/**
 * Processes candidates in parallel (non-streaming mode).
 *
 * BUG FIX: The original implementation ran ALL search promises in parallel, then
 * sliced to `maxChoose` for enrichment — but the deduplication checks (chosenNorm,
 * excludedNormalizedTitles) happened at the START of each promise before any
 * mutation. This meant two items with the same normalized title could both pass
 * the check and be enriched simultaneously, producing duplicates.
 *
 * Fix: searches still run fully in parallel (they are idempotent reads), but the
 * deduplication gate and set mutation is now done synchronously after all searches
 * resolve, before handing off to the enrichment stage.
 */
export async function processCandidatesParallel(
  ctx: LogContext,
  // deno-lint-ignore no-explicit-any
  supabaseAdmin: any,
  items: OpenAIItem[],
  contentTypes: TmdbType[],
  excludedNormalizedTitles: Set<string>,
  excludedTmdbKeys: Set<string>,
  chosenNorm: Set<string>,
  userRegion: string,
  maxChoose: number,
): Promise<CandidateResult[]> {
  // Phase 1: run TMDB searches in parallel (safe — no shared mutation).
  const searchPromises = items.map(async (it) => {
    const title = String(it?.title || "").trim();
    if (!title) return null;

    const tmdbTypeRaw = String(it?.tmdb_type || "").toLowerCase().trim();
    const typeToUse: TmdbType | null =
      (tmdbTypeRaw === "movie" || tmdbTypeRaw === "tv") && contentTypes.includes(tmdbTypeRaw as TmdbType)
        ? (tmdbTypeRaw as TmdbType)
        : null;
    if (!typeToUse) return null;

    const searchQuery = String(it?.tmdb_search_query || it?.title || "").trim();
    const hit = await tmdbSearchOne(ctx, searchQuery, typeToUse);
    if (!hit) return null;

    return { item: it, hit, norm: normalizeTitle(title), tmdbKey: `${hit.tmdb_type}:${hit.tmdb_id}` };
  });

  const searchResults = (await Promise.all(searchPromises)).filter(
    (r): r is NonNullable<typeof r> => r !== null,
  );

  // Phase 2: deduplicate synchronously then enrich in parallel.
  // BUG FIX: gate is applied after all searches are done to avoid race condition.
  const toEnrich: typeof searchResults = [];
  for (const r of searchResults) {
    if (toEnrich.length >= maxChoose) break;
    if (chosenNorm.has(r.norm) || excludedNormalizedTitles.has(r.norm)) continue;
    if (excludedTmdbKeys.has(r.tmdbKey)) continue;
    // Pre-mark as chosen to prevent duplicates within this batch.
    chosenNorm.add(r.norm);
    excludedTmdbKeys.add(r.tmdbKey);
    excludedNormalizedTitles.add(r.norm);
    toEnrich.push(r);
  }

  const enrichPromises = toEnrich.map(async ({ item, hit, norm, tmdbKey }) => {
    const { mediaTitle, watchProviders } = await getOrCreateMediaTitle(
      ctx,
      supabaseAdmin,
      hit.tmdb_id,
      hit.tmdb_type,
      item.title,
      userRegion,
    );
    if (!mediaTitle) {
      // Roll back the pre-mark if enrichment failed.
      chosenNorm.delete(norm);
      excludedTmdbKeys.delete(tmdbKey);
      excludedNormalizedTitles.delete(norm);
      return null;
    }
    return { item, mediaRow: mediaTitle, watchProviders } satisfies CandidateResult;
  });

  return (await Promise.all(enrichPromises)).filter(
    (r): r is CandidateResult => r !== null,
  );
}

/**
 * Processes candidates one-at-a-time for streaming mode.
 * Calls `onCardReady` immediately after each successful enrichment.
 */
export async function processCandidatesSequential(
  ctx: LogContext,
  // deno-lint-ignore no-explicit-any
  supabaseAdmin: any,
  items: OpenAIItem[],
  contentTypes: TmdbType[],
  excludedNormalizedTitles: Set<string>,
  excludedTmdbKeys: Set<string>,
  chosenNorm: Set<string>,
  userRegion: string,
  maxChoose: number,
  onCardReady?: OnCardReady,
): Promise<CandidateResult[]> {
  const chosen: CandidateResult[] = [];

  for (const it of items) {
    if (chosen.length >= maxChoose) break;

    const title = String(it?.title || "").trim();
    if (!title) continue;

    const norm = normalizeTitle(title);
    if (chosenNorm.has(norm) || excludedNormalizedTitles.has(norm)) continue;

    const tmdbTypeRaw = String(it?.tmdb_type || "").toLowerCase().trim();
    const typeToUse: TmdbType | null =
      (tmdbTypeRaw === "movie" || tmdbTypeRaw === "tv") && contentTypes.includes(tmdbTypeRaw as TmdbType)
        ? (tmdbTypeRaw as TmdbType)
        : null;
    if (!typeToUse) continue;

    const searchQuery = String(it?.tmdb_search_query || it?.title || "").trim();
    const hit = await tmdbSearchOne(ctx, searchQuery, typeToUse);
    if (!hit) continue;

    const tmdbKey = `${hit.tmdb_type}:${hit.tmdb_id}`;
    if (excludedTmdbKeys.has(tmdbKey)) continue;

    const { mediaTitle, watchProviders } = await getOrCreateMediaTitle(
      ctx,
      supabaseAdmin,
      hit.tmdb_id,
      hit.tmdb_type,
      it.title,
      userRegion,
    );
    if (!mediaTitle) continue;

    excludedNormalizedTitles.add(norm);
    excludedTmdbKeys.add(tmdbKey);
    chosenNorm.add(norm);

    const result: CandidateResult = { item: it, mediaRow: mediaTitle, watchProviders };
    chosen.push(result);

    if (onCardReady) onCardReady(result, chosen.length - 1);
  }

  return chosen;
}

export function buildRecommendationCard(chosen: CandidateResult): RecommendationCard {
  const t = chosen.mediaRow;
  let duration = "";
  if (t.runtime_minutes) {
    const hours = Math.floor(t.runtime_minutes / 60);
    const mins = t.runtime_minutes % 60;
    duration = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
  }
  return {
    title_id: t.id,
    title: t.title,
    year: t.year?.toString() ?? "",
    duration,
    genres: t.genres ?? [],
    rating: t.imdb_rating?.toString() ?? "",
    age_rating: t.age_rating ?? "",
    quote: chosen.item?.reason ?? "",
    description: t.overview ?? "",
    poster_url: t.poster_url,
    match_score: chosen.item?.match_score ?? null,
    tmdb_type: t.tmdb_type,
    director: t.director ?? "",
    starring: t.starring ?? [],
    watch_provider_link: chosen.watchProviders.link,
    watch_providers: chosen.watchProviders.providers,
  };
}