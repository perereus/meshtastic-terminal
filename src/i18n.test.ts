// Self-check: node --experimental-strip-types src/i18n.test.ts
// An untranslated key breaks nothing: t() returns the Spanish. That's exactly
// why it has to be hunted on purpose, or the English UI fills up with leftovers.
import assert from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import en from "./locales/en.ts";

// t("...") or t('...'), keeping the literal
const CALL = /\bt\(\s*(["'])(.*?)(?<!\\)\1/gs;

// keys that never appear as a literal because they're built at runtime:
// tabs (t(tab)), theme names (t(THEME_LABELS[x])) and the battery forecast
// texts, which battery.ts returns as a key
const DINAMICAS = [
  "NODOS",
  "MAPA",
  "MALLA",
  "TELEMETRÍA",
  "VERDE FÓSFORO",
  "ÁMBAR",
  "CIAN",
  "HUESO",
  "VIOLETA",
  "BATERÍA IRREGULAR · sin previsión fiable",
  "CARGANDO · {0} %/h",
  "ESTABLE · sin descarga apreciable",
  "SE AGOTA EN ~{0} h",
  "SE AGOTA EN ~{0} días",
];

function fuentes(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...fuentes(p));
    // i18n.ts is excluded: its example comment is not a real string
    else if (/\.tsx?$/.test(e.name) && !/\.test\.ts$/.test(e.name))
      if (!p.includes("locales") && e.name !== "i18n.ts") out.push(p);
  }
  return out;
}

const usadas = new Set<string>();
for (const f of fuentes("src")) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(CALL)) usadas.add(m[2]);
}

assert.ok(usadas.size > 100, `pocas claves encontradas (${usadas.size}): ¿regex rota?`);

const faltan = [...usadas].filter((k) => !(k in en));
assert.deepEqual(faltan, [], `sin traducir en en.ts:\n  ${faltan.join("\n  ")}`);

// the dynamic ones don't show up in the scan, so they're checked by hand
const faltanDin = DINAMICAS.filter((k) => !(k in en));
assert.deepEqual(faltanDin, [], `claves dinámicas sin traducir: ${faltanDin}`);

console.log(`i18n.test.ts OK · ${usadas.size} claves usadas, todas traducidas`);
