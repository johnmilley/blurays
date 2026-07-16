import { initTheme, toggleTheme } from "./theme.js";
import * as store from "./store.js";
import {
  lookupBarcode,
  searchBluray,
  searchTmdb,
  tmdbDetails,
  tmdbKey,
  testTmdbKey,
  cleanTitle,
  guessFormat,
  normalizeBarcode,
} from "./lookup.js";
import { renderGrid, renderList, renderText, posterEl } from "./views.js";

const $ = (sel) => document.querySelector(sel);

const PREFS_KEY = "shelf.prefs.v1";

let movies = [];
const prefs = Object.assign(
  { view: "grid", format: "all", watched: "all", sort: "title" },
  JSON.parse(localStorage.getItem(PREFS_KEY) || "{}"),
);
let query = "";
let editing = null; // movie being edited, or null when adding

// ------------------------------------------------------------ helpers

function savePrefs() {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

let msgTimer = 0;
function toast(text, isError = false) {
  const node = $("#status-msg");
  node.textContent = text;
  node.style.color = isError ? "var(--danger)" : "";
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => (node.textContent = ""), 6000);
}

function closeDialog(node) {
  node.closest("dialog")?.close();
}

function findByBarcode(code, excludeId) {
  const norm = normalizeBarcode(code);
  if (!norm) return null;
  return (
    movies.find((m) => normalizeBarcode(m.barcode) === norm && m.id !== excludeId) ?? null
  );
}

async function reload() {
  movies = await store.listMovies();
  render();
}

// ------------------------------------------------------------ rendering

function visibleMovies() {
  const q = query.trim().toLowerCase();
  let out = movies.filter((m) => {
    if (prefs.format !== "all" && m.format !== prefs.format) return false;
    if (prefs.watched === "watched" && !m.watched) return false;
    if (prefs.watched === "unwatched" && m.watched) return false;
    if (
      q &&
      !`${m.title} ${m.director ?? ""} ${m.genres ?? ""} ${m.notes ?? ""}`
        .toLowerCase()
        .includes(q)
    )
      return false;
    return true;
  });
  const cmp = {
    title: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
    year: (a, b) => (b.year ?? 0) - (a.year ?? 0),
    added: (a, b) => (b.added_at ?? "").localeCompare(a.added_at ?? ""),
  }[prefs.sort];
  return out.sort(cmp);
}

function render() {
  const list = visibleMovies();
  const grid = $("#grid");
  const rows = $("#list");
  const text = $("#text");
  const empty = $("#empty");

  grid.hidden = prefs.view !== "grid" || !list.length;
  rows.hidden = prefs.view !== "list" || !list.length;
  text.hidden = prefs.view !== "text" || !list.length;
  empty.hidden = !!list.length;
  if (!list.length && movies.length) {
    $("#empty-message").textContent = "No matches.";
    $("#btn-add-empty").hidden = true;
  } else {
    $("#empty-message").textContent = store.isTauri
      ? "Nothing here yet."
      : "Nothing here yet — scan some discs at home and publish from the desktop app.";
    $("#btn-add-empty").hidden = !store.isTauri;
  }

  const callbacks = store.isTauri
    ? { onOpen: openEdit, onToggleWatched: toggleWatched }
    : { onOpen: showDetail };
  if (prefs.view === "grid") renderGrid(grid, list, callbacks);
  else if (prefs.view === "list") renderList(rows, list, callbacks);
  else renderText(text, list, callbacks);

  for (const chip of document.querySelectorAll("[data-view]")) {
    chip.classList.toggle("selected", chip.dataset.view === prefs.view);
  }

  const unwatched = movies.filter((m) => !m.watched).length;
  const shown = list.length === movies.length ? "" : `${list.length} shown · `;
  $("#status-counts").textContent =
    `${shown}${movies.length} title${movies.length === 1 ? "" : "s"} · ${unwatched} unwatched`;
}

async function toggleWatched(movie) {
  movie.watched = !movie.watched;
  await store.updateMovie(movie);
  render();
}

// ------------------------------------------------------------ add / edit

const dlgMovie = $("#dlg-movie");
const form = $("#movie-form");
const FIELDS = ["barcode", "title", "year", "format", "director", "runtime", "genres", "poster", "overview", "notes"];

function openAdd(prefill = {}) {
  editing = null;
  form.reset();
  $("#dlg-movie-title").textContent = "add movie";
  $("#btn-delete").hidden = true;
  clearLookupUi();
  syncPosterPreview();
  for (const [k, v] of Object.entries(prefill)) {
    if (form.elements[k] && v != null) form.elements[k].value = v;
  }
  $("#art-query").value = prefill.title ?? "";
  dlgMovie.showModal();
  if (!prefill.title) form.elements.barcode.focus();
}

function openEdit(movie) {
  editing = movie;
  form.reset();
  $("#dlg-movie-title").textContent = "edit movie";
  $("#btn-delete").hidden = false;
  clearLookupUi();
  for (const k of FIELDS) form.elements[k].value = movie[k] ?? "";
  form.elements.format.value = movie.format || "Blu-ray";
  form.elements.watched.checked = !!movie.watched;
  $("#art-query").value = movie.title ?? "";
  syncPosterPreview();
  dlgMovie.showModal();
}

function formToMovie() {
  const f = form.elements;
  return {
    ...(editing ?? {}),
    barcode: f.barcode.value.trim() || null,
    title: f.title.value.trim(),
    year: f.year.value ? Number(f.year.value) : null,
    format: f.format.value,
    director: f.director.value.trim() || null,
    runtime: f.runtime.value ? Number(f.runtime.value) : null,
    genres: f.genres.value.trim() || null,
    poster: f.poster.value.trim() || null,
    overview: f.overview.value.trim() || null,
    notes: f.notes.value.trim(),
    watched: f.watched.checked,
  };
}

function syncPosterPreview() {
  const url = form.elements.poster.value.trim();
  const img = $("#poster-preview");
  img.hidden = !url;
  if (url) img.src = url;
}
form.elements.poster.addEventListener("input", syncPosterPreview);

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const movie = formToMovie();
  if (!movie.title) return;
  if (editing) {
    await store.updateMovie(movie);
    toast(`updated “${movie.title}”`);
  } else {
    await store.addMovie(movie);
    toast(`added “${movie.title}”`);
  }
  dlgMovie.close();
  await reload();
});

$("#btn-delete").addEventListener("click", async () => {
  if (!editing) return;
  if (!confirm(`Delete “${editing.title}”?`)) return;
  await store.deleteMovie(editing.id);
  toast(`deleted “${editing.title}”`);
  dlgMovie.close();
  await reload();
});

// barcode field: Enter runs the lookup instead of submitting
form.elements.barcode.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    runLookup();
  }
});
$("#btn-lookup").addEventListener("click", runLookup);
$("#btn-art-search").addEventListener("click", () => runArtSearch());
$("#art-query").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    runArtSearch();
  }
});

// ------------------------------------------------- lookup & art search

function clearLookupUi() {
  $("#lookup-status").hidden = true;
  $("#lookup-status").classList.remove("error");
  $("#art-results").hidden = true;
  $("#group-bluray").hidden = true;
  $("#group-tmdb").hidden = true;
  $("#cands-bluray").replaceChildren();
  $("#cands-tmdb").replaceChildren();
}

function lookupStatus(text, isError = false) {
  const node = $("#lookup-status");
  node.hidden = false;
  node.textContent = text;
  node.classList.toggle("error", isError);
}

async function runLookup() {
  const code = form.elements.barcode.value.trim();
  if (!code) return;
  clearLookupUi();

  const existing = findByBarcode(code, editing?.id);
  if (existing) {
    lookupStatus(`already in your collection: “${existing.title}”`);
    return;
  }

  lookupStatus("looking up barcode…");
  let title = null;
  try {
    const hit = await lookupBarcode(code);
    if (hit.found) {
      title = cleanTitle(hit.title);
      if (!form.elements.title.value) form.elements.title.value = title;
      if (hit.format) form.elements.format.value = hit.format;
      lookupStatus(`found: ${hit.title}`);
    } else {
      lookupStatus("barcode not in the product database — type the title and hit search", true);
    }
  } catch (err) {
    lookupStatus(err.message, true);
  }

  const q = title || form.elements.title.value.trim();
  if (q) {
    $("#art-query").value = q;
    await runArtSearch(true);
  } else {
    $("#art-query").focus();
  }
}

/** Search blu-ray.com (box art) and TMDB (posters + details) in parallel
 * and render both candidate strips. */
async function runArtSearch(keepStatus = false) {
  const q = $("#art-query").value.trim() || form.elements.title.value.trim();
  if (!q) return;
  if (!keepStatus) clearLookupUi();
  $("#art-results").hidden = false;

  const notes = [];
  const [bd, tmdb] = await Promise.allSettled([
    searchBluray(q, form.elements.format.value),
    searchTmdb(q, form.elements.year.value || undefined),
  ]);

  if (bd.status === "fulfilled" && bd.value.length) {
    renderBlurayCandidates(bd.value);
  } else if (bd.status === "rejected") {
    notes.push(bd.reason.message);
  } else {
    notes.push("no box art matches on blu-ray.com");
  }

  if (tmdb.status === "fulfilled" && tmdb.value.length) {
    renderTmdbCandidates(tmdb.value);
  } else if (tmdb.status === "rejected") {
    notes.push(tmdb.reason.message);
  } else if (!(await tmdbKey())) {
    notes.push("no tmdb key — posters & details disabled (add one in the ⋯ menu)");
  } else {
    notes.push("no tmdb matches");
  }

  if (notes.length && !keepStatus) lookupStatus(notes.join(" · "), false);
  else if (notes.length) lookupStatus(($("#lookup-status").textContent + " · " + notes.join(" · ")).trim());
}

function candidateNode(art, lines, onPick) {
  const node = document.createElement("div");
  node.className = "candidate";
  node.append(posterEl(art));
  for (const line of lines) {
    const span = document.createElement("span");
    span.textContent = line;
    span.title = line;
    node.append(span);
  }
  node.addEventListener("click", () => {
    node.parentElement.querySelector(".selected")?.classList.remove("selected");
    node.classList.add("selected");
    onPick();
  });
  return node;
}

function renderBlurayCandidates(results) {
  $("#group-bluray").hidden = false;
  const wrap = $("#cands-bluray");
  wrap.replaceChildren();
  for (const r of results.slice(0, 12)) {
    const node = candidateNode(
      { poster: r.cover, title: r.title },
      [r.title, [r.country, r.released].filter(Boolean).join(" · ")],
      () => {
        form.elements.poster.value = r.coverFull;
        syncPosterPreview();
        const fmt = guessFormat(r.title);
        if (fmt) form.elements.format.value = fmt;
        if (!form.elements.title.value) {
          form.elements.title.value = cleanTitle(r.title).replace(/\s*\(\d{4}\)\s*$/, "");
        }
      },
    );
    wrap.append(node);
  }
}

function renderTmdbCandidates(results) {
  $("#group-tmdb").hidden = false;
  const wrap = $("#cands-tmdb");
  wrap.replaceChildren();
  for (const c of results) {
    const node = candidateNode(
      { poster: c.poster, title: c.title },
      [c.year ? `${c.title} (${c.year})` : c.title],
      async () => {
        form.elements.title.value = c.title;
        if (c.year) form.elements.year.value = c.year;
        // only take the theatrical poster if no box art was chosen
        if (c.poster && !form.elements.poster.value) {
          form.elements.poster.value = c.poster;
          syncPosterPreview();
        }
        if (c.overview && !form.elements.overview.value) form.elements.overview.value = c.overview;
        const extra = await tmdbDetails(c.tmdbId);
        if (extra.director) form.elements.director.value = extra.director;
        if (extra.runtime) form.elements.runtime.value = extra.runtime;
        if (extra.genres) form.elements.genres.value = extra.genres;
        if (extra.overview) form.elements.overview.value = extra.overview;
      },
    );
    wrap.append(node);
  }
}

// ------------------------------------------------------------ read-only detail (mobile)

const dlgDetail = $("#dlg-detail");

/** Non-editable movie popup for the read-only web view — no camera, no
 * add/edit; discs get added at home via the phone-scan Shortcut. */
function showDetail(movie) {
  $("#detail-label").textContent = `${movie.format}${movie.year ? ` · ${movie.year}` : ""}`;
  const body = $("#detail-body");
  body.replaceChildren();

  const card = document.createElement("div");
  card.className = "detail-card";
  card.append(posterEl(movie));

  const info = document.createElement("div");
  const t = document.createElement("div");
  t.textContent = movie.title;
  t.style.fontWeight = "700";
  info.append(t);
  if (movie.director) info.append(el("div", "muted", movie.director));
  if (movie.runtime) info.append(el("div", "muted", `${movie.runtime} min`));
  if (movie.genres) info.append(el("div", "muted", movie.genres));
  info.append(el("div", "detail-watched", movie.watched ? "✓ watched" : "unwatched"));
  if (movie.overview) info.append(el("div", "muted", movie.overview));
  if (movie.notes) info.append(el("div", "muted", movie.notes));
  card.append(info);

  body.append(card);
  dlgDetail.showModal();
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// ------------------------------------------------------------ movie night

const dlgNight = $("#dlg-night");
let nightPick = null;
let nightTimer = 0;

function nightCandidates() {
  return movies.filter(
    (m) => !m.watched && (prefs.format === "all" || m.format === prefs.format),
  );
}

function movieNight() {
  const pool = nightCandidates();
  if (!pool.length) {
    toast("no unwatched movies to pick from", true);
    return;
  }
  dlgNight.showModal();
  roll(pool);
}

function roll(pool) {
  clearInterval(nightTimer);
  const posterBox = $("#night-poster");
  posterBox.classList.add("rolling");
  $("#btn-night-watched").hidden = true;

  let ticks = 0;
  const total = 14;
  const spin = () => {
    const m = pool[Math.floor(Math.random() * pool.length)];
    posterBox.replaceChildren(posterEl(m));
    $("#night-title").textContent = m.title;
    $("#night-meta").textContent = [m.year, m.format, m.runtime && `${m.runtime} min`]
      .filter(Boolean)
      .join(" · ");
    if (++ticks >= total) {
      clearInterval(nightTimer);
      posterBox.classList.remove("rolling");
      nightPick = m;
      $("#btn-night-watched").hidden = false;
    }
  };
  spin();
  nightTimer = setInterval(spin, 110);
}

$("#btn-night-again").addEventListener("click", () => {
  const pool = nightCandidates();
  if (pool.length) roll(pool);
});

$("#btn-night-watched").addEventListener("click", async () => {
  if (!nightPick) return;
  nightPick.watched = true;
  await store.updateMovie(nightPick);
  toast(`“${nightPick.title}” marked watched — enjoy`);
  dlgNight.close();
  render();
});

dlgNight.addEventListener("close", () => clearInterval(nightTimer));

// ------------------------------------------------------------ import / export

async function doExport() {
  const json = await store.exportJson();
  const name = `shelf-export-${new Date().toISOString().slice(0, 10)}.json`;
  if (store.isTauri) {
    const path = await window.__TAURI__.dialog.save({
      defaultPath: name,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!path) return;
    await window.__TAURI__.core.invoke("write_file", { path, contents: json });
    toast(`exported to ${path}`);
  } else {
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
    toast("exported");
  }
}

async function doImport() {
  if (store.isTauri) {
    const path = await window.__TAURI__.dialog.open({
      multiple: false,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!path) return;
    const text = await window.__TAURI__.core.invoke("read_file", { path });
    await finishImport(text);
  } else {
    $("#import-file").click();
  }
}

$("#import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (file) await finishImport(await file.text());
});

async function finishImport(text) {
  try {
    const { added, skipped } = await store.importJson(text);
    toast(`imported ${added} new, skipped ${skipped} already on the shelf`);
    await reload();
  } catch (err) {
    toast(`import failed: ${err.message}`, true);
  }
}

// -------------------------------------------------- bulk enrichment

const needsEnrichment = (m) => !m.poster || !m.director || !m.genres;

/** Fill in one movie's missing poster/details in place: box art from
 * blu-ray.com, details from TMDB, first plausible match wins. Returns
 * whether anything changed. */
async function enrichMovie(m) {
  let changed = false;

  if (!m.poster) {
    try {
      const covers = await searchBluray(m.title, m.format);
      const best = covers.find((c) => c.format === m.format) ?? covers[0] ?? null;
      if (best) {
        m.poster = best.coverFull;
        changed = true;
      }
    } catch {
      // blu-ray.com down/blocked — TMDB below may still cover us
    }
  }

  if (!m.director || !m.genres || !m.poster) {
    try {
      const hits = await searchTmdb(m.title, m.year ?? undefined);
      const hit = hits.find((h) => !m.year || h.year === m.year) ?? hits[0] ?? null;
      if (hit) {
        const extra = await tmdbDetails(hit.tmdbId);
        if (!m.poster && hit.poster) (m.poster = hit.poster), (changed = true);
        if (!m.year && hit.year) (m.year = hit.year), (changed = true);
        if (!m.director && extra.director) (m.director = extra.director), (changed = true);
        if (!m.runtime && extra.runtime) (m.runtime = extra.runtime), (changed = true);
        if (!m.genres && extra.genres) (m.genres = extra.genres), (changed = true);
        if (!m.overview && extra.overview) (m.overview = extra.overview), (changed = true);
      }
    } catch {
      // no key / rate limit — keep going with what we have
    }
  }

  return changed;
}

/** Fill in missing posters/details across the collection. */
async function fetchMissing() {
  const targets = movies.filter(needsEnrichment);
  if (!targets.length) {
    toast("nothing missing — the shelf is fully dressed");
    return;
  }
  const btn = $("#btn-fetch-missing");
  btn.disabled = true;
  let touched = 0;
  try {
    for (let i = 0; i < targets.length; i++) {
      const m = targets[i];
      toast(`fetching ${i + 1}/${targets.length}: ${m.title}…`);
      if (await enrichMovie(m)) {
        await store.updateMovie(m);
        touched++;
      }
      await new Promise((r) => setTimeout(r, 350)); // be polite to the sources
    }
  } finally {
    btn.disabled = false;
  }
  toast(`updated ${touched} of ${targets.length} movies`);
  await reload();
}

// ------------------------------------------------------------ tauri chrome

function initWindowChrome() {
  if (!store.isTauri) return;
  document.body.classList.add("tauri");
  $("#titlebar-buttons").hidden = false;
  for (const grip of document.querySelectorAll(".grip")) grip.hidden = false;

  const appWindow = window.__TAURI__.window.getCurrentWindow();
  $("#tb-min").addEventListener("click", () => void appWindow.minimize());
  $("#tb-max").addEventListener("click", () => void appWindow.toggleMaximize());
  $("#tb-close").addEventListener("click", () => void appWindow.close());

  for (const grip of document.querySelectorAll(".grip")) {
    grip.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      void appWindow.startResizeDragging(grip.dataset.dir);
    });
  }

  const syncMaximized = async () =>
    document.body.classList.toggle("maximized", await appWindow.isMaximized());
  void appWindow.onResized(() => void syncMaximized());
  void syncMaximized();
}

// ------------------------------------------------------------ wiring

function initToolbar() {
  $("#search").addEventListener("input", (e) => {
    query = e.target.value;
    render();
  });

  for (const chip of document.querySelectorAll("[data-format]")) {
    chip.addEventListener("click", () => {
      prefs.format = chip.dataset.format;
      document.querySelectorAll("[data-format]").forEach((c) => c.classList.toggle("selected", c === chip));
      savePrefs();
      render();
    });
    chip.classList.toggle("selected", chip.dataset.format === prefs.format);
  }

  for (const chip of document.querySelectorAll("[data-watched]")) {
    chip.addEventListener("click", () => {
      prefs.watched = chip.dataset.watched;
      document.querySelectorAll("[data-watched]").forEach((c) => c.classList.toggle("selected", c === chip));
      savePrefs();
      render();
    });
    chip.classList.toggle("selected", chip.dataset.watched === prefs.watched);
  }

  const sort = $("#sort");
  sort.value = prefs.sort;
  sort.addEventListener("change", () => {
    prefs.sort = sort.value;
    savePrefs();
    render();
  });

  for (const chip of document.querySelectorAll("[data-view]")) {
    chip.addEventListener("click", () => {
      prefs.view = chip.dataset.view;
      savePrefs();
      render();
    });
  }

  $("#btn-theme").addEventListener("click", toggleTheme);

  // add/edit, movie night, and the ⋯ menu are desktop-only — the phone view
  // is a read-only browse of what's already on the shelf, kept up to date
  // by the desktop's "publish" button rather than editing on the go
  if (store.isTauri) {
    $("#btn-add").hidden = false;
    $("#btn-night").hidden = false;
    $("#btn-menu").hidden = false;
    $("#btn-add").addEventListener("click", () => openAdd());
    $("#btn-add-empty").addEventListener("click", () => openAdd());
    $("#btn-night").addEventListener("click", movieNight);
    $("#btn-menu").addEventListener("click", () => openMenu());
  }
}

async function openMenu() {
  $("#tmdb-key").value = (await store.getSetting("tmdb_key")) || "";
  $("#tmdb-key-status").textContent = "";
  $("#about-line").textContent =
    `shelf · ${store.isTauri ? "desktop" : "pwa"} · ${movies.length} titles`;
  if (store.isTauri) {
    $("#phone-scan-section").hidden = false;
    try {
      const { ip, port, token } = await store.scanServerInfo();
      $("#scan-url").textContent = `http://${ip}:${port}/scan?token=${token}&code=`;
      $("#phone-scan-status").textContent =
        `listening on ${ip}:${port} — phone must be on the same wi-fi. ` +
        `if scans don't arrive, open the port: sudo firewall-cmd --add-port=${port}/tcp`;
    } catch (e) {
      $("#phone-scan-status").textContent = `scan server unavailable: ${e}`;
    }
    const repoPath = await store.getSetting("repo_path");
    $("#repo-path-status").textContent = repoPath
      ? `repo: ${repoPath}`
      : "no repo folder set yet";
    $("#publish-status").textContent = "";
  }
  $("#dlg-menu").showModal();
}

async function setRepoFolder() {
  const path = await store.pickRepoFolder();
  if (!path) return;
  $("#repo-path-status").textContent = `repo: ${path}`;
  toast("repo folder set");
}

async function doPublish() {
  const btn = $("#btn-publish");
  btn.disabled = true;
  $("#publish-status").textContent = "publishing…";
  try {
    const result = await store.publish();
    $("#publish-status").textContent = result;
    toast(result);
  } catch (err) {
    $("#publish-status").textContent = String(err);
    toast(`publish failed: ${err}`, true);
  } finally {
    btn.disabled = false;
  }
}

async function saveKey() {
  const key = $("#tmdb-key").value.trim();
  await store.setSetting("tmdb_key", key);
  const status = $("#tmdb-key-status");
  if (!key) {
    status.textContent = "key cleared";
    return;
  }
  status.textContent = "checking key…";
  try {
    status.textContent = (await testTmdbKey(key))
      ? "✓ key works — posters & details enabled"
      : "✗ tmdb rejected that key";
  } catch {
    status.textContent = "couldn't reach tmdb to verify (saved anyway)";
  }
}

function initMenu() {
  $("#btn-export").addEventListener("click", doExport);
  $("#btn-import").addEventListener("click", doImport);
  $("#btn-set-repo").addEventListener("click", setRepoFolder);
  $("#btn-publish").addEventListener("click", doPublish);
  $("#btn-fetch-missing").addEventListener("click", fetchMissing);
  $("#btn-save-key").addEventListener("click", saveKey);
  $("#tmdb-key").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveKey();
    }
  });
}

function initShortcuts() {
  window.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (document.querySelector("dialog[open]")) return;
    if (e.key === "/") {
      e.preventDefault();
      $("#search").focus();
    } else if (e.key === "n" && store.isTauri) {
      e.preventDefault();
      openAdd();
    } else if (e.key === "g") {
      e.preventDefault();
      const order = ["grid", "list", "text"];
      prefs.view = order[(order.indexOf(prefs.view) + 1) % order.length];
      savePrefs();
      render();
    }
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  initTheme();
  initWindowChrome();
  initToolbar();
  initMenu();
  initShortcuts();

  for (const btn of document.querySelectorAll("[data-close]")) {
    btn.addEventListener("click", () => closeDialog(btn));
  }

  await reload();

  // phone scans land in SQLite from the Rust side; refresh, announce, and
  // immediately chase down box art/details so it doesn't sit bare until
  // the next manual "fetch missing" pass. Scans arrive in bursts during a
  // shelf-cataloging session, so the handlers are chained onto a queue —
  // each one reloads and re-renders the whole collection, and letting them
  // overlap made the UI stutter hard mid-batch.
  let scanChain = Promise.resolve();
  store.onPhoneScan((movie) => {
    scanChain = scanChain.then(async () => {
      await reload();
      toast(`scanned from phone: ${movie.title} [${movie.format}]`);

      const m = movies.find((mv) => mv.id === movie.id);
      if (!m || !needsEnrichment(m)) return;
      try {
        if (await enrichMovie(m)) {
          await store.updateMovie(m);
          await reload();
        }
      } catch {
        // best-effort — the movie is already on the shelf either way
      }
    });
  });

  if (!store.isTauri && "serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
});
