// schema/openai.ts
// Two-phase approach:
//   Phase 1 — gpt-4o-mini returns only title strings + mood metadata (fast, cheap).
//   Phase 2 — gpt-4o-mini enriches each title in parallel (bounded by slowest single call).

import OpenAI from "npm:openai@4.20.1";
import type {
  LogContext,
  OpenAIItem,
  OpenAIResponse,
  TmdbType,
  FeedbackSignals,
  NegativeFeedbackSignals,
} from "../lib/types.ts";
import { OPENAI_API_KEY, GENRES_MAX, NOTES_MAX } from "../lib/constants.ts";
import { stripCodeFences, extractFirstJsonObject, log } from "../lib/helpers.ts";

export const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ─── Internal phase-1 type ────────────────────────────────────────────────────

interface Phase1Response {
  mood_label: string;
  mood_tags: string[];
  candidate_titles: string[];
}

// ─── Phase 1: title-only candidate generation ─────────────────────────────────

function buildPhase1SystemPrompt(allowedTypes: TmdbType[]): string {
  const allowed = allowedTypes.join(", ");
  return `You are VibeStream's recommendation engine. Output ONLY valid JSON (no markdown, no fences).

GOAL: Generate a list of ${allowed} titles that match the user's profile.

RULES:
1. Return EXACTLY the requested number of titles.
2. NO duplicates.
3. STRICTLY respect the exclusion list — never include any excluded title or its sequels/remakes.
4. Mix popular hits and hidden gems.
5. Ensure variety in genres, eras, and tones.
6. ONLY suggest these content types: [${allowed}]

OUTPUT FORMAT:
{
  "mood_label": "2-4 word mood description",
  "mood_tags": ["tag1", "tag2", "tag3"],
  "candidate_titles": ["Title 1", "Title 2", ...]
}`;
}

function buildPhase1UserPrompt(
  promptObj: Record<string, unknown>,
  itemsCount: number,
  hardExcludedTitles: string[],
  softExcludedTitles: string[],
  positiveSignals: FeedbackSignals,
  negativeSignals: NegativeFeedbackSignals,
): string {
  let prompt = `Generate exactly ${itemsCount} title(s).\n\n`;

  // Liked / disliked from recent_interactions
  const interactions = Array.isArray(promptObj.recent_interactions)
    ? (promptObj.recent_interactions as Array<Record<string, unknown>>)
    : [];
  const liked = interactions
    .filter((i) => i.action === "like")
    .slice(0, 5)
    .map((i) => i.title)
    .filter(Boolean);
  const disliked = interactions
    .filter((i) => i.action === "dislike")
    .slice(0, 3)
    .map((i) => i.title)
    .filter(Boolean);

  if (liked.length > 0) prompt += `LIKED: ${liked.join(", ")}\n`;
  if (disliked.length > 0) prompt += `DISLIKED: ${disliked.join(", ")}\n`;
  if (liked.length > 0 || disliked.length > 0) prompt += "\n";

  // Genre / tag signals
  const signals: string[] = [];
  if (positiveSignals.genres.length > 0) {
    signals.push(`Enjoys genres: ${positiveSignals.genres.slice(0, GENRES_MAX).join(", ")}`);
  }
  if (negativeSignals.genres.length > 0) {
    signals.push(`Avoids genres: ${negativeSignals.genres.slice(0, GENRES_MAX).join(", ")}`);
  }
  if (positiveSignals.tags.length > 0) {
    signals.push(`Enjoys vibes: ${positiveSignals.tags.slice(0, 10).join(", ")}`);
  }
  if (negativeSignals.tags.length > 0) {
    signals.push(`Avoids vibes: ${negativeSignals.tags.slice(0, 10).join(", ")}`);
  }
  const notes = positiveSignals.notes.concat(negativeSignals.notes).slice(0, NOTES_MAX);
  if (notes.length > 0) {
    signals.push(`Feedback notes: ${notes.join(" | ")}`);
  }
  if (signals.length > 0) {
    prompt += `SIGNALS:\n${signals.map((s) => `- ${s}`).join("\n")}\n\n`;
  }

  // Exclusion list (combined, deduplicated, capped)
  const allExcluded = Array.from(new Set([
    ...hardExcludedTitles.slice(0, 60),
    ...softExcludedTitles.slice(0, 40),
  ]));
  if (allExcluded.length > 0) {
    prompt += `⚠️ EXCLUDE (never suggest): ${allExcluded.join(", ")}\n\n`;
  }

  // Negative titles
  if (negativeSignals.titles.length > 0) {
    prompt += `USER DISLIKES: ${negativeSignals.titles.slice(0, 20).join(", ")}\n\n`;
  }

  // Mood input
  if (promptObj.mood_input && Object.keys(promptObj.mood_input as object).length > 0) {
    prompt += `CURRENT MOOD: ${JSON.stringify(promptObj.mood_input)}\n\n`;
  }

  // Top-up context
  if (promptObj.topup_missing_count) {
    const already = Array.isArray(promptObj.already_selected_titles)
      ? (promptObj.already_selected_titles as string[]).slice(0, 10).join(", ")
      : "";
    prompt += `TOP-UP: Need ${promptObj.topup_missing_count} more. Already selected: ${already}\n\n`;
  }

  prompt += `Return JSON with exactly ${itemsCount} titles in the "candidate_titles" array.`;
  return prompt;
}

// ─── Phase 2: single-title enrichment ────────────────────────────────────────

async function enrichSingleTitle(
  ctx: LogContext,
  title: string,
  moodLabel: string,
  allowedTypes: TmdbType[],
): Promise<OpenAIItem | null> {
  const systemPrompt = `You are a metadata expert for VibeStream. Output ONLY valid JSON (no markdown, no fences).

For the given title, generate enrichment metadata matching this schema exactly:
{
  "title": "exact title string (no year)",
  "tmdb_type": "movie" or "tv",
  "tmdb_search_query": "searchable title without year",
  "primary_genres": ["genre1", "genre2"],
  "tone_tags": ["tag1", "tag2", "tag3"],
  "reason": "1-2 sentence personalized pitch",
  "match_score": <integer 70-99>
}

Constraints:
- tmdb_type must be one of: [${allowedTypes.join(", ")}]
- primary_genres: 1..3 items
- tone_tags: 2..5 items
- match_score: integer between 70 and 99`;

  const userPrompt = `Title: "${title}"
User mood: ${moodLabel}
Allowed content types: ${allowedTypes.join(", ")}

Generate the JSON metadata for this title.`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.8,
      max_tokens: 300,
    });

    const raw = completion.choices[0]?.message?.content?.trim() ?? "";
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log(ctx, `enrichSingleTitle: JSON.parse failed for "${title}"`, { raw: raw.slice(0, 200) });
      return null;
    }

    if (!parsed || typeof parsed.title !== "string") {
      log(ctx, `enrichSingleTitle: missing title field for "${title}"`, { parsed });
      return null;
    }

    const rawType = parsed.tmdb_type as string;
    const validType: TmdbType = allowedTypes.includes(rawType as TmdbType)
      ? (rawType as TmdbType)
      : allowedTypes[0];

    const rawScore = typeof parsed.match_score === "number" ? parsed.match_score : 75;
    const matchScore = Math.min(99, Math.max(70, Math.round(rawScore)));

    return {
      title: parsed.title || title,
      tmdb_type: validType,
      tmdb_search_query: typeof parsed.tmdb_search_query === "string"
        ? parsed.tmdb_search_query
        : title,
      primary_genres: Array.isArray(parsed.primary_genres)
        ? (parsed.primary_genres as string[])
        : [],
      tone_tags: Array.isArray(parsed.tone_tags) ? (parsed.tone_tags as string[]) : [],
      reason: typeof parsed.reason === "string"
        ? parsed.reason
        : "Recommended based on your preferences.",
      match_score: matchScore,
    };
  } catch (e) {
    log(ctx, `enrichSingleTitle: exception for "${title}"`, { error: String(e) });
    return null;
  }
}

// ─── Public API (same signature as before) ────────────────────────────────────

/**
 * Calls OpenAI in two phases:
 *
 * Phase 1 — gpt-4o-mini generates a compact list of candidate title strings
 *            plus mood metadata. Fast and cheap (~500 tokens).
 *
 * Phase 2 — gpt-4o-mini enriches every title in parallel, each call small
 *            (~300 tokens). Total time is bounded by the slowest single call,
 *            not the sum of all calls.
 *
 * Under-delivery from either phase is handled by the existing top-up mechanism
 * in the caller (index.ts).
 */
export async function callOpenAI(
  ctx: LogContext,
  promptObj: unknown,
  itemsCount: number,
  allowedTypes: TmdbType[],
  hardExcludedTitles: string[],
  softExcludedTitles: string[],
  positiveSignals: FeedbackSignals,
  negativeSignals: NegativeFeedbackSignals,
): Promise<OpenAIResponse> {
  const overallStart = Date.now();
  const po = promptObj as Record<string, unknown>;

  // ── Phase 1: generate title list ──────────────────────────────────────────
  log(ctx, "OpenAI Phase 1: candidate title generation", {
    itemsCount,
    allowedTypes,
    hardExcludedCount: hardExcludedTitles.length,
    softExcludedCount: softExcludedTitles.length,
  });

  const phase1Start = Date.now();
  const sys1 = buildPhase1SystemPrompt(allowedTypes);
  const usr1 = buildPhase1UserPrompt(
    po,
    itemsCount,
    hardExcludedTitles,
    softExcludedTitles,
    positiveSignals,
    negativeSignals,
  );

  let phase1: Phase1Response;
  try {
    const completion1 = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: sys1 },
        { role: "user", content: usr1 },
      ],
      temperature: 0.7,
      response_format: { type: "json_object" },
      max_tokens: 500,
    });

    const raw1 = completion1.choices[0]?.message?.content?.trim() ?? "";
    log(ctx, "Phase 1 raw response (first 300 chars)", raw1.slice(0, 300));

    let parsed1: Record<string, unknown>;
    try {
      parsed1 = JSON.parse(raw1);
    } catch {
      const maybe = extractFirstJsonObject(stripCodeFences(raw1));
      if (!maybe) throw new Error("Phase 1: OpenAI returned non-JSON output");
      parsed1 = JSON.parse(maybe);
    }

    if (!parsed1 || !Array.isArray(parsed1.candidate_titles)) {
      throw new Error("Phase 1: missing candidate_titles array");
    }

    phase1 = {
      mood_label: typeof parsed1.mood_label === "string"
        ? parsed1.mood_label
        : "Personalized Mix",
      mood_tags: Array.isArray(parsed1.mood_tags) ? (parsed1.mood_tags as string[]) : [],
      candidate_titles: (parsed1.candidate_titles as string[]).filter(
        (t) => typeof t === "string" && t.trim().length > 0,
      ),
    };

    log(ctx, "Phase 1 complete", {
      duration_ms: Date.now() - phase1Start,
      candidates: phase1.candidate_titles.length,
      mood_label: phase1.mood_label,
      prompt_tokens: completion1.usage?.prompt_tokens,
      completion_tokens: completion1.usage?.completion_tokens,
    });
  } catch (err) {
    log(ctx, "Phase 1 failed", { error: String(err) });
    throw err;
  }

  if (phase1.candidate_titles.length < itemsCount) {
    log(ctx, `Phase 1 under-delivery: got ${phase1.candidate_titles.length}/${itemsCount} titles — top-up will compensate`);
  }

  const titles = phase1.candidate_titles.slice(0, itemsCount);

  // ── Phase 2: parallel enrichment ──────────────────────────────────────────
  log(ctx, "OpenAI Phase 2: parallel title enrichment", {
    titlesToEnrich: titles.length,
  });

  const phase2Start = Date.now();

  const enrichResults = await Promise.all(
    titles.map((title, i) =>
      enrichSingleTitle(ctx, title, phase1.mood_label, allowedTypes).then((item) => {
        if (item) {
          log(ctx, `Phase 2 ✓ ${i + 1}/${titles.length}: ${item.title}`);
        } else {
          log(ctx, `Phase 2 ✗ ${i + 1}/${titles.length}: failed to enrich "${title}"`);
        }
        return item;
      })
    ),
  );

  const items: OpenAIItem[] = enrichResults.filter((item): item is OpenAIItem => item !== null);

  log(ctx, "Phase 2 complete", {
    phase2_duration_ms: Date.now() - phase2Start,
    total_duration_ms: Date.now() - overallStart,
    enriched: items.length,
    failed: titles.length - items.length,
    success_rate: titles.length > 0
      ? `${Math.round((items.length / titles.length) * 100)}%`
      : "0%",
  });

  if (items.length === 0) {
    throw new Error("Phase 2: all title enrichments failed — no items returned");
  }

  return {
    mood_label: phase1.mood_label,
    mood_tags: phase1.mood_tags,
    items,
  };
}

// ─── Legacy export (kept for API compatibility) ───────────────────────────────

/**
 * Builds the monolithic system prompt used by the old single-call approach.
 * No longer used by callOpenAI but kept so any external imports don't break.
 */
export function buildSystemPrompt(
  itemsCount: number,
  allowedTypes: TmdbType[],
  hardExcludedTitles: string[],
  softExcludedTitles: string[],
  positiveSignals: FeedbackSignals,
  negativeSignals: NegativeFeedbackSignals,
): string {
  const allowed = allowedTypes.join(", ");
  const hardEx = hardExcludedTitles.slice(0, 120).join(", ");
  const softEx = softExcludedTitles.slice(0, 120).join(", ");
  const likeGenres = positiveSignals.genres.slice(0, GENRES_MAX).join(", ");
  const avoidGenres = negativeSignals.genres.slice(0, GENRES_MAX).join(", ");
  const avoidTitles = negativeSignals.titles.slice(0, 40).join(", ");
  const likeTags = positiveSignals.tags.slice(0, 20).join(", ");
  const avoidTags = negativeSignals.tags.slice(0, 20).join(", ");
  const notes = positiveSignals.notes.concat(negativeSignals.notes).slice(0, NOTES_MAX).join(" | ");

  return `
You are VibeStream's recommendation engine.

Goal:
Generate EXACTLY ${itemsCount} recommendations based on long-term taste + recent feedback + current mood.

USER FEEDBACK SIGNALS:
- User tends to enjoy genres: [${likeGenres || "unknown"}]
- User tends to avoid genres: [${avoidGenres || "unknown"}]
- User tends to enjoy vibes/tags: [${likeTags || "unknown"}]
- User tends to avoid vibes/tags: [${avoidTags || "unknown"}]
- Titles user disliked or reacted negatively to: [${avoidTitles || "none"}]
- Recent feedback notes: [${notes || "none"}]

STRICT RULES:
1) HARD EXCLUDE: NEVER recommend any title in this list: [${hardEx}]
2) SOFT EXCLUDE: Do NOT recommend these exact watched/completed titles: [${softEx}]
3) Do NOT recommend sequels/prequels/spin-offs/remakes of HARD EXCLUDED titles.
4) Each recommendation must be UNIQUE (no duplicates).
5) ONLY use these content types: [${allowed}] (tmdb_type must be one of them).
6) Return ONLY a JSON object, no markdown, no code fences, no commentary.

OUTPUT SCHEMA (exact):
{
  "mood_label": string,
  "mood_tags": string[],
  "items": [
    {
      "title": string,
      "tmdb_type": "movie" | "tv",
      "tmdb_search_query": string,
      "primary_genres": string[],
      "tone_tags": string[],
      "reason": string,
      "match_score": number
    }
  ]
}

Constraints:
- items length must be exactly ${itemsCount}.
- title must be only the name (no year).
- match_score must be integer 70..99.
- primary_genres 1..3, tone_tags 2..5.
`.trim();
}
