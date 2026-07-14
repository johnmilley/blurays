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
    lookup.js        barcode → title (upcitemdb), optional TMDB enrichment
    scan.js          camera scanning via BarcodeDetector API
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

## External services (both optional, degrade gracefully)

- **upcitemdb trial API** — keyless barcode → product title, ~100 req/day.
  Routed through Rust on desktop (CORS); direct fetch in the PWA.
- **TMDB** — title/year/poster/director/runtime. Needs an API key, pasted
  into the ⋯ menu, stored in settings (SQLite or localStorage). No key means
  no posters/candidates; manual entry still works.

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
