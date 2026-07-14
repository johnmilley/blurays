// Storage adapter. Under Tauri every call goes to the Rust/SQLite backend;
// in the browser (PWA) the collection lives in localStorage. Both sides
// expose the same movie shape:
//   { id, title, year, format, barcode, poster, director, runtime,
//     notes, watched, added_at }

export const isTauri = !!window.__TAURI__;

const invoke = isTauri ? window.__TAURI__.core.invoke : null;

const MOVIES_KEY = "shelf.movies.v1";
const SETTINGS_KEY = "shelf.settings.v1";

function webLoad() {
  try {
    return JSON.parse(localStorage.getItem(MOVIES_KEY) || "[]");
  } catch {
    return [];
  }
}

function webSave(movies) {
  localStorage.setItem(MOVIES_KEY, JSON.stringify(movies));
}

function webSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
  } catch {
    return {};
  }
}

export async function listMovies() {
  if (isTauri) return invoke("list_movies");
  return webLoad();
}

export async function addMovie(movie) {
  movie.added_at = new Date().toISOString();
  if (isTauri) return invoke("add_movie", { movie });
  const movies = webLoad();
  movie.id = crypto.randomUUID();
  movies.push(movie);
  webSave(movies);
  return movie;
}

export async function updateMovie(movie) {
  if (isTauri) return invoke("update_movie", { movie });
  const movies = webLoad();
  const i = movies.findIndex((m) => m.id === movie.id);
  if (i >= 0) movies[i] = movie;
  webSave(movies);
}

export async function deleteMovie(id) {
  if (isTauri) return invoke("delete_movie", { id });
  webSave(webLoad().filter((m) => m.id !== id));
}

export async function getSetting(key) {
  if (isTauri) return invoke("get_setting", { key });
  return webSettings()[key] ?? null;
}

export async function setSetting(key, value) {
  if (isTauri) return invoke("set_setting", { key, value });
  const s = webSettings();
  s[key] = value;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
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
      notes: raw.notes || "",
      watched: !!raw.watched,
    };
    await addMovie(movie);
    have.add(keyOf(movie));
    added++;
  }
  return { added, skipped };
}
