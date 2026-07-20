/** Color themes: they only change --fg/--bg/--panel/--map-tint; the rest of
 *  the theme (dim, border, glow) derives from --fg via color-mix in App.css. */
import { useEffect, useState } from "react";

/** `tint` colours the map tiles. CSS hue-rotate is a matrix approximation, not
 *  a real HSL rotation, so these can't be derived from fg by hand; theme.test.ts
 *  reproduces the chain and checks each one lands on its theme's hue. The rest
 *  of the filter chain lives in App.css. */
export const THEMES = {
  verde: { fg: "#39ff5a", bg: "#0a0f0a", panel: "#0b110b", tint: "hue-rotate(83deg) saturate(2.2)" },
  ambar: { fg: "#e8a84c", bg: "#0f0c07", panel: "#130f09", tint: "hue-rotate(-9deg) saturate(2)" },
  cian: { fg: "#5ccfe6", bg: "#070f13", panel: "#091316", tint: "hue-rotate(141deg) saturate(1.8)" },
  hueso: { fg: "#cfcfc2", bg: "#0d0d0c", panel: "#111110", tint: "saturate(0.3)" },
  violeta: { fg: "#b3a5e3", bg: "#0c0a12", panel: "#0f0c16", tint: "hue-rotate(216deg) saturate(1.5)" },
} as const;

export type Theme = keyof typeof THEMES;

const THEME_KEY = "theme";
const THEME_EVENT = "themechange";

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
  root.setProperty("--map-tint", th.tint);
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
  // CSS vars repaint on their own; canvas and SVG don't, they have to be told
  window.dispatchEvent(new Event(THEME_EVENT));
}

/** Re-renders the component when the theme changes. Needed by whatever draws
 *  with fg()/ACCENT instead of CSS vars: uPlot, Leaflet, the mesh SVG. */
export function useThemeTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const on = () => setTick((v) => v + 1);
    window.addEventListener(THEME_EVENT, on);
    return () => window.removeEventListener(THEME_EVENT, on);
  }, []);
  return tick;
}
