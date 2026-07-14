# shelf

A no-frills Blu-ray / DVD / 4K collection catalog, in the spirit of CLZ Movies
but without the clutter. Core use case: standing in a store, scanning a
barcode, and knowing in two seconds whether the disc is already on the shelf.
Sibling app to lp, pt, and ved — same design language (iA Writer Quattro,
warm orange accent, flat panels, custom titlebar, quiet scrollbars).

## Architecture

One frontend, two runtimes:

```
ui/                  vanilla HTML/CSS/JS — no build step, no framework
  index.html         single page: toolbar, grid/list, dialogs
  styles.css         design tokens (:root[data-theme=dark|light]) + all styling
  js/
    main.js          controller: state, wiring, rendering pipeline
    store.js         STORAGE ADAPTER — the key seam (see below)
    views.js         pure rendering (grid cards / list rows)
    lookup.js        barcode → title (upcitemdb), blu-ray.com box art search,
                     TMDB posters/details
    scan.js          camera scanning: BarcodeDetector where available,
                     else our own decoder (iOS Safari)
    ean13.js         pure-JS EAN-13/UPC-A decoder for camera frames —
                     tested by synthetic-barcode suite (see git history)
    theme.js         dark/light toggle, localStorage-persisted
  manifest.webmanifest, sw.js   PWA shell (app-shell cache, offline-capable)
  fonts/, icons/     vendored — everything is self-contained, relative paths

src-tauri/           Rust backend for the desktop app
  src/lib.rs         Tauri commands + setup
  src/db.rs          SQLite (rusqlite, bundled) — movies + settings tables
  src/lookup.rs      UPC lookup over ureq (bypasses webview CORS)
```

**The seam:** `ui/js/store.js` detects `window.__TAURI__`. Under Tauri, every
data call invokes a Rust command backed by SQLite in the app data dir
(`~/.local/share/com.johnathan.shelf/shelf.db`). In a browser, the same API
is served from localStorage. Everything above the adapter is shared, so the
PWA *is* the desktop viewer.

**Sync** is deliberately dumb: export JSON on one device, import on the
other. Import merges — existing entries (matched by barcode, else
title+year) are skipped, never overwritten.

**Movie shape** (both runtimes): `{ id, title, year, format ("4K" | "Blu-ray"
| "DVD"), barcode, poster, director, runtime, notes, watched, added_at }`.
IDs are SQLite rowids on desktop, UUIDs in the PWA — treated as opaque in JS.

## External services (all optional, degrade gracefully)

- **upcitemdb trial API** — keyless barcode → product title, ~100 req/day.
  Routed through Rust on desktop; CORS-locked, so in the PWA the fetch fails
  and the user types a title instead (scan-to-check needs no network at all).
- **blu-ray.com quicksearch** — physical box art. POST to
  `search/quicksearch.php` (`section=bluraymovies|dvdmovies`), response is an
  autocomplete `<li>` list plus a parallel `var urls = new Array(…)`; covers
  live at `images.static-bluray.com/movies/covers/{id}_{medium,large,front}.jpg`.
  Endpoint and images are both CORS-open (`ACAO: *`), so this works from the
  phone too. Unofficial — if it breaks, check the response shape first.
- **TMDB** — posters + details (year, director, runtime, genres, overview).
  Needs an API key (⋯ menu, stored in settings, never committed). Key is
  validated against `/configuration` on save.

**Movie shape** gained `genres` and `overview`; `db::migrate()` ALTERs older
SQLite databases. Barcodes are compared via `normalizeBarcode()` (leading
zeros stripped) so a scanned EAN-13 matches a typed UPC-A.

## Running

```sh
# desktop (needs Rust + Tauri Linux deps: webkit2gtk-4.1, etc.)
cd src-tauri && cargo tauri dev     # or: cargo run
# there is intentionally no npm/vite step; frontendDist points at ../ui

# PWA — any static file server over ui/, e.g.
python3 -m http.server -d ui 8080
```

Camera scanning needs a secure context (https or localhost) and the
BarcodeDetector API (Chrome on Android — the intended scanner is the phone).
Scan buttons hide themselves where unsupported.

## Conventions

- Design tokens only — never hard-code colors; add to both themes in
  `styles.css`. Accent is used sparingly: unwatched dots, 4K badges,
  primary buttons, focus.
- All asset/URL paths relative (`./…`) so GitHub Pages hosting of `ui/`
  works from a subpath.
- Bump the `CACHE` name in `sw.js` when shipping frontend changes, or the
  installed PWA keeps serving the old shell.
- Lowercase UI text; terse labels; no watch stats, ratings, or loans —
  watched/unwatched exists only to power the movie night picker.
