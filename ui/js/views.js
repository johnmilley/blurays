// Pure rendering: collection → DOM for the grid (art) and list views.
// Interaction is delegated back to main.js via the callbacks argument.

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** Poster <img> with a text fallback when there's no art / it fails. */
export function posterEl(movie) {
  if (movie.poster) {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = "";
    img.src = movie.poster;
    img.addEventListener("error", () => img.replaceWith(fallbackEl(movie)), { once: true });
    return img;
  }
  return fallbackEl(movie);
}

function fallbackEl(movie) {
  return el("div", "poster-fallback", movie.title);
}

function badge(format) {
  return el("span", `badge f${format}`, format);
}

export function renderGrid(container, movies, { onOpen }) {
  container.replaceChildren();
  for (const movie of movies) {
    const card = el("div", "card");
    const poster = el("div", "card-poster");
    poster.append(posterEl(movie), badge(movie.format));
    if (!movie.watched) poster.append(el("span", "unwatched-dot"));
    const title = el("div", "card-title", movie.title);
    title.title = movie.title;
    card.append(poster, title, el("div", "card-year", movie.year ?? ""));
    card.addEventListener("click", () => onOpen(movie));
    container.append(card);
  }
}

export function renderList(container, movies, { onOpen, onToggleWatched }) {
  container.replaceChildren();
  for (const movie of movies) {
    const row = el("div", "row");

    const watch = el("button", `row-watch ${movie.watched ? "watched" : "unwatched"}`);
    if (onToggleWatched) {
      watch.title = movie.watched ? "watched — click to mark unwatched" : "unwatched — click to mark watched";
      watch.addEventListener("click", (e) => {
        e.stopPropagation();
        onToggleWatched(movie);
      });
    } else {
      watch.title = movie.watched ? "watched" : "unwatched";
      watch.tabIndex = -1;
      watch.style.cursor = "default";
    }

    const thumb = el("div", "row-poster");
    thumb.append(posterEl(movie));

    row.append(
      watch,
      thumb,
      el("span", "row-title", movie.title),
      el("span", "row-year", movie.year ?? ""),
      badge(movie.format),
      el("span", "row-runtime", movie.runtime ? `${movie.runtime} min` : ""),
      el("span", "row-notes", movie.notes || ""),
    );
    row.addEventListener("click", () => onOpen(movie));
    container.append(row);
  }
}
