# shelf

A no-frills Blu-ray / DVD / 4K collection catalog, in the spirit of CLZ Movies
but without the clutter. The desktop app is the full catalog manager; the
phone is input (scan a barcode via Shortcuts) and a read-only browse/search
view of what's on the shelf. Sibling app to lp, pt, and ved — same design
language (iA Writer Quattro, warm orange accent, flat panels, custom
titlebar, quiet scrollbars).

## Architecture

One frontend, two very different roles, gated by `store.isTauri`:

```
ui/                  vanilla HTML/CSS/JS — no build step, no framework
  index.html         single page: toolbar, grid/list, dialogs
  styles.css         design tokens (:root[data-theme=dark|light]) + all styling
  movies.json        published snapshot of the collection (see below) —
                     committed, overwritten by the desktop's "publish"
  js/
    main.js          controller: state, wiring, rendering pipeline.
                     Desktop-only UI (add/edit, movie night, ⋯ menu) is
                     hidden via store.isTauri; the browser gets a read-only
                     grid/list + search and a non-editable detail popup.
    store.js         STORAGE ADAPTER — the key seam (see below)
    views.js         pure rendering (grid cards / list rows, both with cover art)
    lookup.js        barcode → title (upcitemdb), blu-ray.com box art search,
                     TMDB posters/details — desktop-only, used by add/edit
    theme.js         dark/light toggle, localStorage-persisted
  manifest.webmanifest, sw.js   PWA shell (app-shell cache, offline-capable;
                     movies.json itself is fetched network-first — see below)
  fonts/, icons/     vendored — everything is self-contained, relative paths

src-tauri/           Rust backend for the desktop app
  src/lib.rs         Tauri commands + setup
  src/db.rs          SQLite (rusqlite, bundled) — movies + settings tables
  src/lookup.rs      UPC lookup over ureq (bypasses webview CORS)
  src/server.rs      LAN scan server (tiny_http, port 7788) — see below
  src/publish.rs     writes ui/movies.json + git commit/push — see below
```

**Phone → desktop scanning** (the only way discs get added): the desktop
listens on port 7788, one thread per request (a slow upcitemdb lookup must
not block other scans, or a Shortcut run while one is in flight queues up
and times out). An iOS Shortcut (native barcode scanner — no Safari, no
CORS, no in-app camera decoder) GETs `/scan?token=…&code=…`. The code is
normalized first (`normalize_barcode` in server.rs, twin of JS's
`normalizeBarcode` — iOS reports the same physical barcode as 12-digit
UPC-A or 13-digit EAN-13 depending on scan conditions, so this always
resolves to the same canonical digits before it's looked up, checked, or
stored). Rust then checks the DB, else looks the title up via upcitemdb,
inserts, emits a `phone-scan` Tauri event (UI reloads, toasts, then chases
down box art/details the same as "fetch missing"), and replies in plain
text, which the Shortcut shows as a notification ("added: …" / "you already
have: …"). The token is generated once into the settings table
(`scan_token`); the ⋯ menu shows the full URL and Shortcut setup steps.
Unknown barcodes are still inserted as `unknown (<code>)` so a batch session
never drops a disc.

**Desktop → phone publishing**: since the phone is read-only, "do I already
have this" while out and about comes from `ui/movies.json`, a snapshot the
desktop writes and pushes on demand. ⋯ menu → "set repo folder" (native
folder picker, saved as the `repo_path` setting) → "publish" invokes
`publish_to_repo`, which runs `db::list`, writes `ui/movies.json` in that
folder, and shells out to `git add / commit / push` (plain `git`, no Rust
git library). The deployed PWA (GitHub Pages, see `.github/workflows/`)
fetches `./movies.json`; `sw.js` treats that one path as network-first
(falls back to its last cached copy offline) while the rest of the shell
stays cache-first.

**The seam:** `ui/js/store.js` detects `window.__TAURI__`. Under Tauri,
every data call invokes a Rust command backed by SQLite in the app data dir
(`~/.local/share/com.johnathan.shelf/shelf.db`) — this is the only runtime
that can write. In a browser, `listMovies()` fetches `./movies.json` and
every mutating call (`addMovie`, `updateMovie`, …) is simply unreachable —
gated out at the UI layer since there's no add/edit/scan affordance to
trigger them.

**Movie shape** (both runtimes): `{ id, title, year, format ("4K" | "Blu-ray"
| "DVD"), barcode, poster, director, runtime, notes, watched, added_at }`.
IDs are SQLite rowids; movies.json carries them through as opaque numbers.

**Backup** (⋯ menu, desktop-only): plain JSON export/import, separate from
publishing — import merges (existing entries, matched by barcode else
title+year, are skipped, never overwritten). This is a safety net, not how
the phone gets fed; that's `movies.json`, above.

## External services (all optional, degrade gracefully)

- **upcitemdb trial API** — keyless barcode → product title, ~100 req/day.
  Called from Rust (`server.rs` for phone scans, `lookup.rs` for manual
  desktop entry) so it never hits the webview's CORS wall.
- **blu-ray.com quicksearch** — physical box art, desktop add/edit only.
  POST to `search/quicksearch.php` (`section=bluraymovies|dvdmovies`),
  response is an autocomplete `<li>` list plus a parallel
  `var urls = new Array(…)`; covers live at
  `images.static-bluray.com/movies/covers/{id}_{medium,large,front}.jpg`.
  CORS-open (`ACAO: *`) but only reachable from the frontend that has the
  add/edit UI to use it (desktop). Unofficial — if it breaks, check the
  response shape first.
- **TMDB** — posters + details (year, director, runtime, genres, overview),
  desktop-only. Needs an API key (⋯ menu, stored in settings, never
  committed). Key is validated against `/configuration` on save.

**Movie shape** gained `genres` and `overview`; `db::migrate()` ALTERs older
SQLite databases. Barcodes are compared via `normalizeBarcode()` (JS) /
`normalize_barcode()` (Rust) — leading zeros stripped, so a scanned EAN-13
matches a typed or previously-stored UPC-A.

## Running

```sh
# desktop (needs Rust + Tauri Linux deps: webkit2gtk-4.1, etc.)
cd src-tauri && cargo tauri dev     # or: cargo run
# there is intentionally no npm/vite step; frontendDist points at ../ui

# build an installable package (Fedora: rpm; also builds deb)
cd src-tauri && cargo tauri build
# the appimage bundle target fails here (missing linuxdeploy) — ignore it,
# the rpm/deb under target/release/bundle/ are what matter
sudo dnf install -y target/release/bundle/rpm/shelf-0.1.0-1.x86_64.rpm

# PWA (read-only phone view) — any static file server over ui/, e.g.
python3 -m http.server -d ui 8080
```

The frontend is bundled into the desktop binary at build time — a `ui/`
edit needs `cargo tauri build` + reinstall to reach an already-installed
desktop app, not just a page reload.

## Conventions

- Design tokens only — never hard-code colors; add to both themes in
  `styles.css`. Accent is used sparingly: unwatched dots, 4K badges,
  primary buttons, focus.
- Cover art uses `object-fit: contain` (not `cover`) in both grid and list —
  box art/posters aren't all exactly 2:3, and cropping loses spine/edge
  detail. List view shows a small cover thumbnail per row, same as grid.
- All asset/URL paths relative (`./…`) so GitHub Pages hosting of `ui/`
  works from a subpath.
- Bump the `CACHE` name in `sw.js` when shipping frontend changes, or the
  installed PWA keeps serving the old shell. `movies.json` itself bypasses
  this (network-first, see above) so publishing doesn't need a cache bump.
- Lowercase UI text; terse labels; no watch stats or loans — watched/
  unwatched exists only to power the movie night picker (desktop-only) and
  is shown read-only on the phone.
- No in-app camera barcode scanning (removed — iOS Safari never had a
  reliable path here). All barcode input goes through the phone-scan
  Shortcut → LAN server flow described above.
