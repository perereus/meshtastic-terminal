import type { NodeEntry } from "./store";

export interface MeshSummary {
  total: number;
  activos1h: number;
  activos24h: number;
  nuncaOidos: number; // lastHeard 0: they come from the NodeDB, we never heard them
  conPosicion: number;
  viaMqtt: number;
  conPki: number;
  bateriaBaja: number; // <= 20 % (>100 is external power, doesn't count)
  saltos: Map<number | "?", number>; // hopsAway → number of nodes
  mudos: NodeEntry[]; // silent favorites, the quietest first
}

/** Snapshot of the mesh from the node list. Pure: the screen only paints. */
export function summarize(
  nodes: Iterable<NodeEntry>,
  now = Date.now(),
  mudoDesdeH = 24,
): MeshSummary {
  const r: MeshSummary = {
    total: 0,
    activos1h: 0,
    activos24h: 0,
    nuncaOidos: 0,
    conPosicion: 0,
    viaMqtt: 0,
    conPki: 0,
    bateriaBaja: 0,
    saltos: new Map(),
    mudos: [],
  };
  for (const n of nodes) {
    r.total++;
    if (!n.lastHeard) r.nuncaOidos++;
    else {
      const h = (now - n.lastHeard * 1000) / 3_600_000;
      if (h < 1) r.activos1h++;
      if (h < 24) r.activos24h++;
      if (n.fav && h >= mudoDesdeH) r.mudos.push(n);
    }
    // (0,0) is junk GPS, the same criterion the map uses
    if (
      n.lat !== undefined &&
      n.lon !== undefined &&
      (Math.abs(n.lat) > 0.1 || Math.abs(n.lon) > 0.1)
    ) {
      r.conPosicion++;
    }
    if (n.viaMqtt) r.viaMqtt++;
    if (n.hasKey) r.conPki++;
    if (n.batteryLevel !== undefined && n.batteryLevel <= 20) r.bateriaBaja++;
    const k = n.hopsAway ?? "?";
    r.saltos.set(k, (r.saltos.get(k) ?? 0) + 1);
  }
  r.mudos.sort((a, b) => a.lastHeard - b.lastHeard);
  return r;
}

/** Deterministic PRNG (mulberry32): the same mesh always yields the same
 *  drawing, otherwise the graph would change on every render and be unjudgeable. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Made-up links from the real nodes, to test the graph drawing without
 *  waiting for the mesh to emit NeighborInfo. They are NOT stored in the
 *  database: they live in memory only while the preview is on. */
export function demoEdges(nodes: NodeEntry[], me?: number): Edge[] {
  const r = rng(nodes.length * 7919 + (me ?? 0));
  // by real hops when known; otherwise a stable level per node
  const tier = (n: NodeEntry) =>
    n.num === me ? 0 : (n.hopsAway ?? (n.num % 3) + 1);
  const porNivel = new Map<number, NodeEntry[]>();
  for (const n of nodes) {
    const k = Math.min(4, tier(n));
    porNivel.set(k, [...(porNivel.get(k) ?? []), n]);
  }
  const out = new Map<string, Edge>();
  const add = (a: number, b: number) => {
    if (a === b) return;
    const k = edgeKey(a, b);
    if (out.has(k)) return;
    out.set(k, { a, b, snr: Math.round((r() * 20 - 8) * 10) / 10, src: "vecinos" });
  };
  const niveles = [...porNivel.keys()].sort((a, b) => a - b);
  for (const nivel of niveles) {
    // the level above is the natural parent; level 0 (me) has none
    const padres = porNivel.get(nivel - 1) ?? porNivel.get(niveles[0]) ?? [];
    const hijos = porNivel.get(nivel) ?? [];
    for (const h of hijos) {
      if (padres.length === 0) continue;
      add(h.num, padres[Math.floor(r() * padres.length)].num);
    // some nodes hear two parents: makes a graph, not a tree
      if (r() < 0.35) add(h.num, padres[Math.floor(r() * padres.length)].num);
    }
    // lateral links within the same level
    for (let i = 0; i < hijos.length; i++) {
      if (r() < 0.2) add(hijos[i].num, hijos[Math.floor(r() * hijos.length)].num);
    }
  }
  return [...out.values()];
}

export interface Edge {
  a: number;
  b: number;
  snr?: number; // dB
  src: "vecinos" | "traceroute";
}

export const edgeKey = (a: number, b: number) =>
  a < b ? `${a}-${b}` : `${b}-${a}`;

/** Mesh links: NeighborInfo (direct) + traceroutes (route segments).
 *  When a pair shows up through both, NeighborInfo wins: it measures the real link. */
export function buildEdges(
  neighbors: { node: number; neighbor: number; snr: number }[],
  traces: { node: number; route: number[]; snr: number[] }[],
  me?: number,
): Edge[] {
  const out = new Map<string, Edge>();
  for (const tr of traces) {
    // the route doesn't include the endpoints: me → hop… → destination
    const chain = [...(me !== undefined ? [me] : []), ...tr.route, tr.node];
    for (let i = 0; i < chain.length - 1; i++) {
      const a = chain[i];
      const b = chain[i + 1];
      if (a === b) continue;
      const k = edgeKey(a, b);
      if (out.has(k)) continue;
      const snr = tr.snr[i];
      out.set(k, {
        a,
        b,
        snr: snr !== undefined ? snr / 4 : undefined, // the firmware sends dB×4
        src: "traceroute",
      });
    }
  }
  for (const n of neighbors) {
    if (n.node === n.neighbor) continue;
    out.set(edgeKey(n.node, n.neighbor), {
      a: n.node,
      b: n.neighbor,
      snr: n.snr,
      src: "vecinos",
    });
  }
  return [...out.values()];
}
