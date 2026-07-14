# shelf

Do I already own this movie? A fast, quiet catalog for a physical
Blu-ray / DVD / 4K collection.

- **desktop** — Tauri + Rust + SQLite, no build step, vanilla frontend
- **pwa** — the same UI served statically; install it on your phone,
  scan a barcode in the store, get a yes/no
- **add movies** by barcode (keyless UPC lookup, optional TMDB posters)
  or by hand
- **grid (art) and list views**, search, format/watched filters, notes
- **movie night** — picks a random unwatched movie with a little drama
- **sync** by exporting/importing JSON between devices

## desktop

Needs Rust and the [Tauri Linux prerequisites](https://tauri.app/start/prerequisites/).

```sh
cd src-tauri
cargo tauri dev      # develop
cargo tauri build    # bundle deb/rpm/appimage
```

## phone (PWA)

Host the `ui/` directory on any static host (GitHub Pages works — all paths
are relative), open it in Chrome on Android, and "Add to Home Screen".
Camera scanning requires https.

## sync

⋯ menu → export json on one device, import json on the other. Imports merge;
nothing is overwritten.

## posters

Paste a [TMDB API key](https://www.themoviedb.org/settings/api) into the
⋯ menu to get poster art and title/year/director autofill. Without it the
app still works — cards show a typographic fallback.
