// lib/helpers.ts

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import type { LogContext, InteractionAction, Sentiment, TmdbType } from "./types.ts";
import { NOTES_MAX } from "./constants.ts";

// ─── String helpers ───────────────────────────────────────────────────────────

export function normalizeTitle(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export function stripCodeFences(s: string): string {
  let out = (s || "").trim();
  if (out.startsWith("```json")) out = out.slice(7).trim();
  else if (out.startsWith("```")) out = out.slice(3).trim();
  if (out.endsWith("```")) out = out.slice(0, -3).trim();
  return out;
}

/**
 * Extracts the first complete JSON object from a string.
 * Handles nested objects and escaped characters.
 */
export function extractFirstJsonObject(s: string): string | null {
  const text = stripCodeFences(s);
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === `"`) inStr = !inStr;
    if (inStr) continue;
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

// ─── Logging ──────────────────────────────────────────────────────────────────

export function log(ctx: LogContext, msg: string, extra?: unknown): void {
  const ts = new Date().toISOString();
  const base =
    `[create_recommendation_session][${ts}][req:${ctx.reqId}]` +
    (ctx.userId ? `[user:${ctx.userId}]` : "[user:unknown]") +
    (ctx.profileId ? `[profile:${ctx.profileId}]` : "");
  if (extra !== undefined) console.log(base + " " + msg, extra);
  else console.log(base + " " + msg);
}

// ─── Feedback helpers ─────────────────────────────────────────────────────────

export function getFeedbackWeight(createdAtIso: string): number {
  const ms = Date.now() - new Date(createdAtIso).getTime();
  const days = ms / (24 * 60 * 60 * 1000);
  if (days <= 7) return 1.0;
  if (days <= 30) return 0.5;
  return 0.25;
}

export function getNoteFromExtra(extra: unknown): string | null {
  const e = extra as Record<string, unknown>;
  const s = typeof e?.feedback_text === "string" ? e.feedback_text.trim() : "";
  if (s) return s;
  const fallback = typeof e?.notes === "string" ? e.notes.trim() : "";
  return fallback || null;
}

export function getFeedbackSentiment(
  action: InteractionAction,
  rating: number | null,
  extra: unknown,
): Sentiment {
  const e = extra as Record<string, unknown>;
  const wouldWatchAgain = e?.would_watch_again === true;
  const quickTags: string[] = Array.isArray(e?.quick_tags)
    ? (e.quick_tags as unknown[]).map((x) => String(x).toLowerCase())
    : [];
  const hasNegativeTag =
    quickTags.some((t) => t.includes("too slow")) ||
    quickTags.some((t) => t.includes("boring")) ||
    quickTags.some((t) => t.includes("bad"));
  const hasPositiveTag =
    quickTags.some((t) => t.includes("great")) ||
    quickTags.some((t) => t.includes("amazing")) ||
    quickTags.some((t) => t.includes("excellent"));

  if (rating !== null) {
    if (rating >= 4) return "positive";
    if (rating <= 2) return "negative";
    if (rating === 3) return "neutral";
  }
  if (action === "feedback" && wouldWatchAgain) return "positive";
  if (action === "feedback" && hasNegativeTag) return "negative";
  if (action === "feedback" && hasPositiveTag) return "positive";
  if (action === "like") return "positive";
  if (action === "dislike") return "negative";
  if (action === "skip") return "negative";
  return "neutral";
}

// ─── Scoring helpers ──────────────────────────────────────────────────────────

export function topKeysByScore(m: Map<string, number>, max: number): string[] {
  return Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, max).map((x) => x[0]);
}

export function topNotes(list: Array<{ text: string; w: number; at: string }>, max: number): string[] {
  return list.sort((a, b) => b.w - a.w).slice(0, max).map((x) => x.text);
}

// ─── Request validation ───────────────────────────────────────────────────────

export const RequestBodySchema = z.object({
  profile_id: z.string().uuid(),
  session_type: z.enum(["onboarding", "mood", "quick_match"]),
  mood_input: z.record(z.unknown()).optional().default({}),
  content_types: z.array(z.enum(["movie", "tv"])).optional(),
  stream: z.boolean().optional().default(false),
});

export type RequestBody = z.infer<typeof RequestBodySchema>;

export function parseContentTypes(body: RequestBody): TmdbType[] {
  const raw = body.content_types ?? (body.mood_input as Record<string, unknown>)?.content_types ?? [];
  const list = Array.isArray(raw) ? raw : [];
  const cleaned = list
    .map((x: unknown) => String(x).toLowerCase().trim())
    .filter((x): x is TmdbType => x === "movie" || x === "tv");
  const unique = Array.from(new Set(cleaned));
  return unique.length > 0 ? unique : ["movie"];
}

// ─── Network helpers ──────────────────────────────────────────────────────────

export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 5000,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timeout after ${timeoutMs}ms: ${url}`);
    }
    throw error;
  }
}