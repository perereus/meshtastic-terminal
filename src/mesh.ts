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
