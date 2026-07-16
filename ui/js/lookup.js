// Metadata & art sources:
//   upcitemdb  — barcode → product title. Keyless trial (~100/day). CORS-
//                locked, so it goes through Rust on desktop; in the PWA the
//                fetch fails and we degrade to typing a title.
//   blu-ray.com — physical box art (Blu-ray / 4K / DVD covers). Their
//                quicksearch endpoint and cover images are both CORS-open,
//                so this works identically on desktop and phone.
//   TMDB       — theatrical posters + movie details (year, director,
//                runtime, genres, overview). Needs the user's API key.

import { isTauri, getSetting } from "./store.js";

const UPC_URL = "https://api.upcitemdb.com/prod/trial/lookup?upc=";
const TMDB_URL = "https://api.themoviedb.org/3";
const BLURAY_SEARCH = "https://www.blu-ray.com/search/quicksearch.php";
const BLURAY_COVERS = "https://images.static-bluray.com/movies/covers/";
export const TMDB_IMG = "https://image.tmdb.org/t/p/w342";

/** Barcodes compare equal across UPC-A (12) and EAN-13 (13, leading 0). */
export function normalizeBarcode(code) {
  return String(code ?? "").trim().replace(/^0+/, "");
}

/** Guess disc format from a product / edition title. */
export function guessFormat(text) {
  if (/4k|uhd|ultra\s*hd/i.test(text)) return "4K";
  if (/blu-?ray|\bbd\b/i.test(text)) return "Blu-ray";
  if (/dvd/i.test(text)) return "DVD";
  return null;
}

// Phrases that only ever show up as retail-feed noise, never as part of an
// actual movie title: packaging/format, studios/distributors (as they
// appear in UPC product-title text, not their official names), retailer
// exclusives, and condition/shipping filler.
// Order matters: regex alternation takes the first alternative that matches
// at a position, not the longest, so multi-word phrases must come before
// any shorter/generic word they contain (e.g. "new line cinema" before
// bare "new", or it'd match just "new" and strand "line cinema").
const NOISE_PHRASES = [
  "4k", "uhd", "ultra\\s*hd", "blu-?ray", "dvd", "digital(?:\\s+copy|\\s+hd|\\s+code)?",
  "steelbook", "widescreen", "full\\s*screen", "special edition",
  "collector'?s edition", "anniversary edition", "combo pack",
  "\\d+[- ]disc(s)?", "region \\w+",

  "warner\\s*bros\\.?(?:\\s+home\\s+video|\\s+pictures)?",
  "warner\\s+home\\s+video",
  "universal(?:\\s+pictures|\\s+studios)?(?:\\s+home\\s+entertainment)?",
  "sony\\s+pictures(?:\\s+home\\s+entertainment)?",
  "paramount(?:\\s+pictures|\\s+home\\s+entertainment)?",
  "20th\\s+century\\s+(?:fox|studios)",
  "twentieth\\s+century\\s+fox",
  "walt\\s+disney(?:\\s+studios|\\s+pictures|\\s+home\\s+entertainment)?",
  "buena\\s+vista(?:\\s+home\\s+entertainment|\\s+pictures)?",
  "metro[- ]goldwyn[- ]mayer", "mgm",
  "lions?\\s*gate",
  "new\\s+line(?:\\s+cinema)?",
  "focus\\s+features",
  "miramax",
  "dreamworks|dream\\s+works",
  "columbia(?:\\s+pictures)?",
  "tristar",
  "orion(?:\\s+pictures)?",
  "a24",
  "criterion(?:\\s+collection)?",
  "magnolia(?:\\s+pictures|\\s+home\\s+entertainment)?",
  "ifc\\s+films",
  "well\\s+go\\s+usa",
  "shout\\s+factory|scream\\s+factory",
  "kino\\s+lorber",
  "arrow\\s+(?:video|films)",
  "vinegar\\s+syndrome",
  "rlje?(?:\\s+films)?",
  "entertainment\\s+one|e-?one",
  "studiocanal",
  "bbc(?:\\s+home\\s+entertainment)?",
  "hbo",
  "weinstein(?:\\s+company)?",

  "(?:target|walmart|best\\s*buy|amazon)\\s+exclusive",
  "exclusive\\s+edition",
  "exclusive",

  "brand\\s+new", "factory\\s+sealed", "free\\s+shipping", "fast\\s+shipping",
  "ships?\\s+(?:fast|free|same\\s+day)", "authentic", "genuine", "official",
  "licensed", "ex[- ]rental",
];
const NOISE_RE = new RegExp(`\\b(?:${NOISE_PHRASES.join("|")})\\b`, "gi");

/** Strip format/packaging/studio/retailer noise from a UPC product title so
 * it can be used as a search query: retail feeds tend to read "The Matrix
 * (4K Ultra HD + Blu-ray + Digital) - Warner Bros. Pictures NEW SEALED". */
export function cleanTitle(text) {
  return text
    .replace(/[([{][^)\]}]*[)\]}]/g, " ") // bracketed junk
    .replace(/\s[-–—]\s.*$/, " ") // retail feeds append format/edition/studio after a spaced dash
    .replace(/[|•].*$/, " ") // …or after a pipe / bullet separator
    .replace(NOISE_RE, " ")
    // bare "new"/"sealed" are condition words in retail feeds, but also
    // real title words ("New Jack City") — only strip them when they're
    // not the first word, so a leading one is left alone. \s+ (not \s) in
    // the lookbehind because earlier replacements above can leave runs of
    // multiple spaces where brackets/phrases used to be.
    .replace(/(?<=\S\s+)\b(?:new|sealed)\b/gi, " ")
    .replace(/^[+/|·,:;-]+\s*/, "")
    .replace(/[+/|·,:;-]+\s*$/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Look a barcode up. Returns { found, title, format, images } or throws
 * with a human-readable message. */
export async function lookupBarcode(code) {
  let data;
  if (isTauri) {
    data = await window.__TAURI__.core.invoke("lookup_barcode", { code });
  } else {
    let res;
    try {
      res = await fetch(UPC_URL + encodeURIComponent(code));
    } catch {
      throw new Error("barcode lookup is desktop-only (CORS) — type a couple words of the title and hit search");
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
    images: Array.isArray(item.images) ? item.images.slice(0, 4) : [],
  };
}

// ---------------------------------------------------------- blu-ray.com

/** Search blu-ray.com for physical releases. `format` picks the section
 * (DVD vs Blu-ray/4K). Returns
 * [{ title, released, country, url, cover, coverFull, format }]. */
export async function searchBluray(query, format) {
  if (!query) return [];
  const section = format === "DVD" ? "dvdmovies" : "bluraymovies";
  const body = new URLSearchParams({
    section,
    userid: "-1",
    country: "all",
    keyword: query,
  });
  let res;
  try {
    res = await fetch(BLURAY_SEARCH, { method: "POST", body });
  } catch {
    throw new Error("blu-ray.com unreachable");
  }
  if (!res.ok) throw new Error(`blu-ray.com search failed (${res.status})`);
  const html = await res.text();

  // Response is an autocomplete list: <li id="matchN"> items holding
  // "<span>release date</span><img flags/XX.png>&nbsp;Title", plus a
  // parallel `var urls = new Array('…/movies/Slug/12345/', …)`.
  const urlsBlock = html.match(/var urls = new Array\(([\s\S]*?)\);/);
  const urls = urlsBlock ? [...urlsBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
  const items = [...html.matchAll(/<li[^>]*id="match\d+"[^>]*>([\s\S]*?)<\/li>/g)];

  const out = [];
  for (let i = 0; i < items.length && i < urls.length; i++) {
    const url = urls[i];
    const id = url.match(/\/(\d+)\/?$/)?.[1];
    if (!id || !url.includes("/movies/")) continue;
    const li = items[i][1];
    const released = li.match(/<span[^>]*>([^<]*)<\/span>/)?.[1]?.trim() ?? "";
    const country = li.match(/flags\/([A-Z]+)\.png/)?.[1] ?? "";
    const title = li
      .replace(/<span[^>]*>[^<]*<\/span>/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&hellip;/g, "…")
      .replace(/&amp;/g, "&")
      .replace(/&#0?39;/g, "'")
      .trim();
    out.push({
      title,
      released,
      country,
      url,
      cover: `${BLURAY_COVERS}${id}_medium.jpg`,
      coverFull: `${BLURAY_COVERS}${id}_large.jpg`,
      format: guessFormat(title) ?? (section === "dvdmovies" ? "DVD" : "Blu-ray"),
    });
  }
  return out;
}

// ---------------------------------------------------------------- TMDB

export async function tmdbKey() {
  return (await getSetting("tmdb_key")) || null;
}

/** Quick key sanity check against /configuration. */
export async function testTmdbKey(key) {
  const res = await fetch(`${TMDB_URL}/configuration?api_key=${encodeURIComponent(key)}`);
  return res.ok;
}

/** Search TMDB. Returns [] when no API key is configured.
 * Candidates: { tmdbId, title, year, poster, overview }. */
export async function searchTmdb(query, year) {
  const key = await tmdbKey();
  if (!key || !query) return [];
  const url = new URL(`${TMDB_URL}/search/movie`);
  url.searchParams.set("api_key", key);
  url.searchParams.set("query", query);
  if (year) url.searchParams.set("year", year);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`tmdb search failed (${res.status}) — check your api key in the ⋯ menu`);
  const data = await res.json();
  return (data.results || []).slice(0, 8).map((r) => ({
    tmdbId: r.id,
    title: r.title,
    year: r.release_date ? Number(r.release_date.slice(0, 4)) : null,
    poster: r.poster_path ? TMDB_IMG + r.poster_path : null,
    overview: r.overview || null,
  }));
}

/** Full details for one TMDB movie: director, runtime, genres, overview.
 * Best effort — returns {} on any failure. */
export async function tmdbDetails(tmdbId) {
  const key = await tmdbKey();
  if (!key || !tmdbId) return {};
  try {
    const res = await fetch(`${TMDB_URL}/movie/${tmdbId}?api_key=${key}&append_to_response=credits`);
    if (!res.ok) return {};
    const d = await res.json();
    return {
      director: (d.credits?.crew || []).find((c) => c.job === "Director")?.name ?? null,
      runtime: d.runtime || null,
      genres: (d.genres || []).map((g) => g.name).join(", ") || null,
      overview: d.overview || null,
      year: d.release_date ? Number(d.release_date.slice(0, 4)) : null,
    };
  } catch {
    return {};
  }
}
