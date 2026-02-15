// lib/feedback.ts
//
// Handles:
//   - getUserRegion: resolves the best region string for a user profile
//   - buildFeedbackSignals: processes raw interaction rows into exclude sets and
//     scored genre/tag/notes maps used to steer OpenAI recommendations

import type {
  LogContext,
  InteractionAction,
  FeedbackSignals,
  NegativeFeedbackSignals,
} from "../lib/types.ts";
import {
  log,
  normalizeTitle,
  getFeedbackWeight,
  getFeedbackSentiment,
  getNoteFromExtra,
  topKeysByScore,
  topNotes,
} from "../lib/helpers.ts";
import { GENRES_MAX, NOTES_MAX } from "../lib/constants.ts";

// ─── Region resolution ────────────────────────────────────────────────────────

/**
 * Resolves the best region string for a profile.
 *
 * NOTE: The original main handler already fetches the profile row in its
 * Promise.all batch. To avoid the duplicate DB call, callers should pass the
 * already-resolved profile data directly via `getUserRegionFromProfile` where
 * possible. This function is kept for standalone use.
 */
export async function getUserRegion(
  ctx: LogContext,
  // deno-lint-ignore no-explicit-any
  supabaseUser: any,
  profileId: string,
): Promise<string> {
  try {
    const { data: profile } = await supabaseUser
      .from("profiles")
      .select("country_code, user_id")
      .eq("id", profileId)
      .maybeSingle();

    if (profile?.country_code) {
      log(ctx, `Using profile country_code: ${profile.country_code}`);
      return profile.country_code;
    }
    if (profile?.user_id) {
      const { data: appUser } = await supabaseUser
        .from("app_users")
        .select("region")
        .eq("id", profile.user_id)
        .maybeSingle();
      if (appUser?.region) {
        log(ctx, `Using app_users region: ${appUser.region}`);
        return appUser.region;
      }
    }
    log(ctx, "No region found, defaulting to US");
    return "US";
  } catch (error) {
    log(ctx, "Error getting user region, defaulting to US", error);
    return "US";
  }
}

/**
 * Resolves region from an already-fetched profile row + optional userId,
 * saving a redundant DB round-trip when the profile was fetched upstream.
 */
export async function getUserRegionFromProfile(
  ctx: LogContext,
  // deno-lint-ignore no-explicit-any
  supabaseUser: any,
  profile: { country_code?: string | null; user_id?: string | null } | null,
): Promise<string> {
  if (profile?.country_code) {
    log(ctx, `Using profile country_code: ${profile.country_code}`);
    return profile.country_code;
  }
  if (profile?.user_id) {
    try {
      const { data: appUser } = await supabaseUser
        .from("app_users")
        .select("region")
        .eq("id", profile.user_id)
        .maybeSingle();
      if (appUser?.region) {
        log(ctx, `Using app_users region: ${appUser.region}`);
        return appUser.region;
      }
    } catch (error) {
      log(ctx, "Error fetching app_users region", error);
    }
  }
  log(ctx, "No region found, defaulting to US");
  return "US";
}

// ─── Feedback signals ─────────────────────────────────────────────────────────

export interface FeedbackSignalsResult {
  hardExcludedNormalized: Set<string>;
  softExcludedNormalized: Set<string>;
  excludedTmdbKeys: Set<string>;
  /** Deduplicated list of hard-excluded titles for the OpenAI prompt. */
  hardExcludedTitlesForPrompt: string[];
  /** Deduplicated list of soft-excluded titles for the OpenAI prompt. */
  softExcludedTitlesForPrompt: string[];
  negativeTitlesForPrompt: string[];
  positiveSignals: FeedbackSignals;
  negativeSignals: NegativeFeedbackSignals;
  positiveGenres: string[];
  negativeGenres: string[];
  positiveTags: string[];
  negativeTags: string[];
  positiveNotesTop: string[];
  negativeNotesTop: string[];
}

/**
 * Processes raw interaction rows into feedback signals used for recommendation
 * steering and title exclusion.
 *
 * BUG FIX: The original code used plain arrays for hardExcludedTitlesForPrompt
 * and softExcludedTitlesForPrompt, allowing the same title to appear multiple
 * times when a user interacted with it more than once. These are now deduplicated
 * via Sets before converting to arrays.
 */
export function buildFeedbackSignals(
  // deno-lint-ignore no-explicit-any
  interactions: any[],
): FeedbackSignalsResult {
  const hardExcludedNormalized = new Set<string>();
  const softExcludedNormalized = new Set<string>();
  const excludedTmdbKeys = new Set<string>();

  // BUG FIX: use Sets for prompt lists to avoid duplicating the same title.
  const hardExcludedTitlesSet = new Set<string>();
  const softExcludedTitlesSet = new Set<string>();
  const negativeTitlesSet = new Set<string>();

  const posGenreScore = new Map<string, number>();
  const negGenreScore = new Map<string, number>();
  const posTagScore = new Map<string, number>();
  const negTagScore = new Map<string, number>();
  const positiveNotes: Array<{ text: string; w: number; at: string }> = [];
  const negativeNotes: Array<{ text: string; w: number; at: string }> = [];

  for (const i of interactions ?? []) {
    // deno-lint-ignore no-explicit-any
    const t = (i as any).title;
    const titleStr = t?.title ? String(t.title) : "";
    const norm = titleStr ? normalizeTitle(titleStr) : "";
    const action = String((i as Record<string, unknown>).action) as InteractionAction;
    const rating = (i as Record<string, unknown>).rating == null
      ? null
      : Number((i as Record<string, unknown>).rating);
    const extra = (i as Record<string, unknown>).extra ?? {};
    const createdAt = String((i as Record<string, unknown>).created_at ?? "");
    const w = createdAt ? getFeedbackWeight(createdAt) : 0.25;
    const sentiment = getFeedbackSentiment(action, rating, extra);
    const quickTags: string[] = Array.isArray((extra as Record<string, unknown>)?.quick_tags)
      ? ((extra as Record<string, unknown>).quick_tags as unknown[]).map((x) => String(x))
      : [];

    if (titleStr && norm) {
      if (sentiment === "negative") {
        hardExcludedNormalized.add(norm);
        hardExcludedTitlesSet.add(titleStr);
        negativeTitlesSet.add(titleStr);
      } else if (action === "complete" || (rating !== null && rating === 3)) {
        softExcludedNormalized.add(norm);
        softExcludedTitlesSet.add(titleStr);
      }

      if (t?.tmdb_id && t?.tmdb_type) {
        const key = `${t.tmdb_type}:${t.tmdb_id}`;
        if (sentiment === "negative") excludedTmdbKeys.add(key);
        if (action === "complete" || (rating !== null && rating === 3)) excludedTmdbKeys.add(key);
      }
    }

    const genres: string[] = Array.isArray(t?.genres)
      ? (t.genres as unknown[]).map((g) => String(g)).filter(Boolean)
      : [];
    if (genres.length > 0) {
      if (sentiment === "positive") {
        for (const g of genres) posGenreScore.set(g, (posGenreScore.get(g) ?? 0) + w);
      } else if (sentiment === "negative") {
        for (const g of genres) negGenreScore.set(g, (negGenreScore.get(g) ?? 0) + w);
      }
    }

    if (quickTags.length > 0) {
      if (sentiment === "positive") {
        for (const tg of quickTags) posTagScore.set(tg, (posTagScore.get(tg) ?? 0) + w);
      } else if (sentiment === "negative") {
        for (const tg of quickTags) negTagScore.set(tg, (negTagScore.get(tg) ?? 0) + w);
      }
    }

    const note = getNoteFromExtra(extra);
    if (note) {
      const entry = { text: note, w, at: createdAt || new Date().toISOString() };
      if (sentiment === "negative") negativeNotes.push(entry);
      else if (sentiment === "positive") positiveNotes.push(entry);
    }
  }

  const positiveGenres = topKeysByScore(posGenreScore, GENRES_MAX);
  const negativeGenres = topKeysByScore(negGenreScore, GENRES_MAX);
  const positiveTags = topKeysByScore(posTagScore, 20);
  const negativeTags = topKeysByScore(negTagScore, 20);
  const positiveNotesTop = topNotes(positiveNotes, Math.ceil(NOTES_MAX / 2));
  const negativeNotesTop = topNotes(negativeNotes, Math.floor(NOTES_MAX / 2));

  return {
    hardExcludedNormalized,
    softExcludedNormalized,
    excludedTmdbKeys,
    hardExcludedTitlesForPrompt: Array.from(hardExcludedTitlesSet),
    softExcludedTitlesForPrompt: Array.from(softExcludedTitlesSet),
    negativeTitlesForPrompt: Array.from(negativeTitlesSet),
    positiveSignals: { genres: positiveGenres, notes: positiveNotesTop, tags: positiveTags },
    negativeSignals: {
      genres: negativeGenres,
      notes: negativeNotesTop,
      tags: negativeTags,
      titles: Array.from(negativeTitlesSet),
    },
    positiveGenres,
    negativeGenres,
    positiveTags,
    negativeTags,
    positiveNotesTop,
    negativeNotesTop,
  };
}