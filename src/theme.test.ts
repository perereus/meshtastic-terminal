// Self-check: node --experimental-strip-types src/theme.test.ts
// The map tiles are tinted with a CSS filter chain. hue-rotate is a matrix
// approximation, not a real HSL rotation, so the numbers in THEMES can't be
// derived from fg by hand. This reproduces the chain (filter-effects spec,
// sRGB) and checks each theme lands on the hue of its own fg.
import assert from "node:assert";
import { THEMES } from "./theme.ts";

type RGB = [number, number, number];

const mul = (m: number[], [r, g, b]: RGB): RGB => [
  m[0] * r + m[1] * g + m[2] * b,
  m[3] * r + m[4] * g + m[5] * b,
  m[6] * r + m[7] * g + m[8] * b,
];

const grayscale = (c: RGB) =>
  mul([0.2126, 0.7152, 0.0722, 0.2126, 0.7152, 0.0722, 0.2126, 0.7152, 0.0722], c);
const invert = ([r, g, b]: RGB): RGB => [1 - r, 1 - g, 1 - b];
const sepia = (c: RGB) =>
  mul([0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131], c);
const saturate = (s: number, c: RGB) =>
  mul(
    [
      0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
      0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
      0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s,
    ],
    c,
  );
const hueRotate = (deg: number, c: RGB) => {
  const a = (deg * Math.PI) / 180;
  const [cs, sn] = [Math.cos(a), Math.sin(a)];
  return mul(
    [
      0.213 + cs * 0.787 - sn * 0.213, 0.715 - cs * 0.715 - sn * 0.715, 0.072 - cs * 0.072 + sn * 0.928,
      0.213 - cs * 0.213 + sn * 0.143, 0.715 + cs * 0.285 + sn * 0.14, 0.072 - cs * 0.072 - sn * 0.283,
      0.213 - cs * 0.213 - sn * 0.787, 0.715 - cs * 0.715 + sn * 0.715, 0.072 + cs * 0.928 + sn * 0.072,
    ],
    c,
  );
};

/** Applies "hue-rotate(Xdeg) saturate(Y)" as written in THEMES. */
function tint(css: string, c: RGB): RGB {
  for (const [, fn, arg] of css.matchAll(/([\w-]+)\(([-\d.]+)/g)) {
    const v = Number(arg);
    c = fn === "hue-rotate" ? hueRotate(v, c) : saturate(v, c);
  }
  return c;
}

/** The full chain from App.css over one tile pixel. */
function tile(css: string, px: RGB): RGB {
  let c = sepia(invert(grayscale(px)));
  c = tint(css, c);
  c = c.map((v) => v * 0.5) as RGB; // brightness(0.5)
  return c.map((v) => Math.min(1, Math.max(0, v * 1.15 + (0.5 - 0.5 * 1.15)))) as RGB; // contrast(1.15)
}

function hsl([r, g, b]: RGB): { h: number; s: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  if (d < 1e-6) return { h: 0, s: 0 };
  const h =
    max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s: d / (1 - Math.abs(2 * l - 1)) };
}

const hex = (s: string): RGB =>
  [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16) / 255) as RGB;

// The chain inverts, so it's OSM's DARK pixels —roads, labels, borders— that
// come out bright and carry the tint. Pale land turns near-black: sampling it
// would only prove the background is dark.
const TRAZO: RGB = hex("#4a4a4a");
// how far the tinted map may drift from the theme's own hue
const TOL = 12;

const dist = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

for (const [name, th] of Object.entries(THEMES)) {
  const objetivo = hsl(hex(th.fg));
  const salida = hsl(tile(th.tint, TRAZO));
  if (name === "hueso") {
    // near-grey theme: the map must stay neutral, no hue to match
    assert.ok(salida.s < 0.2, `${name}: mapa demasiado saturado (${salida.s.toFixed(2)})`);
    continue;
  }
  assert.ok(
    dist(salida.h, objetivo.h) < TOL,
    `${name}: mapa a ${salida.h.toFixed(0)}° pero fg a ${objetivo.h.toFixed(0)}°`,
  );
  // a washed-out map wouldn't read as themed at all
  assert.ok(salida.s > 0.15, `${name}: mapa lavado (sat ${salida.s.toFixed(2)})`);
}

console.log(
  `theme.test.ts OK · ${Object.keys(THEMES).length} temas, tinte del mapa dentro de ±${TOL}°`,
);
