import { initTheme, toggleTheme } from "./theme.js";
import * as store from "./store.js";
import { lookupBarcode, searchTmdb, tmdbDetails, cleanTitle, guessFormat } from "./lookup.js";
import { scanSupported, startScan, stopScan } from "./scan.js";
import { renderGrid, renderList, posterEl } from "./views.js";

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
    if (q && !`${m.title} ${m.director ?? ""} ${m.notes ?? ""}`.toLowerCase().includes(q))
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
  const empty = $("#empty");

  grid.hidden = prefs.view !== "grid" || !list.length;
  rows.hidden = prefs.view !== "list" || !list.length;
  empty.hidden = !!list.length;
  if (!list.length && movies.length) {
    empty.querySelector("p").textContent = "No matches.";
    empty.querySelector("button").hidden = true;
  } else {
    empty.querySelector("p").textContent = "Nothing here yet.";
    empty.querySelector("button").hidden = false;
  }

  const callbacks = { onOpen: openEdit, onToggleWatched: toggleWatched };
  if (prefs.view === "grid") renderGrid(grid, list, callbacks);
  else renderList(rows, list, callbacks);

  $("#btn-view").textContent = prefs.view === "grid" ? "list" : "grid";

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

function openAdd(prefill = {}) {
  editing = null;
  form.reset();
  $("#dlg-movie-title").textContent = "add movie";
  $("#btn-delete").hidden = true;
  clearLookupUi();
  for (const [k, v] of Object.entries(prefill)) {
    if (form.elements[k] && v != null) form.elements[k].value = v;
  }
  dlgMovie.showModal();
  if (!prefill.title) form.elements.barcode.focus();
}

function openEdit(movie) {
  editing = movie;
  form.reset();
  $("#dlg-movie-title").textContent = "edit movie";
  $("#btn-delete").hidden = false;
  clearLookupUi();
  for (const k of ["barcode", "title", "year", "format", "director", "runtime", "poster", "notes"]) {
    form.elements[k].value = movie[k] ?? "";
  }
  form.elements.format.value = movie.format || "Blu-ray";
  form.elements.watched.checked = !!movie.watched;
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
    poster: f.poster.value.trim() || null,
    notes: f.notes.value.trim(),
    watched: f.watched.checked,
  };
}

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

function clearLookupUi() {
  $("#lookup-status").hidden = true;
  $("#lookup-status").classList.remove("error");
  $("#tmdb-candidates").hidden = true;
  $("#tmdb-candidates").replaceChildren();
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

  const existing = movies.find((m) => m.barcode === code && m.id !== editing?.id);
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
      lookupStatus("barcode not in the product database — fill in details manually", true);
    }
  } catch (err) {
    lookupStatus(err.message, true);
  }

  await showTmdbCandidates(title || form.elements.title.value.trim());
}

async function showTmdbCandidates(queryTitle) {
  if (!queryTitle) return;
  let candidates;
  try {
    candidates = await searchTmdb(queryTitle);
  } catch (err) {
    lookupStatus(err.message, true);
    return;
  }
  if (!candidates.length) return;

  const wrap = $("#tmdb-candidates");
  wrap.hidden = false;
  wrap.replaceChildren();
  for (const c of candidates) {
    const node = document.createElement("div");
    node.className = "candidate";
    node.append(posterEl({ poster: c.poster, title: c.title }));
    const label = document.createElement("span");
    label.textContent = c.year ? `${c.title} (${c.year})` : c.title;
    node.append(label);
    node.addEventListener("click", async () => {
      wrap.querySelector(".selected")?.classList.remove("selected");
      node.classList.add("selected");
      form.elements.title.value = c.title;
      if (c.year) form.elements.year.value = c.year;
      if (c.poster) form.elements.poster.value = c.poster;
      const extra = await tmdbDetails(c.tmdbId);
      if (extra.director) form.elements.director.value = extra.director;
      if (extra.runtime) form.elements.runtime.value = extra.runtime;
    });
    wrap.append(node);
  }
}

// ------------------------------------------------------------ scanning

const dlgScan = $("#dlg-scan");
const dlgScanResult = $("#dlg-scan-result");
const video = $("#scan-video");
let scanTarget = "check"; // "check" (toolbar flow) | "form" (fill barcode field)

async function beginScan(target) {
  scanTarget = target;
  dlgScan.showModal();
  let code;
  try {
    code = await startScan(video);
  } catch {
    dlgScan.close();
    toast("camera unavailable", true);
    return;
  }
  dlgScan.close();
  if (!code) return; // cancelled

  if (scanTarget === "form") {
    form.elements.barcode.value = code;
    runLookup();
    return;
  }
  showScanResult(code);
}

dlgScan.addEventListener("close", () => stopScan(video));

function showScanResult(code) {
  const owned = movies.find((m) => m.barcode === code);
  const body = $("#scan-result-body");
  body.replaceChildren();

  const card = document.createElement("div");
  card.className = "scan-result-card";
  if (owned) {
    $("#scan-result-label").textContent = "you have this";
    card.append(posterEl(owned));
    const info = document.createElement("div");
    info.innerHTML = `<div class="scan-owned">✓ in your collection</div>`;
    const t = document.createElement("div");
    t.textContent = `${owned.title}${owned.year ? ` (${owned.year})` : ""} — ${owned.format}`;
    const w = document.createElement("div");
    w.className = "muted";
    w.textContent = owned.watched ? "watched" : "unwatched";
    info.append(t, w);
    if (owned.notes) {
      const n = document.createElement("div");
      n.className = "muted";
      n.textContent = owned.notes;
      info.append(n);
    }
    card.append(info);
    $("#btn-scan-add").hidden = true;
  } else {
    $("#scan-result-label").textContent = "not in collection";
    const info = document.createElement("div");
    info.textContent = `no movie with barcode ${code} on your shelf.`;
    card.append(info);
    const add = $("#btn-scan-add");
    add.hidden = false;
    add.onclick = () => {
      dlgScanResult.close();
      openAdd({ barcode: code });
      runLookup();
    };
  }
  body.append(card);
  dlgScanResult.showModal();
}

$("#btn-scan-again").addEventListener("click", () => {
  dlgScanResult.close();
  beginScan("check");
});

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

  $("#btn-view").addEventListener("click", () => {
    prefs.view = prefs.view === "grid" ? "list" : "grid";
    savePrefs();
    render();
  });

  $("#btn-theme").addEventListener("click", toggleTheme);
  $("#btn-add").addEventListener("click", () => openAdd());
  $("#btn-add-empty").addEventListener("click", () => openAdd());
  $("#btn-night").addEventListener("click", movieNight);
  $("#btn-menu").addEventListener("click", () => openMenu());

  if (scanSupported()) {
    $("#btn-scan").hidden = false;
    $("#btn-scan-inline").hidden = false;
    $("#btn-scan").addEventListener("click", () => beginScan("check"));
    $("#btn-scan-inline").addEventListener("click", () => beginScan("form"));
  }
}

async function openMenu() {
  $("#tmdb-key").value = (await store.getSetting("tmdb_key")) || "";
  $("#about-line").textContent =
    `shelf · ${store.isTauri ? "desktop" : "pwa"} · ${movies.length} titles`;
  $("#dlg-menu").showModal();
}

function initMenu() {
  $("#btn-export").addEventListener("click", doExport);
  $("#btn-import").addEventListener("click", doImport);
  $("#btn-save-key").addEventListener("click", async () => {
    await store.setSetting("tmdb_key", $("#tmdb-key").value.trim());
    toast("tmdb key saved");
  });
}

function initShortcuts() {
  window.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (document.querySelector("dialog[open]")) return;
    if (e.key === "/") {
      e.preventDefault();
      $("#search").focus();
    } else if (e.key === "n") {
      e.preventDefault();
      openAdd();
    } else if (e.key === "g") {
      $("#btn-view").click();
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

  if (!store.isTauri && "serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
});
