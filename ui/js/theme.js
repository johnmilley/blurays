// Dark/light theme via a data-theme attribute on <html>. Defaults to the
// system preference; an explicit toggle wins and persists in localStorage.

const KEY = "shelf.theme";

function systemTheme() {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function apply(theme) {
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === "light" ? "#ebebe8" : "#18181a";
}

export function initTheme() {
  apply(localStorage.getItem(KEY) || systemTheme());
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (!localStorage.getItem(KEY)) apply(systemTheme());
  });
}

export function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem(KEY, next);
  apply(next);
}
