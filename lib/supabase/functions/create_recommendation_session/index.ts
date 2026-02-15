// index.ts — create_recommendation_session edge function

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

import {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  CORS_HEADERS,
  SSE_HEADERS,
  CANDIDATES_COUNT,
  FINAL_COUNT,
  TOPUP_MAX_ATTEMPTS,
} from "./lib/constants.ts";

import {
  log,
  nowIso,
  daysAgoIso,
  normalizeTitle,
  parseContentTypes,
  RequestBodySchema,
} from "./lib/helpers.ts";

import { callOpenAI } from "./schema/openai.ts";
import { storeStreamingProviders } from "./pickProvidersForRegion/media.ts";
import {
  processCandidatesParallel,
  processCandidatesSequential,
  buildRecommendationCard,
} from "./pickProvidersForRegion/candidates.ts";
import {
  getUserRegionFromProfile,
  buildFeedbackSignals,
} from "./buildRecommendationCard/feedback.ts";

import type { LogContext, SessionType, RecommendationCard, CandidateResult } from "./lib/types.ts";

// ─── Main handler ─────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  const reqId = crypto.randomUUID();
  const ctx: LogContext = { reqId };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: CORS_HEADERS });
  }

  try {
    // ── Auth ──────────────────────────────────────────────────────────────────
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.toLowerCase().startsWith("bearer ")) {
      return jsonError("Missing Authorization Bearer token", 401);
    }

    const jwt = authHeader.slice(7);
    const supabaseUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: userInfo, error: userErr } = await supabaseUser.auth.getUser(jwt);
    if (userErr || !userInfo?.user) {
      return jsonError("Invalid or expired token", 401);
    }

    ctx.userId = userInfo.user.id;

    // ── Validate request body ─────────────────────────────────────────────────
    const rawBody = await req.json();
    const validation = RequestBodySchema.safeParse(rawBody);
    if (!validation.success) {
      return jsonError("Invalid request body", 400, validation.error.errors);
    }

    const body = validation.data;
    ctx.profileId = body.profile_id;

    const session_type = body.session_type as SessionType;
    const mood_input = body.mood_input;
    const content_types = parseContentTypes(body);
    const shouldStream = body.stream === true;

    log(ctx, "Incoming request", {
      profile_id: body.profile_id,
      session_type,
      content_types,
      stream: shouldStream,
    });

    // ── Fetch profile, preferences, interactions in parallel ──────────────────
    const windowStart = daysAgoIso(120 /* HISTORY_WINDOW_DAYS */);
    const [profileResult, prefsResult, interactionsResult] = await Promise.all([
      supabaseUser.from("profiles").select("*").eq("id", body.profile_id).single(),
      supabaseUser.from("profile_preferences").select("answers").eq("profile_id", body.profile_id).maybeSingle(),
      supabaseAdmin
        .from("profile_title_interactions")
        .select(`title_id, action, rating, extra, created_at, title:media_titles(title, tmdb_id, tmdb_type, genres)`)
        .eq("profile_id", body.profile_id)
        .gte("created_at", windowStart)
        .order("created_at", { ascending: false })
        .limit(300 /* MAX_HISTORY_FETCH */),
    ]);

    const { data: profile, error: profileErr } = profileResult;
    if (profileErr || !profile) {
      log(ctx, "Profile not found or unauthorized", profileErr);
      return jsonError("Profile not found or not owned by user", 404);
    }

    const { data: prefs } = prefsResult;
    const { data: interactions, error: interactionsErr } = interactionsResult;
    if (interactionsErr) log(ctx, "Interactions fetch error", interactionsErr);

    // BUG FIX: resolve region from the already-fetched profile to avoid a
    // duplicate SELECT on the profiles table (original called getUserRegion
    // which re-fetched it).
    const userRegion = await getUserRegionFromProfile(ctx, supabaseUser, profile);

    // ── Build feedback signals ────────────────────────────────────────────────
    const {
      hardExcludedNormalized,
      softExcludedNormalized,
      excludedTmdbKeys,
      hardExcludedTitlesForPrompt,
      softExcludedTitlesForPrompt,
      negativeTitlesForPrompt,
      positiveSignals,
      negativeSignals,
      positiveGenres,
      negativeGenres,
      positiveTags,
      negativeTags,
      positiveNotesTop,
      negativeNotesTop,
    } = buildFeedbackSignals(interactions ?? []);

    // ── Fetch recently recommended items (avoid re-suggesting) ────────────────
    const { data: recentSessions, error: sessErr } = await supabaseAdmin
      .from("recommendation_sessions")
      .select("id, created_at")
      .eq("profile_id", body.profile_id)
      .gte("created_at", daysAgoIso(90))
      .order("created_at", { ascending: false })
      .limit(60);
    if (sessErr) log(ctx, "Recent sessions fetch error", sessErr);

    const sessionIds = (recentSessions ?? []).map((s: { id: string }) => s.id);
    let recentItems: { title: { title?: string; tmdb_id?: number; tmdb_type?: string } | null }[] = [];
    if (sessionIds.length > 0) {
      const { data: itemsData, error: itemsErr } = await supabaseAdmin
        .from("recommendation_items")
        .select(`title_id, title:media_titles(title, tmdb_id, tmdb_type)`)
        .in("session_id", sessionIds)
        .limit(400);
      if (itemsErr) log(ctx, "Recent recommendation_items fetch error", itemsErr);
      recentItems = itemsData ?? [];
    }

    const recommendedNormalized = new Set<string>();
    for (const ri of recentItems) {
      const t = ri.title;
      if (t?.title) recommendedNormalized.add(normalizeTitle(String(t.title)));
      if (t?.tmdb_id && t?.tmdb_type) excludedTmdbKeys.add(`${t.tmdb_type}:${t.tmdb_id}`);
    }

    const excludedNormalizedTitles = new Set<string>([
      ...hardExcludedNormalized,
      ...softExcludedNormalized,
      ...recommendedNormalized,
    ]);

    log(ctx, "Feedback signals built", {
      hardExcluded: hardExcludedNormalized.size,
      softExcluded: softExcludedNormalized.size,
      recentRecommended: recommendedNormalized.size,
      positiveGenresCount: positiveGenres.length,
      negativeGenresCount: negativeGenres.length,
      userRegion,
    });

    // ── Build OpenAI prompt ───────────────────────────────────────────────────
    const promptObj = {
      profile_id: body.profile_id,
      session_type,
      content_types,
      profile_preferences: prefs?.answers ?? {},
      recent_interactions: (interactions ?? []).slice(0, 50).map((i: Record<string, unknown>) => ({
        title_id: i.title_id,
        title: (i.title as Record<string, unknown>)?.title ?? null,
        tmdb_id: (i.title as Record<string, unknown>)?.tmdb_id ?? null,
        tmdb_type: (i.title as Record<string, unknown>)?.tmdb_type ?? null,
        action: i.action,
        rating: i.rating ?? null,
        created_at: i.created_at,
        feedback_text: getNoteFromExtraLocal(i.extra ?? {}),
        would_watch_again: (i.extra as Record<string, unknown>)?.would_watch_again ?? null,
        quick_tags: Array.isArray((i.extra as Record<string, unknown>)?.quick_tags)
          ? (i.extra as Record<string, unknown>).quick_tags
          : [],
        genres: Array.isArray((i.title as Record<string, unknown>)?.genres)
          ? (i.title as Record<string, unknown>).genres
          : [],
      })),
      feedback_signals: {
        user_tends_to_enjoy_genres: positiveGenres,
        user_tends_to_avoid_genres: negativeGenres,
        user_tends_to_enjoy_tags: positiveTags,
        user_tends_to_avoid_tags: negativeTags,
        recent_feedback_notes_positive: positiveNotesTop,
        recent_feedback_notes_negative: negativeNotesTop,
      },
      mood_input,
    };

    const hardExcludeDeduped = Array.from(new Set(hardExcludedTitlesForPrompt));
    const softExcludeDeduped = Array.from(new Set(softExcludedTitlesForPrompt));
    const chosenNorm = new Set<string>();

    // ── Call OpenAI ───────────────────────────────────────────────────────────
    const payload1 = await callOpenAI(
      ctx,
      promptObj,
      CANDIDATES_COUNT,
      content_types,
      hardExcludeDeduped,
      softExcludeDeduped,
      positiveSignals,
      negativeSignals,
    );

    let finalMoodLabel = payload1.mood_label ?? "";
    let finalMoodTags = Array.isArray(payload1.mood_tags) ? payload1.mood_tags : [];

    // ── STREAMING MODE ────────────────────────────────────────────────────────
    if (shouldStream) {
      return handleStreamingMode(ctx, {
        supabaseAdmin,
        supabaseUser,
        body,
        session_type,
        mood_input,
        content_types,
        userRegion,
        excludedNormalizedTitles,
        excludedTmdbKeys,
        chosenNorm,
        payload1,
        finalMoodLabel,
        finalMoodTags,
        positiveGenres,
        negativeGenres,
        positiveTags,
        negativeTags,
        positiveNotesTop,
        negativeNotesTop,
        positiveSignals,
        negativeSignals,
        hardExcludeDeduped,
        softExcludeDeduped,
        promptObj,
      });
    }

    // ── NON-STREAMING MODE ────────────────────────────────────────────────────
    let chosen = await processCandidatesParallel(
      ctx,
      supabaseAdmin,
      payload1.items,
      content_types,
      excludedNormalizedTitles,
      excludedTmdbKeys,
      chosenNorm,
      userRegion,
      FINAL_COUNT,
    );

    // Top-up if under FINAL_COUNT
    if (chosen.length < FINAL_COUNT) {
      const result = await topUp(ctx, {
        supabaseAdmin,
        chosen,
        content_types,
        excludedNormalizedTitles,
        excludedTmdbKeys,
        chosenNorm,
        userRegion,
        finalMoodLabel,
        finalMoodTags,
        positiveSignals,
        negativeSignals,
        hardExcludeDeduped,
        softExcludeDeduped,
        promptObj,
      });
      chosen = result.chosen;
      finalMoodLabel = result.finalMoodLabel;
      finalMoodTags = result.finalMoodTags;
    }

    if (chosen.length === 0) {
      return jsonError("Could not generate recommendations after filtering", 500);
    }

    const finalChosen = chosen.slice(0, FINAL_COUNT);

    const sessionOpenAiResponse = {
      mood_label: finalMoodLabel,
      mood_tags: finalMoodTags,
      content_types,
      feedback_signals_used: {
        user_tends_to_enjoy_genres: positiveGenres,
        user_tends_to_avoid_genres: negativeGenres,
        user_tends_to_enjoy_tags: positiveTags,
        user_tends_to_avoid_tags: negativeTags,
        recent_feedback_notes_positive: positiveNotesTop,
        recent_feedback_notes_negative: negativeNotesTop,
      },
      candidates_payload: payload1,
      selected_titles: finalChosen.map((c) => ({
        title: c.mediaRow?.title,
        tmdb_id: c.mediaRow?.tmdb_id,
        tmdb_type: c.mediaRow?.tmdb_type,
        match_score: c.item?.match_score ?? null,
      })),
    };

    const { data: session, error: sessionErr } = await supabaseAdmin
      .from("recommendation_sessions")
      .insert({
        profile_id: body.profile_id,
        session_type,
        input_payload: { ...(mood_input as Record<string, unknown>), content_types },
        openai_response: sessionOpenAiResponse,
        mood_label: finalMoodLabel,
        mood_tags: finalMoodTags,
        top_title_id: finalChosen[0].mediaRow.id,
        created_at: nowIso(),
      })
      .select()
      .single();

    if (sessionErr || !session) {
      log(ctx, "Failed to insert recommendation_sessions", sessionErr);
      return jsonError("Failed to create recommendation session", 500);
    }

    const recItems = finalChosen.map((c, idx) => ({
      session_id: session.id,
      title_id: c.mediaRow.id,
      rank_index: idx,
      openai_reason: c.item?.reason ?? null,
      match_score: c.item?.match_score ?? null,
      created_at: nowIso(),
    }));
    const { error: itemsErr } = await supabaseAdmin.from("recommendation_items").insert(recItems);
    if (itemsErr) log(ctx, "Failed to insert recommendation_items", itemsErr);

    await Promise.all(
      finalChosen.map((c) =>
        c.watchProviders.providerAvailability.length > 0
          ? storeStreamingProviders(
              ctx,
              supabaseAdmin,
              c.mediaRow.id,
              c.watchProviders.providerAvailability,
              userRegion,
              c.watchProviders.link,
            )
          : Promise.resolve(),
      ),
    );

    const cards: RecommendationCard[] = finalChosen.map((c) => buildRecommendationCard(c));

    log(ctx, "Successfully created recommendation session", {
      sessionId: session.id,
      cardsCount: cards.length,
      userRegion,
    });

    return new Response(
      JSON.stringify({
        id: session.id,
        profile_id: body.profile_id,
        session_type,
        mood_input: { ...(mood_input as Record<string, unknown>), content_types },
        created_at: session.created_at,
        cards,
      }),
      { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error(err);
    log(ctx, "Fatal error in recommendation session creation", { error: String(err) });
    return jsonError("Internal server error", 500, String(err));
  }
});

// ─── Streaming handler ────────────────────────────────────────────────────────

function handleStreamingMode(
  ctx: LogContext,
  opts: {
    // deno-lint-ignore no-explicit-any
    supabaseAdmin: any;
    // deno-lint-ignore no-explicit-any
    supabaseUser: any;
    // deno-lint-ignore no-explicit-any
    body: any;
    session_type: SessionType;
    // deno-lint-ignore no-explicit-any
    mood_input: any;
    // deno-lint-ignore no-explicit-any
    content_types: any;
    userRegion: string;
    excludedNormalizedTitles: Set<string>;
    excludedTmdbKeys: Set<string>;
    chosenNorm: Set<string>;
    // deno-lint-ignore no-explicit-any
    payload1: any;
    finalMoodLabel: string;
    finalMoodTags: string[];
    positiveGenres: string[];
    negativeGenres: string[];
    positiveTags: string[];
    negativeTags: string[];
    positiveNotesTop: string[];
    negativeNotesTop: string[];
    // deno-lint-ignore no-explicit-any
    positiveSignals: any;
    // deno-lint-ignore no-explicit-any
    negativeSignals: any;
    hardExcludeDeduped: string[];
    softExcludeDeduped: string[];
    // deno-lint-ignore no-explicit-any
    promptObj: any;
  },
): Response {
  const {
    supabaseAdmin,
    body,
    session_type,
    mood_input,
    content_types,
    userRegion,
    excludedNormalizedTitles,
    excludedTmdbKeys,
    chosenNorm,
    payload1,
    positiveGenres,
    negativeGenres,
    positiveTags,
    negativeTags,
    positiveNotesTop,
    negativeNotesTop,
    positiveSignals,
    negativeSignals,
    hardExcludeDeduped,
    softExcludeDeduped,
    promptObj,
  } = opts;

  let { finalMoodLabel, finalMoodTags } = opts;

  const createSession = () =>
    supabaseAdmin
      .from("recommendation_sessions")
      .insert({
        profile_id: body.profile_id,
        session_type,
        input_payload: { ...mood_input, content_types },
        openai_response: {
          mood_label: finalMoodLabel,
          mood_tags: finalMoodTags,
          content_types,
          feedback_signals_used: {
            user_tends_to_enjoy_genres: positiveGenres,
            user_tends_to_avoid_genres: negativeGenres,
            user_tends_to_enjoy_tags: positiveTags,
            user_tends_to_avoid_tags: negativeTags,
            recent_feedback_notes_positive: positiveNotesTop,
            recent_feedback_notes_negative: negativeNotesTop,
          },
          candidates_payload: payload1,
        },
        mood_label: finalMoodLabel,
        mood_tags: finalMoodTags,
        top_title_id: null,
        created_at: nowIso(),
      })
      .select()
      .single();

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const sendEvent = (data: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        const { data: session, error: sessionErr } = await createSession();
        if (sessionErr || !session) {
          log(ctx, "Failed to insert recommendation_sessions", sessionErr);
          sendEvent({ type: "error", message: "Failed to create recommendation session" });
          controller.close();
          return;
        }

        sendEvent({
          type: "session_started",
          session_id: session.id,
          profile_id: body.profile_id,
          session_type,
          total_expected: FINAL_COUNT,
          created_at: session.created_at,
        });

        const allCards: RecommendationCard[] = [];
        const recItems: {
          session_id: string;
          title_id: string;
          rank_index: number;
          openai_reason: string | null;
          match_score: number | null;
          created_at: string;
        }[] = [];

        const chosen = await processCandidatesSequential(
          ctx,
          supabaseAdmin,
          payload1.items,
          content_types,
          excludedNormalizedTitles,
          excludedTmdbKeys,
          chosenNorm,
          userRegion,
          FINAL_COUNT,
          (result, index) => {
            const card = buildRecommendationCard(result);
            allCards.push(card);
            recItems.push({
              session_id: session.id,
              title_id: result.mediaRow.id,
              rank_index: index,
              openai_reason: result.item?.reason ?? null,
              match_score: result.item?.match_score ?? null,
              created_at: nowIso(),
            });
            if (result.watchProviders.providerAvailability.length > 0) {
              storeStreamingProviders(
                ctx,
                supabaseAdmin,
                result.mediaRow.id,
                result.watchProviders.providerAvailability,
                userRegion,
                result.watchProviders.link,
              ).catch((err) => log(ctx, "Error storing streaming providers during stream", err));
            }
            log(ctx, `Streaming card ${index + 1}/${FINAL_COUNT}: ${card.title}`);
            sendEvent({ type: "card", card, index });
          },
        );

        // Top-up if needed
        if (chosen.length < FINAL_COUNT) {
          const missing = FINAL_COUNT - chosen.length;
          log(ctx, "Top-up needed during streaming", { missing });
          const chosenTitles = chosen.map((c) => String(c.item?.title || "")).filter(Boolean);

          for (let attempt = 0; attempt < TOPUP_MAX_ATTEMPTS && chosen.length < FINAL_COUNT; attempt++) {
            const topupPromptObj = {
              ...promptObj,
              topup_missing_count: missing,
              already_selected_titles: chosenTitles,
              instruction: `Return exactly ${missing} additional items that are not excluded and not already selected.`,
            };
            const payload2 = await callOpenAI(
              ctx,
              topupPromptObj,
              missing,
              content_types,
              Array.from(new Set([...hardExcludeDeduped, ...chosenTitles])),
              Array.from(new Set([...softExcludeDeduped, ...chosenTitles])),
              positiveSignals,
              negativeSignals,
            );
            if (!finalMoodLabel && payload2.mood_label) finalMoodLabel = payload2.mood_label;
            if ((!finalMoodTags || finalMoodTags.length === 0) && Array.isArray(payload2.mood_tags)) {
              finalMoodTags = payload2.mood_tags;
            }

            await processCandidatesSequential(
              ctx,
              supabaseAdmin,
              payload2.items,
              content_types,
              excludedNormalizedTitles,
              excludedTmdbKeys,
              chosenNorm,
              userRegion,
              missing,
              (result, _relativeIndex) => {
                const absoluteIndex = allCards.length;
                const card = buildRecommendationCard(result);
                allCards.push(card);
                chosen.push(result);
                recItems.push({
                  session_id: session.id,
                  title_id: result.mediaRow.id,
                  rank_index: absoluteIndex,
                  openai_reason: result.item?.reason ?? null,
                  match_score: result.item?.match_score ?? null,
                  created_at: nowIso(),
                });
                if (result.watchProviders.providerAvailability.length > 0) {
                  storeStreamingProviders(
                    ctx,
                    supabaseAdmin,
                    result.mediaRow.id,
                    result.watchProviders.providerAvailability,
                    userRegion,
                    result.watchProviders.link,
                  ).catch((err) => log(ctx, "Error storing streaming providers during topup", err));
                }
                log(ctx, `Streaming topup card ${absoluteIndex + 1}/${FINAL_COUNT}: ${card.title}`);
                sendEvent({ type: "card", card, index: absoluteIndex });
              },
            );
          }
        }

        // Persist recommendation items
        if (recItems.length > 0) {
          const { error: itemsErr } = await supabaseAdmin
            .from("recommendation_items")
            .insert(recItems);
          if (itemsErr) log(ctx, "Failed to insert recommendation_items", itemsErr);
        }

        // Update session with top_title_id
        if (recItems.length > 0) {
          const topTitleId = recItems[0]?.title_id;
          if (topTitleId) {
            await supabaseAdmin
              .from("recommendation_sessions")
              .update({ top_title_id: topTitleId })
              .eq("id", session.id);
          }
        }

        log(ctx, `Streaming complete with ${allCards.length} cards`);
        sendEvent({
          type: "complete",
          id: session.id,
          profile_id: body.profile_id,
          session_type,
          mood_input: { ...mood_input, content_types },
          created_at: session.created_at,
          cards: allCards,
        });

        controller.close();
      } catch (error) {
        log(ctx, "Error during streaming", error);
        sendEvent({ type: "error", message: String(error) });
        controller.close();
      }
    },
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

// ─── Top-up helper ────────────────────────────────────────────────────────────

async function topUp(
  ctx: LogContext,
  opts: {
    // deno-lint-ignore no-explicit-any
    supabaseAdmin: any;
    chosen: CandidateResult[];
    // deno-lint-ignore no-explicit-any
    content_types: any;
    excludedNormalizedTitles: Set<string>;
    excludedTmdbKeys: Set<string>;
    chosenNorm: Set<string>;
    userRegion: string;
    finalMoodLabel: string;
    finalMoodTags: string[];
    // deno-lint-ignore no-explicit-any
    positiveSignals: any;
    // deno-lint-ignore no-explicit-any
    negativeSignals: any;
    hardExcludeDeduped: string[];
    softExcludeDeduped: string[];
    // deno-lint-ignore no-explicit-any
    promptObj: any;
  },
): Promise<{ chosen: CandidateResult[]; finalMoodLabel: string; finalMoodTags: string[] }> {
  let { chosen, finalMoodLabel, finalMoodTags } = opts;
  const {
    supabaseAdmin,
    content_types,
    excludedNormalizedTitles,
    excludedTmdbKeys,
    chosenNorm,
    userRegion,
    positiveSignals,
    negativeSignals,
    hardExcludeDeduped,
    softExcludeDeduped,
    promptObj,
  } = opts;

  const missing = FINAL_COUNT - chosen.length;
  log(ctx, "Top-up needed", { missing });
  const chosenTitles = chosen.map((c) => String(c.item?.title || "")).filter(Boolean);

  for (let attempt = 0; attempt < TOPUP_MAX_ATTEMPTS; attempt++) {
    const topupPromptObj = {
      ...promptObj,
      topup_missing_count: missing,
      already_selected_titles: chosenTitles,
      instruction: `Return exactly ${missing} additional items that are not excluded and not already selected.`,
    };
    const payload2 = await callOpenAI(
      ctx,
      topupPromptObj,
      missing,
      content_types,
      Array.from(new Set([...hardExcludeDeduped, ...chosenTitles])),
      Array.from(new Set([...softExcludeDeduped, ...chosenTitles])),
      positiveSignals,
      negativeSignals,
    );
    if (!finalMoodLabel && payload2.mood_label) finalMoodLabel = payload2.mood_label;
    if ((!finalMoodTags || finalMoodTags.length === 0) && Array.isArray(payload2.mood_tags)) {
      finalMoodTags = payload2.mood_tags;
    }
    const topupChosen = await processCandidatesParallel(
      ctx,
      supabaseAdmin,
      payload2.items,
      content_types,
      excludedNormalizedTitles,
      excludedTmdbKeys,
      chosenNorm,
      userRegion,
      missing,
    );
    chosen = chosen.concat(topupChosen);
    if (chosen.length >= FINAL_COUNT) break;
  }

  return { chosen, finalMoodLabel, finalMoodTags };
}

// ─── Response helpers ─────────────────────────────────────────────────────────

function jsonError(message: string, status: number, details?: unknown): Response {
  return new Response(
    JSON.stringify({ error: message, ...(details !== undefined ? { details } : {}) }),
    { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
  );
}

// Re-export for use in promptObj construction (avoids extra import in index).
function getNoteFromExtraLocal(extra: unknown): string | null {
  const e = extra as Record<string, unknown>;
  const s = typeof e?.feedback_text === "string" ? e.feedback_text.trim() : "";
  if (s) return s;
  const fallback = typeof e?.notes === "string" ? e.notes.trim() : "";
  return fallback || null;
}