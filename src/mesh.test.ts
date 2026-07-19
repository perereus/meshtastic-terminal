// Self-check: node --experimental-strip-types src/mesh.test.ts
import assert from "node:assert";
import { buildEdges, edgeKey } from "./mesh.ts";

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

console.log("mesh.test.ts OK");
