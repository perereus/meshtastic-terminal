// Self-check: node --experimental-strip-types src/i18n.test.ts
// Una clave sin traducir no rompe nada: t() devuelve el español. Justo por eso
// hay que buscarla a propósito, o la UI en inglés se llena de restos.
import assert from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import en from "./locales/en.ts";

// t("...") o t('...'), quedándose con el literal
const CALL = /\bt\(\s*(["'])(.*?)(?<!\\)\1/gs;

// claves que no aparecen como literal porque se construyen en tiempo de
// ejecución: pestañas (t(tab)), nombres de tema (t(THEME_LABELS[x])) y los
// textos de previsión de batería, que battery.ts devuelve como clave
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
    // i18n.ts queda fuera: su comentario de ejemplo no es una cadena real
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

// las dinámicas no salen del escaneo, así que se comprueban a mano
const faltanDin = DINAMICAS.filter((k) => !(k in en));
assert.deepEqual(faltanDin, [], `claves dinámicas sin traducir: ${faltanDin}`);

console.log(`i18n.test.ts OK · ${usadas.size} claves usadas, todas traducidas`);
