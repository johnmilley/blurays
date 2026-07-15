// Storage adapter. Under Tauri every call goes to the Rust/SQLite backend —
// the only runtime that can write. The browser/PWA side is read-only: it's
// a static page fed by ui/movies.json, which the desktop app publishes (see
// the "mobile web view" menu section and src-tauri/src/publish.rs). Both
// sides expose the same movie shape:
//   { id, title, year, format, barcode, poster, director, runtime,
//     notes, watched, added_at }

export const isTauri = !!window.__TAURI__;

const invoke = isTauri ? window.__TAURI__.core.invoke : null;

export async function listMovies() {
  if (isTauri) return invoke("list_movies");
  try {
    const res = await fetch("./movies.json", { cache: "no-store" });
    return res.ok ? await res.json() : [];
  } catch {
    return [];
  }
}

export async function addMovie(movie) {
  movie.added_at = new Date().toISOString();
  return invoke("add_movie", { movie });
}

export async function updateMovie(movie) {
  return invoke("update_movie", { movie });
}

export async function deleteMovie(id) {
  return invoke("delete_movie", { id });
}

export async function getSetting(key) {
  return invoke("get_setting", { key });
}

export async function setSetting(key, value) {
  return invoke("set_setting", { key, value });
}

// ------------------------------------------------------- publish to phone

/** Desktop only: opens a native folder picker and saves the choice as the
 * repo path used by publish(). */
export async function pickRepoFolder() {
  const path = await window.__TAURI__.dialog.open({ directory: true, multiple: false });
  if (!path) return null;
  await setSetting("repo_path", path);
  return path;
}

/** Desktop only: writes ui/movies.json in the repo and git push'es it. */
export async function publish() {
  return invoke("publish_to_repo");
}

// ---------------------------------------------------------- phone scanning

/** Desktop only: { ip, port, token } for the LAN scan endpoint. */
export async function scanServerInfo() {
  if (!isTauri) return null;
  return invoke("scan_server_info");
}

/** Desktop only: `cb(movie)` fires when a phone scan adds a movie. */
export function onPhoneScan(cb) {
  if (!isTauri) return;
  window.__TAURI__.event.listen("phone-scan", (e) => cb(e.payload));
}

// ---------------------------------------------------------- import/export

export async function exportJson() {
  const movies = await listMovies();
  return JSON.stringify(
    { app: "shelf", version: 1, exported_at: new Date().toISOString(), movies },
    null,
    2,
  );
}

/** Merge exported JSON into the collection. Existing entries (matched by
 * barcode, falling back to title+year) are left alone. */
export async function importJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("not valid JSON");
  }
  const incoming = Array.isArray(data) ? data : data.movies;
  if (!Array.isArray(incoming)) throw new Error("no movies found in file");

  const existing = await listMovies();
  const keyOf = (m) =>
    m.barcode ? `b:${m.barcode}` : `t:${(m.title || "").toLowerCase()}|${m.year ?? ""}`;
  const have = new Set(existing.map(keyOf));

  let added = 0;
  let skipped = 0;
  for (const raw of incoming) {
    if (!raw || !raw.title) continue;
    if (have.has(keyOf(raw))) {
      skipped++;
      continue;
    }
    const movie = {
      title: String(raw.title),
      year: raw.year ?? null,
      format: raw.format || "Blu-ray",
      barcode: raw.barcode ?? null,
      poster: raw.poster ?? null,
      director: raw.director ?? null,
      runtime: raw.runtime ?? null,
      genres: raw.genres ?? null,
      overview: raw.overview ?? null,
      notes: raw.notes || "",
      watched: !!raw.watched,
    };
    await addMovie(movie);
    have.add(keyOf(movie));
    added++;
  }
  return { added, skipped };
}
