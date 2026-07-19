// Self-check: node --experimental-strip-types src/alerts.test.ts
import assert from "node:assert";
import { COOLDOWN_MS, evalAlerts, evalAutonomia } from "./alerts.ts";
import type { NodeEntry } from "./store.ts";
import type { Prevision } from "./battery.ts";

const NOW = 1_700_000_000_000;
const cfg = { on: true, battery: 20, silentH: 12, autonomiaH: 12 };
const node = (p: Partial<NodeEntry>): NodeEntry => ({
  num: 1,
  longName: "Repetidor",
  shortName: "REP",
  lastHeard: Math.floor(NOW / 1000),
  ...p,
});

// apagado = nada, aunque haya motivos de sobra
assert.equal(
  evalAlerts([node({ fav: true, batteryLevel: 5 })], { ...cfg, on: false }, new Map(), NOW)
    .length,
  0,
);

// solo favoritos: un nodo normal con la batería en las últimas no avisa
assert.equal(
  evalAlerts([node({ batteryLevel: 5 })], cfg, new Map(), NOW).length,
  0,
);

// batería por debajo del umbral
const bat = evalAlerts([node({ fav: true, batteryLevel: 12 })], cfg, new Map(), NOW);
assert.equal(bat.length, 1);
assert.ok(bat[0].key.startsWith("bat:"));

// justo en el umbral también avisa; por encima no
assert.equal(evalAlerts([node({ fav: true, batteryLevel: 20 })], cfg, new Map(), NOW).length, 1);
assert.equal(evalAlerts([node({ fav: true, batteryLevel: 21 })], cfg, new Map(), NOW).length, 0);

// >100 es alimentación externa, no batería agonizante
assert.equal(
  evalAlerts([node({ fav: true, batteryLevel: 101 })], cfg, new Map(), NOW).length,
  0,
);

// silencio: 13 h sin señal supera el umbral de 12
const mudo = evalAlerts(
  [node({ fav: true, lastHeard: Math.floor(NOW / 1000) - 13 * 3600 })],
  cfg,
  new Map(),
  NOW,
);
assert.equal(mudo.length, 1);
assert.ok(mudo[0].key.startsWith("mudo:"));

// lastHeard 0 = nunca oído, no es un silencio medible
assert.equal(
  evalAlerts([node({ fav: true, lastHeard: 0 })], cfg, new Map(), NOW).length,
  0,
);

// el nodo propio no se alerta a sí mismo
assert.equal(
  evalAlerts([node({ num: 7, fav: true, batteryLevel: 3 })], cfg, new Map(), NOW, 7).length,
  0,
);

// antirrepetición: mismo motivo no vuelve a saltar hasta pasado el cooldown
const fired = new Map<string, number>();
const n = [node({ fav: true, batteryLevel: 10 })];
assert.equal(evalAlerts(n, cfg, fired, NOW).length, 1);
assert.equal(evalAlerts(n, cfg, fired, NOW + 60_000).length, 0, "no debe repetir enseguida");
assert.equal(
  evalAlerts(n, cfg, fired, NOW + COOLDOWN_MS).length,
  1,
  "debe volver a avisar pasado el cooldown",
);

// dos motivos a la vez en el mismo nodo = dos avisos distintos
const dos = evalAlerts(
  [node({ fav: true, batteryLevel: 5, lastHeard: Math.floor(NOW / 1000) - 20 * 3600 })],
  cfg,
  new Map(),
  NOW,
);
assert.equal(dos.length, 2);

// ── evalAutonomia ────────────────────────────────────────────────────────
const fav = { num: 9, nombre: "Repetidor", fav: true };
const prev = (horasRestantes?: number, ajuste = 0.9): Prevision => ({
  pendiente: -2,
  horasRestantes,
  ajuste,
  muestras: 20,
  ultimo: 40,
});

// por debajo del umbral: avisa
const av = evalAutonomia(fav, prev(6), cfg, new Map(), NOW);
assert.ok(av);
assert.equal(av.kind, "autonomia");
assert.equal(av.value, 6);

// justo en el umbral avisa; por encima no
assert.ok(evalAutonomia(fav, prev(12), cfg, new Map(), NOW));
assert.equal(evalAutonomia(fav, prev(13), cfg, new Map(), NOW), undefined);

// previsión poco fiable: mejor callarse que dar una hora inventada
assert.equal(evalAutonomia(fav, prev(3, 0.2), cfg, new Map(), NOW), undefined);

// sin previsión (cargando o estable) no hay nada que avisar
assert.equal(evalAutonomia(fav, prev(undefined), cfg, new Map(), NOW), undefined);
assert.equal(evalAutonomia(fav, undefined, cfg, new Map(), NOW), undefined);

// solo favoritos, y solo con las alertas activas
assert.equal(
  evalAutonomia({ ...fav, fav: false }, prev(3), cfg, new Map(), NOW),
  undefined,
);
assert.equal(
  evalAutonomia(fav, prev(3), { ...cfg, on: false }, new Map(), NOW),
  undefined,
);
// 0 h = desactivado
assert.equal(
  evalAutonomia(fav, prev(3), { ...cfg, autonomiaH: 0 }, new Map(), NOW),
  undefined,
);

// antirrepetición compartida con el resto de alertas
const f2 = new Map<string, number>();
assert.ok(evalAutonomia(fav, prev(5), cfg, f2, NOW));
assert.equal(evalAutonomia(fav, prev(5), cfg, f2, NOW + 60_000), undefined);
assert.ok(evalAutonomia(fav, prev(5), cfg, f2, NOW + COOLDOWN_MS));

console.log("alerts.test.ts OK");
