/** Color themes: they only change --fg/--bg/--panel; the rest of the theme
 *  (dim, border, glow) derives from --fg via color-mix in App.css. */

export const THEMES = {
  verde: { fg: "#39ff5a", bg: "#0a0f0a", panel: "#0b110b" },
  ambar: { fg: "#e8a84c", bg: "#0f0c07", panel: "#130f09" },
  cian: { fg: "#5ccfe6", bg: "#070f13", panel: "#091316" },
  hueso: { fg: "#cfcfc2", bg: "#0d0d0c", panel: "#111110" },
  violeta: { fg: "#b3a5e3", bg: "#0c0a12", panel: "#0f0c16" },
} as const;

export type Theme = keyof typeof THEMES;

const THEME_KEY = "theme";

export function getTheme(): Theme {
  const saved = localStorage.getItem(THEME_KEY);
  return saved && saved in THEMES ? (saved as Theme) : "verde";
}

export function applyTheme(): void {
  const th = THEMES[getTheme()];
  const root = document.documentElement.style;
  root.setProperty("--fg", th.fg);
  root.setProperty("--bg", th.bg);
  root.setProperty("--panel", th.panel);
}

/** Text color of the active theme, for canvas/SVG that can't read CSS vars
 *  (uPlot, Leaflet markers). Accepts a hex alpha suffix: fg("88"). */
export function fg(alpha = ""): string {
  return THEMES[getTheme()].fg + alpha;
}

/** Second color, legible over any of the themes. */
export const ACCENT = "#e6e6e6";

export function setTheme(name: Theme): void {
  localStorage.setItem(THEME_KEY, name);
  applyTheme(); // live, without reloading
}
