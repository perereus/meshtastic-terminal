import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { getSnapshot, subscribe } from "../store";
import { loadAllTraceroutes, loadNeighbors } from "../db";
import { t } from "../i18n";
import { ACCENT, fg } from "../theme";
import { buildEdges, edgeKey as key, type Edge } from "../mesh";

/** Layout dirigido por fuerzas, iteraciones fijas (sin animación).
 *  ponytail: O(n²) por iteración; con ~100 nodos sobra y evita un quadtree. */
function layout(
  ids: number[],
  edges: Edge[],
  w: number,
  h: number,
): Map<number, { x: number; y: number }> {
  const pos = new Map<number, { x: number; y: number }>();
  const idx = new Map<number, number>();
  ids.forEach((id, i) => {
    idx.set(id, i);
    // arranque en círculo: evita el colapso inicial de posiciones aleatorias
    const ang = (i / ids.length) * Math.PI * 2;
    pos.set(id, {
      x: w / 2 + (Math.cos(ang) * w) / 3,
      y: h / 2 + (Math.sin(ang) * h) / 3,
    });
  });
  const links = edges
    .map((e) => [idx.get(e.a), idx.get(e.b)] as [number?, number?])
    .filter((l): l is [number, number] => l[0] !== undefined && l[1] !== undefined);
  const arr = ids.map((id) => pos.get(id)!);
  const k = Math.sqrt((w * h) / Math.max(1, ids.length)); // distancia ideal

  for (let iter = 0; iter < 300; iter++) {
    const cool = 1 - iter / 300;
    const dx = new Float64Array(arr.length);
    const dy = new Float64Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        let vx = arr[i].x - arr[j].x;
        let vy = arr[i].y - arr[j].y;
        let d2 = vx * vx + vy * vy;
        if (d2 < 0.01) {
          vx = Math.random() - 0.5;
          vy = Math.random() - 0.5;
          d2 = 0.01;
        }
        const rep = (k * k) / d2;
        dx[i] += vx * rep;
        dy[i] += vy * rep;
        dx[j] -= vx * rep;
        dy[j] -= vy * rep;
      }
    }
    for (const [i, j] of links) {
      const vx = arr[i].x - arr[j].x;
      const vy = arr[i].y - arr[j].y;
      const d = Math.hypot(vx, vy) || 0.01;
      const att = d / k;
      dx[i] -= (vx / d) * att * k * 0.5;
      dy[i] -= (vy / d) * att * k * 0.5;
      dx[j] += (vx / d) * att * k * 0.5;
      dy[j] += (vy / d) * att * k * 0.5;
    }
    for (let i = 0; i < arr.length; i++) {
      // gravedad al centro: mantiene juntos los subgrafos sin enlaces entre sí
      dx[i] += (w / 2 - arr[i].x) * 0.01;
      dy[i] += (h / 2 - arr[i].y) * 0.01;
      const d = Math.hypot(dx[i], dy[i]) || 1;
      const step = Math.min(d, k * 0.5 * cool);
      arr[i].x = Math.max(20, Math.min(w - 20, arr[i].x + (dx[i] / d) * step));
      arr[i].y = Math.max(20, Math.min(h - 20, arr[i].y + (dy[i] / d) * step));
    }
  }
  return pos;
}

const W = 1200;
const H = 800;

export default function Mesh() {
  const s = useSyncExternalStore(subscribe, getSnapshot);
  const [neighbors, setNeighbors] = useState<
    { node: number; neighbor: number; snr: number }[]
  >([]);
  const [traces, setTraces] = useState<
    { node: number; route: number[]; snr: number[] }[]
  >([]);
  const [sel, setSel] = useState<number | undefined>();
  const [reload, setReload] = useState(0);

  useEffect(() => {
    loadNeighbors().then(setNeighbors).catch(() => {});
    loadAllTraceroutes().then(setTraces).catch(() => {});
  }, [reload]);

  const edges = useMemo(
    () => buildEdges(neighbors, traces, s.myNodeNum),
    [neighbors, traces, s.myNodeNum],
  );

  const ids = useMemo(() => {
    const set = new Set<number>();
    for (const e of edges) {
      set.add(e.a);
      set.add(e.b);
    }
    return [...set];
  }, [edges]);

  const pos = useMemo(() => layout(ids, edges, W, H), [ids, edges]);

  const short = (num: number) =>
    s.nodes.get(num)?.shortName ?? num.toString(16).slice(-4);
  const long = (num: number) =>
    s.nodes.get(num)?.longName ?? `!${num.toString(16)}`;

  // grosor/opacidad por SNR: enlace fuerte = línea marcada
  const edgeStyle = (snr?: number) => {
    if (snr === undefined) return { w: 1, o: 0.25 };
    if (snr >= 5) return { w: 2, o: 0.85 };
    if (snr >= 0) return { w: 1.5, o: 0.55 };
    return { w: 1, o: 0.35 };
  };

  const selEdges = sel !== undefined ? edges.filter((e) => e.a === sel || e.b === sel) : [];

  return (
    <main style={{ flexDirection: "column" }}>
      <div className="panel" style={{ flex: 1, minWidth: 0 }}>
        <div className="panel-title">
          <span>
            {t("PANEL // GRAFO DE MALLA")} · {t("{0} NODOS", ids.length)} ·{" "}
            {t("{0} ENLACES", edges.length)}
          </span>
          <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button
              style={{ fontSize: 10, padding: "0 6px" }}
              title={t("Releer vecinos y traceroutes de la base de datos")}
              onClick={() => setReload((v) => v + 1)}
            >
              ⟳ {t("RECARGAR")}
            </button>
            <span className="dim" style={{ fontSize: 11 }}>
              {t("{0} POR VECINOS", edges.filter((e) => e.src === "vecinos").length)}
            </span>
          </span>
        </div>

        {ids.length === 0 ? (
          <p className="dim" style={{ padding: 16, fontSize: 12 }}>
            {t(
              "SIN ENLACES — activa NEIGHBOR INFO en CONFIG o lanza traceroutes desde NODOS_",
            )}
          </p>
        ) : (
          <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
            <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
              <svg
                viewBox={`0 0 ${W} ${H}`}
                style={{ width: "100%", height: "100%" }}
              >
                {edges.map((e) => {
                  const pa = pos.get(e.a);
                  const pb = pos.get(e.b);
                  if (!pa || !pb) return null;
                  const st = edgeStyle(e.snr);
                  const dim =
                    sel !== undefined && e.a !== sel && e.b !== sel ? 0.15 : 1;
                  return (
                    <line
                      key={key(e.a, e.b)}
                      x1={pa.x}
                      y1={pa.y}
                      x2={pb.x}
                      y2={pb.y}
                      stroke={fg()}
                      strokeWidth={st.w}
                      strokeOpacity={st.o * dim}
                      strokeDasharray={e.src === "traceroute" ? "4 4" : undefined}
                    />
                  );
                })}
                {ids.map((id) => {
                  const p = pos.get(id);
                  if (!p) return null;
                  const isMe = id === s.myNodeNum;
                  const dim = sel !== undefined && id !== sel ? 0.35 : 1;
                  return (
                    <g
                      key={id}
                      opacity={dim}
                      style={{ cursor: "pointer" }}
                      onClick={() => setSel(sel === id ? undefined : id)}
                    >
                      <circle
                        cx={p.x}
                        cy={p.y}
                        r={isMe ? 9 : 6}
                        fill={isMe ? ACCENT : fg()}
                        stroke={id === sel ? ACCENT : "none"}
                        strokeWidth={2}
                      />
                      <text
                        x={p.x + 11}
                        y={p.y + 4}
                        fill={fg()}
                        fontSize={12}
                        fontFamily="JetBrains Mono, monospace"
                      >
                        {short(id)}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>

            {sel !== undefined && (
              <div
                className="panel hot"
                style={{ width: 260, flexShrink: 0, fontSize: 12 }}
              >
                <div className="panel-title">
                  <span>{short(sel)}</span>
                  <button
                    onClick={() => setSel(undefined)}
                    style={{ width: 22, height: 22, padding: 0, fontSize: 12 }}
                  >
                    ✕
                  </button>
                </div>
                <div style={{ padding: "10px 12px" }}>
                  <div style={{ fontWeight: 700 }}>{long(sel)}</div>
                  <div className="dim" style={{ fontSize: 11, marginBottom: 8 }}>
                    !{sel.toString(16)}
                    {sel === s.myNodeNum && ` · (${t("YO")})`}
                  </div>
                  <div
                    className="dim"
                    style={{ fontSize: 10, letterSpacing: 2, marginBottom: 4 }}
                  >
                    {t("ENLACES")} ({selEdges.length})
                  </div>
                  <div style={{ maxHeight: 320, overflowY: "auto" }}>
                    {selEdges
                      .slice()
                      .sort((x, y) => (y.snr ?? -99) - (x.snr ?? -99))
                      .map((e) => {
                        const other = e.a === sel ? e.b : e.a;
                        return (
                          <div
                            key={key(e.a, e.b)}
                            style={{ display: "flex", gap: 8, lineHeight: 1.7 }}
                          >
                            <span
                              style={{ flex: 1, cursor: "pointer" }}
                              onClick={() => setSel(other)}
                            >
                              {short(other)}
                            </span>
                            <span className="dim">
                              {e.snr !== undefined ? `${e.snr.toFixed(1)} dB` : "—"}
                            </span>
                          </div>
                        );
                      })}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="panel-foot">
          <span>{t("LÍNEA CONTINUA = VECINO DIRECTO")}</span>
          <span style={{ flex: 1 }} />
          <span>{t("DISCONTINUA = TRAMO DE TRACEROUTE")}</span>
        </div>
      </div>
    </main>
  );
}
