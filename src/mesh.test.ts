// Self-check: node --experimental-strip-types src/mesh.test.ts
import assert from "node:assert";
import { buildEdges, demoEdges, edgeKey, summarize } from "./mesh.ts";
import type { NodeEntry } from "./store.ts";

// clave sin dirección: (a,b) y (b,a) son el mismo enlace
assert.equal(edgeKey(2, 1), edgeKey(1, 2));

// traceroute yo(1) → 2 → 3: dos tramos, SNR del firmware viene en dB×4
const tr = buildEdges([], [{ node: 3, route: [2], snr: [20, 8] }], 1);
assert.equal(tr.length, 2);
assert.deepEqual(
  tr.map((e) => [e.a, e.b, e.snr]),
  [
    [1, 2, 5],
    [2, 3, 2],
  ],
);
assert.ok(tr.every((e) => e.src === "traceroute"));

// NeighborInfo pisa el mismo par visto por traceroute (mide el enlace real)
const both = buildEdges(
  [{ node: 2, neighbor: 1, snr: -3 }],
  [{ node: 3, route: [2], snr: [20, 8] }],
  1,
);
assert.equal(both.length, 2, "el par 1-2 no debe duplicarse");
const link12 = both.find((e) => edgeKey(e.a, e.b) === edgeKey(1, 2));
assert.equal(link12?.src, "vecinos");
assert.equal(link12?.snr, -3);

// un tramo sin SNR queda sin dato, no en 0 (0 dB es un valor legítimo)
const [noSnr] = buildEdges([], [{ node: 2, route: [], snr: [] }], 1);
assert.equal(noSnr.snr, undefined);

// autoenlaces descartados
assert.equal(buildEdges([{ node: 5, neighbor: 5, snr: 9 }], []).length, 0);

// ── summarize ────────────────────────────────────────────────────────────
const NOW = 1_700_000_000_000;
const hAgo = (h: number) => Math.floor((NOW - h * 3_600_000) / 1000);
const nd = (p: Partial<NodeEntry>): NodeEntry => ({
  num: 1,
  longName: "N",
  shortName: "N",
  lastHeard: hAgo(0.1),
  ...p,
});

const sum = summarize(
  [
    nd({ num: 1, lastHeard: hAgo(0.5), hopsAway: 0, lat: 39.5, lon: 2.6 }),
    nd({ num: 2, lastHeard: hAgo(5), hopsAway: 2, viaMqtt: true, hasKey: true }),
    nd({ num: 3, lastHeard: hAgo(50), hopsAway: 2, batteryLevel: 15 }),
    nd({ num: 4, lastHeard: 0 }), // en la NodeDB pero nunca oído
    nd({ num: 5, lastHeard: hAgo(2), lat: 0, lon: 0 }), // GPS basura
  ],
  NOW,
);
assert.equal(sum.total, 5);
assert.equal(sum.activos1h, 1);
assert.equal(sum.activos24h, 3, "1, 2 y 5 están dentro de 24 h");
assert.equal(sum.nuncaOidos, 1);
assert.equal(sum.conPosicion, 1, "(0,0) no cuenta como posición");
assert.equal(sum.viaMqtt, 1);
assert.equal(sum.conPki, 1);
assert.equal(sum.bateriaBaja, 1);
assert.equal(sum.saltos.get(2), 2);
assert.equal(sum.saltos.get("?"), 2, "sin hopsAway van al cubo '?'");

// batería >100 = alimentación externa, no es batería baja
assert.equal(summarize([nd({ batteryLevel: 101 })], NOW).bateriaBaja, 0);

// mudos: solo favoritos pasados de 24 h, el más callado primero
const mudos = summarize(
  [
    nd({ num: 1, fav: true, lastHeard: hAgo(30) }),
    nd({ num: 2, fav: true, lastHeard: hAgo(80) }),
    nd({ num: 3, fav: true, lastHeard: hAgo(2) }), // hablando, no es mudo
    nd({ num: 4, lastHeard: hAgo(90) }), // callado pero no favorito
  ],
  NOW,
).mudos;
assert.deepEqual(
  mudos.map((n) => n.num),
  [2, 1],
);

// ── demoEdges ────────────────────────────────────────────────────────────
const demoNodes: NodeEntry[] = Array.from({ length: 40 }, (_, i) =>
  nd({ num: 100 + i, shortName: `N${i}`, hopsAway: i % 4 }),
);
const d1 = demoEdges(demoNodes, 100);
const d2 = demoEdges(demoNodes, 100);
assert.deepEqual(d1, d2, "debe ser determinista o el grafo bailaría en cada render");
assert.ok(d1.length > 0);
const conocidos = new Set(demoNodes.map((n) => n.num));
assert.ok(
  d1.every((e) => conocidos.has(e.a) && conocidos.has(e.b)),
  "no puede inventar nodos que no existen",
);
assert.ok(d1.every((e) => e.a !== e.b), "sin autoenlaces");
assert.equal(
  new Set(d1.map((e) => edgeKey(e.a, e.b))).size,
  d1.length,
  "sin enlaces duplicados",
);
// casi todos los nodos deberían acabar conectados a algo
const tocados = new Set(d1.flatMap((e) => [e.a, e.b]));
assert.ok(tocados.size >= demoNodes.length - 1, `nodos sueltos: ${demoNodes.length - tocados.size}`);
// una malla distinta da un dibujo distinto
assert.notDeepEqual(d1, demoEdges(demoNodes.slice(0, 20), 100));

console.log("mesh.test.ts OK");
