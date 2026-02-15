// lib/omdb.ts

import type { LogContext, OmdbResponse } from "../lib/types.ts";
import { OMDB_API_KEY, API_TIMEOUT_MS } from "../lib/constants.ts";
import { fetchWithTimeout, log } from "../lib/helpers.ts";

export async function omdbGetDetails(
  ctx: LogContext,
  imdbId: string,
): Promise<OmdbResponse | null> {
  const url = `https://www.omdbapi.com/?apikey=${OMDB_API_KEY}&i=${encodeURIComponent(imdbId)}`;
  try {
    const res = await fetchWithTimeout(url, {}, API_TIMEOUT_MS);
    if (!res.ok) return null;
    const json = (await res.json()) as OmdbResponse;
    if (json && json.Response === "True") return json;
    return null;
  } catch (error) {
    log(ctx, "OMDB error", { imdbId, error: String(error) });
    return null;
  }
}