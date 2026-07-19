import type { NodeEntry } from "./store";

export interface MeshSummary {
  total: number;
  activos1h: number;
  activos24h: number;
  nuncaOidos: number; // lastHeard 0: vienen de la NodeDB, no los hemos oído
  conPosicion: number;
  viaMqtt: number;
  conPki: number;
  bateriaBaja: number; // <= 20 % (>100 es alimentación externa, no cuenta)
  saltos: Map<number | "?", number>; // hopsAway → nº de nodos
  mudos: NodeEntry[]; // favoritos callados, el que más primero
}

/** Foto de la malla a partir de la lista de nodos. Pura: la pantalla solo pinta. */
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
    // (0,0) es GPS basura, el mismo criterio que usa el mapa
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

export interface Edge {
  a: number;
  b: number;
  snr?: number; // dB
  src: "vecinos" | "traceroute";
}

export const edgeKey = (a: number, b: number) =>
  a < b ? `${a}-${b}` : `${b}-${a}`;

/** Enlaces de la malla: NeighborInfo (directo) + traceroutes (tramos de ruta).
 *  Si un par aparece por ambas vías gana NeighborInfo, que mide el enlace real. */
export function buildEdges(
  neighbors: { node: number; neighbor: number; snr: number }[],
  traces: { node: number; route: number[]; snr: number[] }[],
  me?: number,
): Edge[] {
  const out = new Map<string, Edge>();
  for (const tr of traces) {
    // la ruta no incluye los extremos: yo → hop… → destino
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
        snr: snr !== undefined ? snr / 4 : undefined, // el firmware manda dB×4
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
