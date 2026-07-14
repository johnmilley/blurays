// Barcode → title via the upcitemdb trial API (keyless, ~100 req/day),
// then optional TMDB search for clean title/year/poster/director.
// Under Tauri the UPC call goes through Rust (no CORS); in the browser we
// try a direct fetch and degrade to manual entry if it's blocked.

import { isTauri, getSetting } from "./store.js";

const UPC_URL = "https://api.upcitemdb.com/prod/trial/lookup?upc=";
const TMDB_URL = "https://api.themoviedb.org/3";
export const TMDB_IMG = "https://image.tmdb.org/t/p/w342";

/** Guess disc format from a UPC product title. */
export function guessFormat(text) {
  if (/4k|uhd|ultra\s*hd/i.test(text)) return "4K";
  if (/blu-?ray|\bbd\b/i.test(text)) return "Blu-ray";
  if (/dvd/i.test(text)) return "DVD";
  return null;
}

/** Strip format/packaging noise from a UPC product title so it can be used
 * as a search query: "The Matrix (4K Ultra HD + Blu-ray + Digital) [2018]". */
export function cleanTitle(text) {
  return text
    .replace(/[([{][^)\]}]*[)\]}]/g, " ") // bracketed junk
    .replace(/\b(4k|uhd|ultra\s*hd|blu-?ray|dvd|digital|steelbook|widescreen|full\s*screen|special edition|collector'?s edition|anniversary edition|combo pack|\d+[- ]disc(s)?|region \w+|new|sealed)\b/gi, " ")
    .replace(/[+/|·-]+\s*$/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Look a barcode up. Returns { found, title, format } or throws with a
 * human-readable message. */
export async function lookupBarcode(code) {
  let data;
  if (isTauri) {
    data = await window.__TAURI__.core.invoke("lookup_barcode", { code });
  } else {
    let res;
    try {
      res = await fetch(UPC_URL + encodeURIComponent(code));
    } catch {
      throw new Error("barcode lookup unreachable from the browser — fill in details manually");
    }
    if (res.status === 429) throw new Error("barcode service rate limit hit — try again later");
    if (!res.ok) throw new Error(`barcode lookup failed (${res.status})`);
    data = await res.json();
  }

  const item = data && Array.isArray(data.items) && data.items[0];
  if (!item || !item.title) return { found: false };
  return {
    found: true,
    title: item.title,
    format: guessFormat(item.title),
  };
}

/** Search TMDB for a movie. Returns [] when no API key is configured.
 * Candidates: { title, year, poster, director?, runtime? }. */
export async function searchTmdb(query, year) {
  const key = await getSetting("tmdb_key");
  if (!key || !query) return [];
  const url = new URL(`${TMDB_URL}/search/movie`);
  url.searchParams.set("api_key", key);
  url.searchParams.set("query", query);
  if (year) url.searchParams.set("year", year);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`tmdb search failed (${res.status}) — check your api key`);
  const data = await res.json();
  return (data.results || []).slice(0, 6).map((r) => ({
    tmdbId: r.id,
    title: r.title,
    year: r.release_date ? Number(r.release_date.slice(0, 4)) : null,
    poster: r.poster_path ? TMDB_IMG + r.poster_path : null,
  }));
}

/** Fetch director + runtime for one TMDB movie (best effort). */
export async function tmdbDetails(tmdbId) {
  const key = await getSetting("tmdb_key");
  if (!key || !tmdbId) return {};
  try {
    const res = await fetch(`${TMDB_URL}/movie/${tmdbId}?api_key=${key}&append_to_response=credits`);
    if (!res.ok) return {};
    const d = await res.json();
    const director = (d.credits?.crew || []).find((c) => c.job === "Director")?.name ?? null;
    return { director, runtime: d.runtime || null };
  } catch {
    return {};
  }
}
